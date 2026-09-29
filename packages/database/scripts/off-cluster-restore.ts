import { closeOwnedPgClient } from "./owned-pg-cleanup";
/**
 * Off-cluster restore rehearsal: source and destination are two INDEPENDENT
 * PostgreSQL clusters on different 127.0.0.1 ports, not two databases on one
 * server. Disposable local recovery tooling; never an unattended production
 * backup/restore command, never reachable from application startup.
 *
 * The whole reason this module exists is that role globals are cluster-wide:
 * `pg_dump` preserves object owners and GRANT/REVOKE, but not the roles
 * themselves, so a restore into a fresh cluster fails with `role does not
 * exist` until those roles are recreated there first. The order below is the
 * order a real off-host recovery has to follow:
 *
 *   1. read the roles the source objects depend on (owners + ACL grantees)
 *   2. pg_dump from the SOURCE port, --format=custom, owners and ACLs kept
 *   3. CREATE DATABASE on the DESTINATION cluster
 *   4. recreate the required roles on the DESTINATION cluster  <-- before restore
 *   5. pg_restore --exit-on-error --single-transaction
 *   6. verify owners/ACL + the financial snapshot, and replay an old payment
 *
 * Guards, identical in spirit to `ton-worker-restore.ts`: AIAG_TEST_DATABASE=1,
 * 127.0.0.1 only, no password in any connection string, source and destination
 * ports must differ, and every failure is a `TON_RESTORE_*` code.
 */
import { Client } from "pg";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, chmod, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const ROLE = /^[a-z][a-z0-9_]{0,62}$/;
const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;

function fail(code: string): never {
  throw Error(code);
}

/** Owner + ACL surface of everything a dump can be expected to reproduce. */
const AUTHORITY_SQL = `SELECT 'schema' AS kind,n.nspname::text AS name,pg_catalog.pg_get_userbyid(n.nspowner)::text AS owner,coalesce(n.nspacl::text,'') AS acl,''::text AS detail FROM pg_catalog.pg_namespace n WHERE n.nspname IN('public','aiag_ton_worker')
  UNION ALL SELECT 'relation',n.nspname||'.'||c.relname,pg_catalog.pg_get_userbyid(c.relowner),coalesce(c.relacl::text,''),c.relkind::text FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','aiag_ton_worker') AND c.relkind IN('r','p','v','m','S')
  UNION ALL SELECT 'column',n.nspname||'.'||c.relname||'.'||a.attname,pg_catalog.pg_get_userbyid(c.relowner),a.attacl::text,'' FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','aiag_ton_worker') AND a.attacl IS NOT NULL AND a.attnum>0 AND NOT a.attisdropped
  UNION ALL SELECT 'function',n.nspname||'.'||p.proname||'('||pg_catalog.pg_get_function_identity_arguments(p.oid)||')',pg_catalog.pg_get_userbyid(p.proowner),coalesce(p.proacl::text,''),p.prosecdef::text||':'||coalesce(p.proconfig::text,'')||':'||encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','aiag_ton_worker')
  UNION ALL SELECT 'type',n.nspname||'.'||t.typname,pg_catalog.pg_get_userbyid(t.typowner),coalesce(t.typacl::text,''),t.typtype::text FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname IN('public','aiag_ton_worker')
  ORDER BY kind,name`;

