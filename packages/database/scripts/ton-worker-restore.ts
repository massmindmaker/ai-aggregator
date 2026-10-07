import { closeOwnedPgClient } from "./owned-pg-cleanup";
/** Disposable local recovery rehearsal; never an unattended production backup/restore command. */
import { Client } from "pg";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, chmod, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  parseTonBoundaryRoles,
  type TonBoundaryRoles,
} from "./ton-worker-boundary";
const exec = promisify(execFile);
const repository = fileURLToPath(new URL("../../../", import.meta.url));
function target(value: string): URL {
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
      u.port !== "15432" ||
      !/^\/aiag_author_http_[a-f0-9]{32}$/.test(u.pathname) ||
      !u.username ||
      u.search ||
      u.hash ||
      u.password
    )
      throw Error();
    return u;
  } catch {
    throw Error("TON_RESTORE_LOCAL_ONLY");
  }
}
async function state(c: Client) {
  const relations = (
    await c.query(
      `SELECT n.nspname||'.'||t.relname AS name FROM pg_catalog.pg_class t JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname IN('public','aiag_ton_worker') AND t.relkind IN('r','p') ORDER BY 1`,
    )
  ).rows as { name: string }[];
  const counts: Record<string, string> = {};
  for (const { name } of relations) {
    if (!/^(public|aiag_ton_worker)\.[a-z][a-z0-9_]*$/.test(name))
      throw Error("TON_RESTORE_OBJECT_NAME");
    const [schema, table] = name.split(".");
    counts[name] = (
      await c.query(
        'SELECT count(*)::text AS count FROM "' + schema + '"."' + table + '"',
      )
    ).rows[0].count;
  }
  const authority = (
    await c.query(`SELECT 'schema' AS kind,n.nspname::text AS name,pg_catalog.pg_get_userbyid(n.nspowner)::text AS owner,coalesce(n.nspacl::text,'') AS acl,''::text AS detail FROM pg_catalog.pg_namespace n WHERE n.nspname IN('public','aiag_ton_worker')
  UNION ALL SELECT 'relation',n.nspname||'.'||c.relname,pg_catalog.pg_get_userbyid(c.relowner),coalesce(c.relacl::text,''),c.relkind::text FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','aiag_ton_worker') AND c.relkind IN('r','p','v','m','S')
  UNION ALL SELECT 'column',n.nspname||'.'||c.relname||'.'||a.attname,pg_catalog.pg_get_userbyid(c.relowner),a.attacl::text,'' FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','aiag_ton_worker') AND a.attacl IS NOT NULL AND a.attnum>0 AND NOT a.attisdropped
  UNION ALL SELECT 'function',n.nspname||'.'||p.proname||'('||pg_catalog.pg_get_function_identity_arguments(p.oid)||')',pg_catalog.pg_get_userbyid(p.proowner),coalesce(p.proacl::text,''),p.prosecdef::text||':'||coalesce(p.proconfig::text,'')||':'||encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','aiag_ton_worker') ORDER BY kind,name`)
  ).rows;
  const financial = (
    await c.query(
      `SELECT jsonb_build_object('invoices',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id),'[]'::jsonb) FROM public.ton_invoices i),'receipts',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM public.gateway_transactions t WHERE t.source='ton'),'balances',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',o.id,'payg',o.payg_credits::text,'subscription',o.subscription_credits::text,'debt',o.refund_debt_credits::text) ORDER BY o.id),'[]'::jsonb) FROM public.organizations o))::text AS json`,
    )
  ).rows[0].json as string;
  return {
    counts,
    authority,
    financialDigest: createHash("sha256").update(financial).digest("hex"),
  };
}
function equivalent(a: unknown, b: unknown): boolean {
  const first = JSON.stringify(a);
  const second = JSON.stringify(b);
  if (first === second) return true;
  // Diagnose the first divergence instead of failing opaquely.
  try {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const x = JSON.stringify(left[key]);
      const y = JSON.stringify(right[key]);
      if (x === y) continue;
      console.error('TON_RESTORE_DIFF_KEY', key);
      const ax = left[key] as unknown[];
      const ay = right[key] as unknown[];
      if (Array.isArray(ax) && Array.isArray(ay)) {
        console.error('TON_RESTORE_DIFF_LEN', ax.length, ay.length);
        for (let i = 0; i < Math.max(ax.length, ay.length); i += 1) {
          const sx = JSON.stringify(ax[i]);
          const sy = JSON.stringify(ay[i]);
          if (sx !== sy) {
            console.error('TON_RESTORE_DIFF_AT', i, sx, '<>', sy);
            break;
          }
        }
      }
      break;
    }
  } catch {
    /* diagnosis is best-effort */
  }
  return false;
}
export async function rehearseTonWorkerRestore(
  sourceUrl: string,
  roleInput: TonBoundaryRoles,
  verify: (restoredUrl: string) => Promise<void>,
) {
  const u = target(sourceUrl),
    roles = parseTonBoundaryRoles(roleInput);
  if (typeof verify !== "function") throw Error("TON_RESTORE_LOCAL_ONLY");
  const root = new Client({
    connectionString: u.href,
    ssl: false,
    connectionTimeoutMillis: 5000,
    query_timeout: 15000,
    statement_timeout: 12000,
  });
  const destination = "aiag_restore_" + randomUUID().replaceAll("-", "");
  let creationAttempted = false;
  let destinationOid: string | undefined,
    temp: string | undefined,
    restored: Client | undefined,
    connected = false;
  let proof:
    | {
        kind: "restored_and_verified_local";
        ownershipAndGrantsPreserved: true;
        sourceUnchanged: true;
        destinationRemoved: true;
        archiveRemoved: true;
        tablesCompared: number;
        archiveBytes: number;
        archiveSha256: string;
      }
    | undefined;
  let failure: Error | undefined;
  let cleanupFailed = false;
  try {
    await root.connect();
    connected = true;
    const identity = (
      await root.query(
        `SELECT current_database() AS name,inet_server_port() AS port,host(inet_server_addr()) AS host,(SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user) AS admin`,
      )
    ).rows[0];
    if (
      identity.name !== u.pathname.slice(1) ||
      identity.port !== 15432 ||
      identity.host !== "127.0.0.1" ||
      identity.admin !== true
    )
      throw Error("TON_RESTORE_LOCAL_ONLY");
    const installed = (
      await root.query(
        `SELECT o.rolname::text AS owner,p.prosecdef AS definer FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles o ON o.oid=p.proowner WHERE p.oid=to_regprocedure('aiag_ton_worker.settle_invoice_v1(uuid,jsonb)')`,
      )
    ).rows[0];
    if (
      !installed ||
      installed.owner !== roles.owner ||
      installed.definer !== true
    )
      throw Error("TON_RESTORE_BOUNDARY_MISSING");
    const before = await state(root);
    temp = await mkdtemp(join(tmpdir(), "aiag-restore-"));
    await chmod(temp, 0o700);
    const archive = join(temp, "owned.dump");
    const tools = resolve(repository, ".superpowers/tools/native18/root"),
      bin = join(tools, "usr/lib/postgresql/18/bin");
    const env = {
      PATH: process.env.PATH,
      LANG: "C.UTF-8",
      LD_LIBRARY_PATH: join(tools, "usr/lib/x86_64-linux-gnu"),
      PGHOST: "127.0.0.1",
      PGPORT: "15432",
      PGUSER: decodeURIComponent(u.username),
      PGPASSFILE: "/dev/null",
      PGCONNECT_TIMEOUT: "5",
    };
    // Deliberately preserve object owners and GRANT/REVOKE commands. Role globals are an explicit prerequisite.
    await exec(
      join(bin, "pg_dump"),
      [
        "--format=custom",
        "--no-password",
        "--file",
        archive,
        "--dbname",
        u.pathname.slice(1),
      ],
      { env, timeout: 90000, maxBuffer: 1048576 },
    );
    await chmod(archive, 0o600);
    const archiveBytes = (await stat(archive)).size;
    if (archiveBytes <= 0 || archiveBytes > 128 * 1024 * 1024)
      throw Error("TON_RESTORE_ARCHIVE_LIMIT");
    const archiveSha256 = createHash("sha256")
      .update(await readFile(archive))
      .digest("hex");
    if (
      (
        await root.query(
          "SELECT oid FROM pg_catalog.pg_database WHERE datname=$1",
          [destination],
        )
      ).rows.length
    )
      throw Error("TON_RESTORE_DESTINATION_EXISTS");
    creationAttempted = true;
    try {
      await root.query(
        'CREATE DATABASE "' + destination + '" TEMPLATE template0',
      );
    } catch (error) {
      // duplicate_database is a definite refusal, not an unknown CREATE acknowledgement.
      // The preexisting/competing object is never ours to reconcile or delete.
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
      await root.query(
        "SELECT oid::text AS oid FROM pg_catalog.pg_database WHERE datname=$1",
        [destination],
      )
    ).rows[0]?.oid;
    if (!destinationOid) throw Error("TON_RESTORE_IDENTITY_UNCERTAIN");
    await exec(
      join(bin, "pg_restore"),
      [
        "--exit-on-error",
        "--single-transaction",
        "--no-password",
        "--dbname",
        destination,
        archive,
      ],
      { env, timeout: 90000, maxBuffer: 1048576 },
    );
    const copy = new URL(u);
    copy.pathname = "/" + destination;
    restored = new Client({
      connectionString: copy.href,
      ssl: false,
      connectionTimeoutMillis: 5000,
      statement_timeout: 12000,
      query_timeout: 15000,
    });
    await restored.connect();
    if (
      (await restored.query("SELECT current_database() AS name")).rows[0]
        ?.name !== destination
    )
      throw Error("TON_RESTORE_IDENTITY_UNCERTAIN");
    if (!equivalent(await state(restored), before))
      throw Error("TON_RESTORE_SNAPSHOT_MISMATCH");
    await verify(copy.href);
    if (!equivalent(await state(root), before))
      throw Error("TON_RESTORE_SOURCE_CHANGED");
    proof = {
      kind: "restored_and_verified_local",
      ownershipAndGrantsPreserved: true,
      sourceUnchanged: true,
      destinationRemoved: true,
      archiveRemoved: true,
      tablesCompared: Object.keys(before.counts).length,
      archiveBytes,
      archiveSha256,
    };
  } catch (error) {
    failure =
      error instanceof Error && /^TON_RESTORE_[A-Z_]+$/.test(error.message)
        ? error
        : Error("TON_RESTORE_REHEARSAL_FAILED");
  } finally {
    if (restored && !(await closeOwnedPgClient(restored))) cleanupFailed = true;
    // Close the creator first: no late CREATE can outlive destination reconciliation.
    if (!(await closeOwnedPgClient(root))) cleanupFailed = true;
    if (connected && creationAttempted) {
      const cleanup = new Client({
        connectionString: u.href,
        ssl: false,
        connectionTimeoutMillis: 5000,
        statement_timeout: 12000,
        query_timeout: 15000,
      });
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
            found.owner !== decodeURIComponent(u.username)
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
    if (temp) {
      try {
        await rm(temp, { recursive: true, force: true });
      } catch {
        cleanupFailed = true;
      }
    }
  }
  if (cleanupFailed) throw Error("TON_RESTORE_CLEANUP_UNCONFIRMED");
  if (failure) throw failure;
  if (!proof) throw Error("TON_RESTORE_REHEARSAL_FAILED");
  return proof;
}
