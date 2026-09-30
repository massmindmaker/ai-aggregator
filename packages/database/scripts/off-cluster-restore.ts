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
 * ports must differ, a SUPERUSER on both sides (the catalogs this compares are
 * filtered for ordinary roles, so an under-privileged snapshot would compare
 * equal while missing whole objects), and every failure is a `TON_RESTORE_*`
 * code.
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
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
/**
 * The source database name this module is allowed to dump. Deliberately NOT a
 * generic `/[a-z][a-z0-9_]*`: combined with an arbitrary 127.0.0.1 port and
 * AIAG_TEST_DATABASE=1, a permissive pattern turns the rehearsal into "dump
 * whatever local database the caller names" — including a developer's own
 * postgres on 5432. Only this project's test-cluster database names qualify.
 */
const SOURCE_DATABASE = /^\/(aiag_source|aiag_offcluster|aiag_author_http|aiag_restore|aiag_test)_[a-z0-9]{8,40}$/;

function fail(code: string): never {
  throw Error(code);
}

/**
 * Owner + ACL surface of everything a dump can be expected to reproduce.
 *
 * `grantees` is computed with `aclexplode` + `pg_get_userbyid` instead of by
 * splitting the ACL text: a role name is quoted in that text precisely because
 * it may contain a comma or a quote, so `split(",")` mangles those names.
 *
 * Catalog visibility is a precondition of this query being complete, and it is
 * NOT satisfied by a non-superuser application role: `pg_class`/`pg_proc` are
 * filtered to objects that role holds some privilege on (measured: 0
 * foreign-owned relations where the superuser sees them all). A snapshot taken
 * through such a role is blind by construction, and two blind snapshots compare
 * equal while both miss whole objects. `restoreOffCluster` therefore requires a
 * superuser on the SOURCE side — the same rule the single-cluster reference
 * (`ton-worker-restore.ts`) already enforces — and refuses the rehearsal with
 * `TON_RESTORE_SOURCE_NOT_SUPERUSER` instead of emitting a proof that hides
 * missing objects.
 */
const AUTHORITY_SQL = `SELECT 'schema' AS kind,n.nspname::text AS name,pg_catalog.pg_get_userbyid(n.nspowner)::text AS owner,(SELECT coalesce(array_agg(DISTINCT pg_catalog.pg_get_userbyid(g.grantee) ORDER BY pg_catalog.pg_get_userbyid(g.grantee))::text[],'{}') FROM aclexplode(n.nspacl) g WHERE g.grantee<>0) AS grantees,''::text AS detail FROM pg_catalog.pg_namespace n WHERE n.nspname IN('public','aiag_ton_worker')
  UNION ALL SELECT 'relation',n.nspname||'.'||c.relname,pg_catalog.pg_get_userbyid(c.relowner),(SELECT coalesce(array_agg(DISTINCT pg_catalog.pg_get_userbyid(g.grantee) ORDER BY pg_catalog.pg_get_userbyid(g.grantee))::text[],'{}') FROM aclexplode(c.relacl) g WHERE g.grantee<>0),c.relkind::text FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','aiag_ton_worker') AND c.relkind IN('r','p','v','m','S')
  UNION ALL SELECT 'column',n.nspname||'.'||c.relname||'.'||a.attname,pg_catalog.pg_get_userbyid(c.relowner),(SELECT coalesce(array_agg(DISTINCT pg_catalog.pg_get_userbyid(g.grantee) ORDER BY pg_catalog.pg_get_userbyid(g.grantee))::text[],'{}') FROM aclexplode(a.attacl) g WHERE g.grantee<>0),'' FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','aiag_ton_worker') AND a.attacl IS NOT NULL AND a.attnum>0 AND NOT a.attisdropped
  UNION ALL SELECT 'function',n.nspname||'.'||p.proname||'('||pg_catalog.pg_get_function_identity_arguments(p.oid)||')',pg_catalog.pg_get_userbyid(p.proowner),(SELECT coalesce(array_agg(DISTINCT pg_catalog.pg_get_userbyid(g.grantee) ORDER BY pg_catalog.pg_get_userbyid(g.grantee))::text[],'{}') FROM aclexplode(p.proacl) g WHERE g.grantee<>0),p.prosecdef::text||':'||coalesce(p.proconfig::text,'')||':'||encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','aiag_ton_worker')
  UNION ALL SELECT 'type',n.nspname||'.'||t.typname,pg_catalog.pg_get_userbyid(t.typowner),(SELECT coalesce(array_agg(DISTINCT pg_catalog.pg_get_userbyid(g.grantee) ORDER BY pg_catalog.pg_get_userbyid(g.grantee))::text[],'{}') FROM aclexplode(t.typacl) g WHERE g.grantee<>0),t.typtype::text FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname IN('public','aiag_ton_worker')
  ORDER BY kind,name`;