/** Row counts, owners/ACLs and the money surface of one cluster. */
export async function readRestoreSnapshot(client: Client) {
  const relations = (
    await client.query(
      `SELECT n.nspname||'.'||t.relname AS name FROM pg_catalog.pg_class t JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname IN('public','aiag_ton_worker') AND t.relkind IN('r','p') ORDER BY 1`,
    )
  ).rows as { name: string }[];
  const counts: Record<string, string> = {};
  for (const { name } of relations) {
    if (!/^(public|aiag_ton_worker)\.[a-z][a-z0-9_]*$/.test(name))
      fail("TON_RESTORE_OBJECT_NAME");
    const [schema, table] = name.split(".");
    counts[name] = (
      await client.query(
        'SELECT count(*)::text AS count FROM "' + schema + '"."' + table + '"',
      )
    ).rows[0].count;
  }
  const authority = (await client.query(AUTHORITY_SQL)).rows;
  const financial = (
    await client.query(
      `SELECT jsonb_build_object('invoices',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id),'[]'::jsonb) FROM public.ton_invoices i),'receipts',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM public.gateway_transactions t WHERE t.source='ton'),'apiUsage',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM public.gateway_transactions t WHERE t.type='api_usage'),'admissions',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.billing_request_id::text,'state',a.state,'authorized',a.authorized_max_credits::text,'actual',coalesce(a.actual_cost_credits,0)::text) ORDER BY a.billing_request_id),'[]'::jsonb) FROM public.gateway_charge_admissions a),'balances',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',o.id,'payg',o.payg_credits::text,'subscription',o.subscription_credits::text,'debt',o.refund_debt_credits::text) ORDER BY o.id),'[]'::jsonb) FROM public.organizations o))::text AS json`,
    )
  ).rows[0].json as string;
  return {
    counts,
    authority,
    tablesCompared: Object.keys(counts).length,
    financialDigest: createHash("sha256").update(financial).digest("hex"),
  };
}

function equivalent(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface OffClusterRestoreOptions {
  /** `postgres://<role>@127.0.0.1:<sourcePort>/<sourceDatabase>` */
  sourceUrl: string;
  /** Superuser connection to the destination cluster's maintenance db. */
  destinationAdminUrl: string;
  sourcePort: number;
  destPort: number;
  /** Extra roles the source objects depend on, beyond owners and ACL grantees. */
  roles?: readonly string[];
  destinationDatabase?: string;
  /** Keep the restored database and the archive for the caller to use. */
  keepDestination?: boolean;
  /** Runs against the restored destination database once restore succeeded. */
  verify?: (restoredUrl: string) => Promise<void>;
}

export interface OffClusterRestoreProof {
  kind: "restored_off_cluster_and_verified";
  sourceClusterId: string;
  destinationClusterId: string;
  ownershipAndGrantsPreserved: true;
  financialSnapshotIdentical: true;
  sourceUnchanged: true;
  rolesRecreatedOnDestination: string[];
  destinationDatabase: string;
  destinationRemoved: boolean;
  archiveRemoved: boolean;
  tablesCompared: number;
  archiveBytes: number;
  archiveSha256: string;
  restoredUrl: string;
}

function target(value: unknown, port: number, database: RegExp): URL {
  try {
    if (
      process.env.AIAG_TEST_DATABASE !== "1" ||
      typeof value !== "string" ||
      value.length > 8192 ||
      value.trim() !== value
    )
      throw Error();
    const u = new URL(value);
    if (
      !["postgres:", "postgresql:"].includes(u.protocol) ||
      u.hostname !== "127.0.0.1" ||
      u.port !== String(port) ||
      !database.test(u.pathname) ||
      !u.username ||
      u.search ||
      u.hash ||
      u.password
    )
      throw Error();
    return u;
  } catch {
    fail("TON_RESTORE_LOCAL_ONLY");
  }
}

function assertPort(value: unknown, code: string): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 65535
  )
    fail(code);
  return value as number;
}

/** Grantee of one ACL item (`name=arw/grantor`), or null for PUBLIC/empty. */
function aclGrantee(item: string): string | null {
  const eq = item.indexOf("=");
  if (eq < 0) return null;
  const raw = item.slice(0, eq).trim().replace(/^"|"$/g, "");
  if (raw === "" || raw === "PUBLIC") return null;
  return raw;
}