/**
 * Role memberships the restore does NOT reproduce. `pg_dump` never emits
 * cluster-global grants, so these rows are invisible to a dump and invisible
 * to the owner/ACL comparison above — yet they decide the EFFECTIVE rights of
 * every login after a cutover. The failure direction that matters for money is
 * "access disappears after cutover", so the module refuses the rehearsal
 * outright rather than reporting a proof that hides it.
 */
const MEMBERSHIP_SQL = `SELECT pg_catalog.pg_get_userbyid(m.roleid)::text AS granted,pg_catalog.pg_get_userbyid(m.member)::text AS member,m.admin_option::text AS admin_option
  FROM pg_catalog.pg_auth_members m
  WHERE pg_catalog.pg_get_userbyid(m.roleid) NOT LIKE 'pg\\_%' AND pg_catalog.pg_get_userbyid(m.member) NOT LIKE 'pg\\_%'
  ORDER BY granted,member`;

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
  // Typed at the driver boundary, on purpose. This used to be an untyped
  // `any[]`, which is what let `grantees: string` survive: nothing connected
  // the declared type to the value pg-types actually produces, and
  // `scripts/` is outside the tsconfig `include`, so no compiler ever saw it.
  // The assertion below is the load-bearing part — it checks the decoded shape
  // at runtime, so a driver or pg-types change that alters the column type
  // fails loudly here instead of silently emptying the grantee list.
  const authority = (await client.query(AUTHORITY_SQL)).rows as AuthorityRow[];
  for (const row of authority) {
    if (
      typeof row.owner !== "string" ||
      typeof row.name !== "string" ||
      !Array.isArray(row.grantees)
    )
      fail("TON_RESTORE_ACL_UNREADABLE");
  }
  // Memberships are part of the authority surface precisely because pg_dump
  // does NOT carry them: they are the part a restore silently drops.
  const memberships = (await client.query(MEMBERSHIP_SQL)).rows as {
    granted: string;
    member: string;
    admin_option: string;
  }[];
  const financial = (
    await client.query(
      `SELECT jsonb_build_object('invoices',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id),'[]'::jsonb) FROM public.ton_invoices i),'receipts',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM public.gateway_transactions t WHERE t.source='ton'),'apiUsage',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM public.gateway_transactions t WHERE t.type='api_usage'),'admissions',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.billing_request_id::text,'state',a.state,'authorized',a.authorized_max_credits::text,'actual',coalesce(a.actual_cost_credits,0)::text) ORDER BY a.billing_request_id),'[]'::jsonb) FROM public.gateway_charge_admissions a),'balances',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',o.id,'payg',o.payg_credits::text,'subscription',o.subscription_credits::text,'debt',o.refund_debt_credits::text) ORDER BY o.id),'[]'::jsonb) FROM public.organizations o))::text AS json`,
    )
  ).rows[0].json as string;
  return {
    counts,
    authority,
    memberships,
    tablesCompared: Object.keys(counts).length,
    financialDigest: createHash("sha256").update(financial).digest("hex"),
  };
}

/**
 * Stable text of the membership surface, for equality comparison across the
 * two clusters. `granted -> member` is the direction that grants rights, so a
 * difference here is a difference in effective privileges after cutover.
 */