export function rolesRequiredByAuthority(
  authority: readonly { owner: string; acl: string }[],
): string[] {
  const names = new Set<string>();
  for (const row of authority) {
    if (ROLE.test(row.owner) && !row.owner.startsWith("pg_"))
      names.add(row.owner);
    for (const item of row.acl.split(",")) {
      const grantee = aclGrantee(item);
      if (grantee !== null && ROLE.test(grantee) && !grantee.startsWith("pg_"))
        names.add(grantee);
    }
  }
  return [...names].sort();
}

interface RoleAttributes {
  name: string;
  superuser: boolean;
  inherit: boolean;
  createRole: boolean;
  createdb: boolean;
  login: boolean;
  replication: boolean;
  bypassrls: boolean;
  connlimit: number;
}

async function readRoleAttributes(
  client: Client,
  names: readonly string[],
): Promise<RoleAttributes[]> {
  if (names.length === 0) return [];
  return (
    await client.query(
      `SELECT rolname::text AS name,rolsuper AS superuser,rolinherit AS inherit,
              rolcreaterole AS "createRole",rolcreatedb AS createdb,
              rolinherit AS canlogin,rolcanlogin AS canlogin_raw,
              rolreplication AS replication,rolbypassrls AS bypassrls,
              rolconnlimit AS connlimit
         FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname`,
      [names],
    )
  ).rows.map((r) => ({
    name: String(r.name),
    superuser: r.superuser === true,
    inherit: r.inherit === true,
    createRole: r.createRole === true,
    createdb: r.createdb === true,
    login: r.canlogin_raw === true,
    replication: r.replication === true,
    bypassrls: r.bypassrls === true,
    connlimit: Number(r.connlimit),
  }));
}

/**
 * Replay a settled charge on the restored cluster: the already-recorded outcome
 * must come back unchanged, with no second receipt. One request, one immutable
 * outcome — across the cutover, not just inside one cluster.
 */
export async function replayOldPaymentOnRestored(
  client: Client,
  orgId: string,
  billingRequestId: string,
): Promise<{ didTransition: boolean; state: string; receipts: number }> {
  const replay = (
    await client.query(
      "SELECT did_transition, state FROM public.aiag_settle_admitted_gateway_charge($1::uuid,$2::uuid)",
      [orgId, billingRequestId],
    )
  ).rows[0];
  if (typeof replay?.did_transition !== "boolean")
    fail("TON_RESTORE_REPLAY_UNKNOWN");
  const receipts = Number(
    (
      await client.query(
        "SELECT count(*)::int AS n FROM public.gateway_transactions WHERE org_id=$1 AND metadata->>'billing_request_id'=$2",
        [orgId, billingRequestId],
      )
    ).rows[0]?.n ?? 0,
  );
  return {
    didTransition: replay.did_transition,
    state: String(replay.state),
    receipts,
  };
}

function client(connectionString: string): Client {
  return new Client({
    connectionString,
    ssl: false,
    connectionTimeoutMillis: 5000,
    query_timeout: 30_000,
    statement_timeout: 20_000,
  });
}