function membershipKey(rows: readonly {
  granted: string;
  member: string;
  admin_option: string;
}[]): string {
  return rows
    .map((r) => `${r.granted}->${r.member}:${r.admin_option}`)
    .join("|");
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
  roleAttributesVerified: true;
  membershipsIdentical: true;
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

/** One row of AUTHORITY_SQL, as node-pg actually decodes it. */
export interface AuthorityRow {
  kind: string;
  name: string;
  owner: string;
  /**
   * A `text[]` column (OID 1009). pg-types registers 1009 as
   * `parseStringArray`, so node-pg hands this over as a REAL JS ARRAY of role
   * names, not as a string. Typing it as `string` here is what let a dead
   * branch compile: `scripts/` is outside the `include` of
   * `packages/database/tsconfig.json`, which covers only `src`, so
   * nothing type-checked this file.
   */
  grantees: string[];
  detail: string;
}

/**
 * Grantees of one authority row.
 *
 * The column is `text[]` and arrives DECODED — a `string[]` of role names,
 * produced by `aclexplode` + `pg_get_userbyid` in AUTHORITY_SQL, never by
 * splitting the ACL text on ",": a role name is quoted inside that text
 * precisely because it may contain a comma or a double quote, so splitting
 * mangles (and under-reports) it.
 *
 * The parameter is typed `string[]`, NOT `unknown`: that is what makes the
 * declared type load-bearing, so a future edit that re-types the column as a
 * `string` is a compile error instead of a silently empty grantee list. The
 * `Array.isArray` test below still runs, because the value crosses an `as`
 * cast from the untyped driver boundary and nothing but this function guards
 * it.
 *
 * Returns `undefined` — not `[]` — when the value is not in the shape we
 * expect. The distinction is the whole point: an empty list is a legitimate
 * answer for an object nobody was granted on, while an unreadable column means
 * the ACL surface was never examined. Collapsing the two into `[]` is what
 * turned this into dead code, and it under-reports the required roles: a role
 * that appears only in a GRANT goes missing, is never created on the
 * destination, and `pg_restore --exit-on-error` then dies with `role does not
 * exist` — the exact failure this module exists to prevent.
 */
function grantees(acl: string[]): string[] | undefined {
  if (!Array.isArray(acl)) return undefined;
  const names = acl.filter((v): v is string => typeof v === "string");
  // A text[] of role names is never mixed-type; anything else means the
  // driver decoded something we did not expect.
  return names.length === acl.length ? names : undefined;
}

/**
 * Every role the dump depends on: object owners plus ACL grantees.
 *
 * Refuses rather than under-reporting. A grantee-only role is invisible to
 * the owner column, so if the grantee parse fails the owner-only result would
 * look complete and be wrong.
 */
export function rolesRequiredByAuthority(
  authority: readonly AuthorityRow[],
): string[] {
  const names = new Set<string>();
  for (const row of authority) {
    if (typeof row.owner !== "string")
      fail("TON_RESTORE_ACL_UNREADABLE");
    if (ROLE.test(row.owner) && !row.owner.startsWith("pg_"))
      names.add(row.owner);
    const listed = grantees(row.grantees);
    if (listed === undefined) fail("TON_RESTORE_ACL_UNREADABLE");
    for (const grantee of listed) {
      if (ROLE.test(grantee) && !grantee.startsWith("pg_")) names.add(grantee);
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
      // No duplicated columns: `rolinherit AS canlogin` alongside
      // `rolcanlogin AS canlogin_raw` aliased the SAME boolean twice, and the
      // misleading `canlogin` alias invited reading the inherit flag as the
      // login flag. Each catalog column is selected once, under its own name.
      `SELECT rolname::text AS name,rolsuper AS superuser,rolinherit AS inherit,
              rolcreaterole AS "createRole",rolcreatedb AS createdb,
              rolcanlogin AS canlogin,
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
    login: r.canlogin === true,
    replication: r.replication === true,
    bypassrls: r.bypassrls === true,
    connlimit: Number(r.connlimit),
  }));
}

/** The eight catalog attributes, compared field by field. */
function sameAttributes(a: RoleAttributes, b: RoleAttributes): boolean {
  return (
    a.name === b.name &&
    a.superuser === b.superuser &&
    a.inherit === b.inherit &&
    a.createRole === b.createRole &&
    a.createdb === b.createdb &&
    a.login === b.login &&
    a.replication === b.replication &&
    a.bypassrls === b.bypassrls &&
    a.connlimit === b.connlimit
  );
}

/**
 * Replay a settled charge on the restored cluster: the already-recorded outcome
 * must come back unchanged, with no second receipt. One request, one immutable
 * outcome — across the cutover, not just inside one cluster.
 *
 * This calls `aiag_settle_admitted_gateway_charge`, the one function here that
 * moves money, so it carries the same guards `target()` applies to every other
 * connection: AIAG_TEST_DATABASE=1 and a loopback-only server address. The
 * `settled -> RETURN FALSE` guard inside the function body means a settled
 * admission is a no-op, but an admission in state `outcome_recorded` WILL debit
 * — so the call is gated before it reaches the function at all rather than
 * relying on the row state the caller happened to pick.
 */
export async function replayOldPaymentOnRestored(
  client: Client,
  orgId: string,
  billingRequestId: string,
): Promise<{ didTransition: boolean; state: string; receipts: number }> {
  const server = (
    await client.query(
      "SELECT host(inet_server_addr())::text AS host,inet_server_port()::int AS port,current_database()::text AS database",
    )
  ).rows[0];
  if (
    process.env.AIAG_TEST_DATABASE !== "1" ||
    typeof server?.host !== "string" ||
    server.host !== "127.0.0.1" ||
    !Number.isInteger(server?.port)
  )
    fail("TON_RESTORE_LOCAL_ONLY");
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
  const source = target(options.sourceUrl, sourcePort, SOURCE_DATABASE);
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
          `SELECT current_database() AS name,inet_server_port()::int AS port,host(inet_server_addr()) AS host,current_user::text AS user,(SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user) AS superuser`,
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
    // Catalog visibility is a PRECONDITION of the comparison below, not a
    // nicety. A non-superuser's `pg_class`/`pg_proc` are filtered to objects it
    // holds a privilege on, so a source snapshot taken through such a role
    // silently omits every foreign-owned object — and a second equally blind
    // snapshot on the destination compares EQUAL to it, yielding
    // `restored_off_cluster_and_verified` for an object set that was never
    // actually compared. The single-cluster reference
    // (`ton-worker-restore.ts:123-128`) already required rolsuper here;
    // requiring it on the source restores that guarantee.
    if (identity[0].superuser !== true)
      fail("TON_RESTORE_SOURCE_NOT_SUPERUSER");

    // Different ports are not enough: prove the two servers are two clusters.
    // `system_identifier` alone is not enough either — it is inherited by a
    // pg_basebackup/PITR stand, which is the NORMAL off-host topology, so an
    // identifier match must not be reported as "same cluster" when the two
    // servers are in fact separate lineages. The data directory and the
    // postmaster start time are compared alongside it: identical identifier
    // WITH identical lineage means one server reachable on two ports
    // (SAME_CLUSTER), while an identical identifier with a different data
    // directory is a physical clone (CLUSTER_LINEAGE_SAME) — a different
    // failure with a different fix, and the wrong code sends the operator to
    // the wrong runbook.
    const clusters = await Promise.all(
      [sourceClient, adminClient].map((c) =>
        c.query(
          `SELECT system_identifier::text AS id,current_setting('data_directory') AS data_directory,pg_postmaster_start_time()::text AS started FROM pg_catalog.pg_control_system()`,
        ),
      ),
    );
    const sourceClusterId = clusters[0].rows[0]?.id;
    const destinationClusterId = clusters[1].rows[0]?.id;
    if (
      typeof sourceClusterId !== "string" ||
      typeof destinationClusterId !== "string"
    )
      fail("TON_RESTORE_SAME_CLUSTER");
    if (sourceClusterId === destinationClusterId) {
      const sameDataDirectory =
        clusters[0].rows[0]?.data_directory ===
          clusters[1].rows[0]?.data_directory;
      const sameStartTime =
        clusters[0].rows[0]?.started === clusters[1].rows[0]?.started;
      // Same identifier, same data directory and same start time: one server
      // reachable on two ports. Same identifier but a different data directory
      // or start time: a physical clone that inherited the identifier.
      fail(
        sameDataDirectory && sameStartTime
          ? "TON_RESTORE_SAME_CLUSTER"
          : "TON_RESTORE_CLUSTER_LINEAGE_SAME",
      );
    }

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
      if (role.superuser) continue;
      if (present.has(role.name)) continue;
      // Every option below is emitted EXACTLY ONCE per mutually exclusive
      // pair. `CREATE ROLE ... LOGIN ... NOLOGIN` is not a harmless duplicate:
      // PostgreSQL rejects the whole statement with `conflicting or redundant
      // options` (verified on PG18), so a single NOLOGIN role anywhere in the
      // authority surface — such as the NOLOGIN function owner this project
      // uses — used to abort the entire rehearsal. The pairs are
      // LOGIN/NOLOGIN, INHERIT/NOINHERIT, CREATEROLE/NOCREATEROLE,
      // CREATEDB/NOCREATEDB, REPLICATION/NOREPLICATION, BYPASSRLS/NOBYPASSRLS;
      // each branch below selects one side of exactly one pair.
      const attributes = [
        role.login ? "LOGIN" : "NOLOGIN",
        role.inherit ? "INHERIT" : "NOINHERIT",
        role.createRole ? "CREATEROLE" : "NOCREATEROLE",
        role.createdb ? "CREATEDB" : "NOCREATEDB",
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

    // Attribute verification, for EVERY required role — the ones this run
    // created AND the ones that were already on the destination cluster.
    //
    // Existence alone proves nothing: `CREATE ROLE` not throwing only shows the
    // statement parsed. A role that already existed on the destination is
    // skipped by the loop above, so its attributes were never checked at all,
    // and a source superuser that exists on the destination as an ordinary role
    // passed silently. Both are privilege changes across a cutover, so the
    // destination attributes are read back and compared field by field against
    // the source snapshot; any difference is an explicit mismatch, never a
    // quiet pass.
    const destAttributes = new Map(
      (
        await readRoleAttributes(
          adminClient,
          sourceRoles.map((r) => r.name),
        )
      ).map((r) => [r.name, r]),
    );
    for (const sourceRole of sourceRoles) {
      const destRole = destAttributes.get(sourceRole.name);
      if (!destRole) fail("TON_RESTORE_ROLES_MISSING");
      // A superuser is never created here, so the destination's copy of that
      // name is not ours to compare attribute-for-attribute: if the name
      // exists but is NOT a superuser there, the source privileged login has
      // silently degraded and the proof would be false.
      if (sourceRole.superuser && !destRole.superuser)
        fail("TON_RESTORE_ROLE_ATTRIBUTES_MISMATCH");
      if (!sourceRole.superuser && !sameAttributes(sourceRole, destRole))
        fail("TON_RESTORE_ROLE_ATTRIBUTES_MISMATCH");
    }

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
    // Role memberships. `pg_dump` does not carry them (they are cluster
    // globals, not database objects), so the owner/ACL and row-count checks
    // above all pass while effective privileges are missing on the restored
    // cluster. For money the dangerous direction is not a double debit but
    // "the worker's access disappears at cutover", so this module refuses to
    // emit a proof that hides the difference instead of papering over it.
    // Membership scope: only rows that involve a role this rehearsal is
    // actually responsible for. Comparing the WHOLE cluster instead makes the
    // check fail on any destination that has a membership of its own — an
    // unrelated monitoring group, a vendor login — which on a real destination
    // is nearly always the case, so the rehearsal would refuse constantly and
    // teach operators to ignore it. Restricting to `required` keeps the
    // property finding 4 asked for: a membership that the dump cannot carry
    // and that touches a role this restore depends on is still a hard stop,
    // and the money-relevant direction ("the worker's access disappears at
    // cutover") is unaffected, because such a membership always names a role
    // the dump references.
    const relevant = new Set(required);
    if (
      membershipKey(after.memberships.filter((m) => relevant.has(m.granted) || relevant.has(m.member))) !==
      membershipKey(before.memberships.filter((m) => relevant.has(m.granted) || relevant.has(m.member)))
    )
      fail("TON_RESTORE_MEMBERSHIP_MISMATCH");
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
      roleAttributesVerified: true,
      membershipsIdentical: true,
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