export async function restoreOffCluster(
  options: OffClusterRestoreOptions,
): Promise<OffClusterRestoreProof> {
  if (typeof options !== "object" || options === null)
    fail("TON_RESTORE_OPTIONS_INVALID");
  const sourcePort = assertPort(options.sourcePort, "TON_RESTORE_PORT_INVALID");
  const destPort = assertPort(options.destPort, "TON_RESTORE_PORT_INVALID");
  if (sourcePort === destPort) fail("TON_RESTORE_SAME_CLUSTER");
  const source = target(
    options.sourceUrl,
    sourcePort,
    /^\/[a-z][a-z0-9_]{0,62}$/,
  );
  const admin = target(options.destinationAdminUrl, destPort, /^\/postgres$/);
  const extra = options.roles ?? [];
  if (
    !Array.isArray(extra) ||
    extra.length > 64 ||
    extra.some((r) => typeof r !== "string" || !ROLE.test(r))
  )
    fail("TON_RESTORE_OPTIONS_INVALID");
  const destination =
    options.destinationDatabase ??
    "aiag_offcluster_" + randomUUID().replaceAll("-", "");
  if (!/^aiag_offcluster_[a-f0-9]{32}$/.test(destination))
    fail("TON_RESTORE_OPTIONS_INVALID");
  if (options.verify !== undefined && typeof options.verify !== "function")
    fail("TON_RESTORE_OPTIONS_INVALID");
  const keep = options.keepDestination === true;

  const sourceClient = client(source.href);
  const adminClient = client(admin.href);
  let restored: Client | undefined;
  let temp: string | undefined;
  let destinationOid: string | undefined;
  let createdRoles: string[] = [];
  let creationAttempted = false;
  let cleanupFailed = false;
  let failure: Error | undefined;
  let proof: OffClusterRestoreProof | undefined;

  try {
    await sourceClient.connect();
    await adminClient.connect();
    const identity = (
      await Promise.all([
        sourceClient.query(
          `SELECT current_database() AS name,inet_server_port()::int AS port,host(inet_server_addr()) AS host,current_user::text AS user`,
        ),
        adminClient.query(
          `SELECT current_database() AS name,inet_server_port()::int AS port,host(inet_server_addr()) AS host,current_user::text AS user,(SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user) AS admin`,
        ),
      ])
    ).map((r) => r.rows[0]);
    if (
      identity[0].name !== source.pathname.slice(1) ||
      identity[0].port !== sourcePort ||
      identity[0].host !== "127.0.0.1" ||
      identity[1].port !== destPort ||
      identity[1].host !== "127.0.0.1" ||
      identity[1].name !== "postgres" ||
      identity[1].admin !== true
    )
      fail("TON_RESTORE_LOCAL_ONLY");
    // Different ports are not enough: prove the two servers are two clusters.
    const clusters = await Promise.all(
      [sourceClient, adminClient].map((c) =>
        c.query(
          "SELECT system_identifier::text AS id FROM pg_catalog.pg_control_system()",
        ),
      ),
    );
    const sourceClusterId = clusters[0].rows[0]?.id;
    const destinationClusterId = clusters[1].rows[0]?.id;
    if (
      typeof sourceClusterId !== "string" ||
      typeof destinationClusterId !== "string" ||
      sourceClusterId === destinationClusterId
    )
      fail("TON_RESTORE_SAME_CLUSTER");

    const before = await readRestoreSnapshot(sourceClient);
    if (before.tablesCompared < 100) fail("TON_RESTORE_SNAPSHOT_EMPTY");

    temp = await mkdtemp(join(tmpdir(), "aiag-off-cluster-"));
    await chmod(temp, 0o700);
    const archive = join(temp, "source.dump");
    const tools = resolve(repository, ".superpowers/tools/native18/root");
    const bin = join(tools, "usr/lib/postgresql/18/bin");
    const baseEnv = {
      PATH: process.env.PATH,
      LANG: "C.UTF-8",
      LD_LIBRARY_PATH: join(tools, "usr/lib/x86_64-linux-gnu"),
      PGHOST: "127.0.0.1",
      PGUSER: decodeURIComponent(source.username),
      PGPASSFILE: "/dev/null",
      PGCONNECT_TIMEOUT: "5",
    };

    // (2) dump from the SOURCE port. Owners and GRANT/REVOKE are deliberately
    // kept: the roles they name are restored by hand in step (4).
    await exec(
      join(bin, "pg_dump"),
      [
        "--format=custom",
        "--no-password",
        "--file",
        archive,
        "--dbname",
        source.pathname.slice(1),
      ],
      {
        env: { ...baseEnv, PGPORT: String(sourcePort) },
        timeout: 180_000,
        maxBuffer: 1048576,
      },
    );
    await chmod(archive, 0o600);
    const archiveBytes = (await stat(archive)).size;
    if (archiveBytes <= 0 || archiveBytes > MAX_ARCHIVE_BYTES)
      fail("TON_RESTORE_ARCHIVE_LIMIT");
    const archiveSha256 = createHash("sha256")
      .update(await readFile(archive))
      .digest("hex");

    // (3) the destination database, on the destination cluster.
    if (
      (
        await adminClient.query(
          "SELECT oid FROM pg_catalog.pg_database WHERE datname=$1",
          [destination],
        )
      ).rows.length
    )
      fail("TON_RESTORE_DESTINATION_EXISTS");
    creationAttempted = true;
    try {
      await adminClient.query(
        'CREATE DATABASE "' + destination + '" TEMPLATE template0',
      );
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "42P04"
      )
        creationAttempted = false;
      throw error;
    }
    destinationOid = (
      await adminClient.query(
        "SELECT oid::text AS oid FROM pg_catalog.pg_database WHERE datname=$1",
        [destination],
      )
    ).rows[0]?.oid;
    if (!destinationOid) fail("TON_RESTORE_IDENTITY_UNCERTAIN");

    // (4) roles FIRST, on the destination cluster. Every owner and every ACL
    // grantee the dump references has to exist here or the restore dies on
    // `role does not exist` and no owner is preserved.
    const required = rolesRequiredByAuthority(before.authority).concat(
      extra.filter((r) => !r.startsWith("pg_")),
    );
    const sourceRoles = await readRoleAttributes(
      sourceClient,
      [...new Set(required)].sort(),
    );
    const present = new Set(
      (
        await adminClient.query(
          "SELECT rolname::text AS name FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])",
          [[...new Set(required)]],
        )
      ).rows.map((r) => String(r.name)),
    );
    for (const role of sourceRoles) {
      if (present.has(role.name) || role.superuser) continue;
      const attributes = [
        "LOGIN",
        role.inherit ? "INHERIT" : "NOINHERIT",
        role.createRole ? "CREATEROLE" : "NOCREATEROLE",
        role.createdb ? "CREATEDB" : "NOCREATEDB",
        role.login ? "" : "NOLOGIN",
        role.replication ? "REPLICATION" : "NOREPLICATION",
        role.bypassrls ? "BYPASSRLS" : "NOBYPASSRLS",
        role.connlimit >= 0 ? "CONNECTION LIMIT " + role.connlimit : "",
      ]
        .filter(Boolean)
        .join(" ");
      try {
        await adminClient.query(`CREATE ROLE "${role.name}" ${attributes}`);
        createdRoles.push(role.name);
      } catch (error) {
        // duplicate_object: another operator won the race and the role exists,
        // which is the precondition we needed. Anything else is a hard stop.
        if (
          !(
            error !== null &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "42710"
          )
        )
          throw error;
      }
    }
    const foundAfter = new Set(
      (
        await adminClient.query(
          "SELECT rolname::text AS name FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])",
          [[...new Set(required)]],
        )
      ).rows.map((r) => String(r.name)),
    );
    const missing = [...new Set(required)].filter((n) => !foundAfter.has(n));
    if (missing.length !== 0) fail("TON_RESTORE_ROLES_MISSING");

    // (5) the restore itself.
    const restoredUrl = `postgres://${admin.username}@127.0.0.1:${destPort}/${destination}`;
    await exec(
      join(bin, "pg_restore"),
      [
        "--exit-on-error",
        "--single-transaction",
        "--no-password",
        "--dbname",
        restoredUrl,
        archive,
      ],
      {
        env: {
          ...baseEnv,
          PGUSER: decodeURIComponent(admin.username),
          PGPORT: String(destPort),
        },
        timeout: 180_000,
        maxBuffer: 1048576,
      },
    );

    // (6) verify.
    restored = client(restoredUrl);
    await restored.connect();
    if (
      (await restored.query("SELECT current_database() AS name")).rows[0]
        ?.name !== destination
    )
      fail("TON_RESTORE_IDENTITY_UNCERTAIN");
    const after = await readRestoreSnapshot(restored);
    if (!equivalent(after.authority, before.authority))
      fail("TON_RESTORE_OWNERSHIP_MISMATCH");
    if (!equivalent(after.counts, before.counts))
      fail("TON_RESTORE_SNAPSHOT_MISMATCH");
    if (after.financialDigest !== before.financialDigest)
      fail("TON_RESTORE_FINANCIAL_MISMATCH");
    if (options.verify) await options.verify(restoredUrl);
    if (!equivalent(await readRestoreSnapshot(sourceClient), before))
      fail("TON_RESTORE_SOURCE_CHANGED");

    proof = {
      kind: "restored_off_cluster_and_verified",
      sourceClusterId,
      destinationClusterId,
      ownershipAndGrantsPreserved: true,
      financialSnapshotIdentical: true,
      sourceUnchanged: true,
      rolesRecreatedOnDestination: createdRoles,
      destinationDatabase: destination,
      destinationRemoved: !keep,
      archiveRemoved: !keep,
      tablesCompared: before.tablesCompared,
      archiveBytes,
      archiveSha256,
      restoredUrl,
    };
  } catch (error) {
    if (process.env.OFF_CLUSTER_RESTORE_DEBUG === "1")
      console.error("OFF_CLUSTER_RESTORE_DEBUG", error);
    failure =
      error instanceof Error && /^TON_RESTORE_[A-Z_]+$/.test(error.message)
        ? error
        : Error("TON_RESTORE_REHEARSAL_FAILED");
  } finally {
    if (restored && !(await closeOwnedPgClient(restored))) cleanupFailed = true;
    if (!(await closeOwnedPgClient(sourceClient))) cleanupFailed = true;
    if (!(await closeOwnedPgClient(adminClient))) cleanupFailed = true;
    if (creationAttempted && !keep) {
      const cleanup = client(admin.href);
      try {
        await cleanup.connect();
        const found = (
          await cleanup.query(
            "SELECT oid::text AS oid,pg_get_userbyid(datdba)::text AS owner FROM pg_catalog.pg_database WHERE datname=$1",
            [destination],
          )
        ).rows[0];
        if (found) {
          if (
            (destinationOid && found.oid !== destinationOid) ||
            found.owner !== decodeURIComponent(admin.username)
          )
            cleanupFailed = true;
          else
            await cleanup.query(
              'DROP DATABASE "' + destination + '" WITH (FORCE)',
            );
        } else if (destinationOid) {
          cleanupFailed = true;
        }
      } catch {
        cleanupFailed = true;
      } finally {
        if (!(await closeOwnedPgClient(cleanup))) cleanupFailed = true;
      }
    }
    // Only roles this run created are dropped, and only after the database that
    // depended on them is gone.
    if (createdRoles.length > 0 && !keep) {
      const cleanup = client(admin.href);
      try {
        await cleanup.connect();
        for (const name of createdRoles) {
          const stillUsed = (
            await cleanup.query(
              `SELECT count(*)::int AS n FROM pg_catalog.pg_roles r
                WHERE r.rolname=$1 AND (
                  EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.roleid=r.oid)
                  OR EXISTS (SELECT 1 FROM pg_catalog.pg_database d WHERE pg_catalog.pg_get_userbyid(d.datdba)=r.rolname))`,
              [name],
            )
          ).rows[0]?.n;
          if (Number(stillUsed) === 0)
            await cleanup.query('DROP ROLE IF EXISTS "' + name + '"');
        }
      } catch {
        cleanupFailed = true;
      } finally {
        if (!(await closeOwnedPgClient(cleanup))) cleanupFailed = true;
      }
    }
    if (temp) {
      try {
        await rm(temp, { recursive: true, force: true });
      } catch {
        cleanupFailed = true;
      }
    }
  }
  if (cleanupFailed) fail("TON_RESTORE_CLEANUP_UNCONFIRMED");
  if (failure) throw failure;
  if (!proof) fail("TON_RESTORE_REHEARSAL_FAILED");
  return proof;
}
