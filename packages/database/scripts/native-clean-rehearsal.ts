import path from "node:path";
import { parseIntoClientConfig } from "pg-connection-string";
import { fileURLToPath } from "node:url";
import {
  assertTestDatabaseEnvironment,
  withGuardedTestDatabase,
  TEST_DATABASE_MARKER,
  type TestDatabaseClient,
  type TestDatabaseClientFactory,
} from "./test-db-guard";
import {
  discoverNativeMigrations,
  prepareMigrationSql,
  runNativeMigrations,
  type NativeMigration,
} from "./native-migrate";

const TARGET = "ai_aggregator_clean72_test";
const CANONICAL = "ai_aggregator_test";
const FROZEN = {
  "migrations/0067_gateway_charge_admissions.sql":
    "c13bba2c2c6cd8443790ec7587bfd42860ac0a79de10c3edea856f978737b7e3",
  "migrations/0068_gateway_durable_spending_quotas.sql":
    "b6ddc2382f92f45c0fcc51f8c8e46027faabf76de457009cb884844ddbb612a6",
  "migrations/0069_gateway_http_storage.sql":
    "f6649670ea6aee06c0e3d79b92a0e4db355e99551815a74287a0f4bb784c22a2",
  "migrations/0070_gateway_http_terminal_recovery.sql":
    "b38ebb05871648feed2085526b89cdfced8e69328c645b4b0f6a944c664a6efa",
  "migrations/0071_gateway_http_recovery_validation.sql":
    "f2fe7fffa30cc03b79712c92b09a7c932ec7af6f84a6abfe759d201dd2eff173",
} as const;

type Counts = { total: number; applied: number; skipped: number };
export interface CleanRehearsalEvidence {
  ok: boolean;
  target: typeof TARGET;
  cleanup: "not_created" | "cleanup_unverified" | "dropped";
  canonicalUnchanged: boolean | null;
  first?: Counts;
  rerun?: Counts;
  ledgerCount?: number;
  httpObjectsVerified?: boolean;
  error?: string;
  gaps: string[];
}
type Identity = {
  database_name: string;
  oid: string;
  host: string;
  port: number;
};

// The production factory is private. No alternate hostname/database options,
// default-guard override, or general-purpose disposable database API is exposed.
const createClient: TestDatabaseClientFactory = async (connectionString) => {
  const { Client } = await import("pg");
  const parsed = parseIntoClientConfig(connectionString);
  // Keep the validated identity and credentials; never let URL query options
  // override fixed timeouts or introduce another connectionString/host override.
  const client = new Client({
    host: parsed.host,
    port: parsed.port,
    database: parsed.database,
    user: parsed.user,
    password: parsed.password,
    application_name: parsed.application_name,
    ssl: false,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    query_timeout: 35_000,
    options: "-c lock_timeout=5000",
    idle_in_transaction_session_timeout: 30_000,
  });
  // pg emits connection errors outside a pending query as well. Do not allow
  // raw driver errors/credentials to reach an unhandled EventEmitter exception.
  client.on("error", () => {});
  return {
    connect: () => client.connect(),
    end: () => client.end(),
    query: async (config) => {
      const result = await client.query(config.text, [
        ...(config.values ?? []),
      ]);
      return { rows: result.rows, rowCount: result.rowCount };
    },
  };
};

async function boundedClose(client: TestDatabaseClient): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.end(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("close_timeout")), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function identity(
  client: TestDatabaseClient,
  expected: typeof TARGET | typeof CANONICAL,
  oid?: string,
) {
  const result = await client.query<Identity>({
    text: `SELECT current_database() AS database_name,
    (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS oid,
    host(inet_server_addr()) AS host, inet_server_port() AS port`,
    values: [],
  });
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    !row ||
    row.database_name !== expected ||
    row.host !== "127.0.0.1" ||
    row.port !== 15432 ||
    !/^[1-9][0-9]*$/.test(row.oid) ||
    (oid !== undefined && row.oid !== oid)
  )
    throw new Error("identity");
  return row;
}
async function marker(client: TestDatabaseClient, expected: string) {
  const result = await client.query<{ marker: string }>({
    text: "SELECT marker FROM public._aiag_test_database_marker WHERE singleton = TRUE",
    values: [],
  });
  if (result.rows.length !== 1 || result.rows[0]?.marker !== expected)
    throw new Error("marker");
}
async function ledger(client: TestDatabaseClient) {
  const result = await client.query<{
    version: string;
    checksum: string;
    effective_checksum: string;
  }>({
    text: "SELECT version, checksum, effective_checksum FROM public.schema_migrations ORDER BY version",
    values: [],
  });
  return result.rows;
}
async function canonicalSnapshot(client: TestDatabaseClient) {
  const connected = await identity(client, CANONICAL);
  await marker(client, TEST_DATABASE_MARKER);
  return JSON.stringify({
    connected,
    ledger: await ledger(client),
    marker: TEST_DATABASE_MARKER,
  });
}
async function targetOid(client: TestDatabaseClient) {
  const result = await client.query<{ oid: string }>({
    text: "SELECT oid::text FROM pg_database WHERE datname = $1",
    values: [TARGET],
  });
  if (result.rows.length > 1) throw new Error("oid");
  const oid = result.rows[0]?.oid;
  if (oid !== undefined && !/^[1-9][0-9]*$/.test(oid)) throw new Error("oid");
  return oid;
}
async function verifyTargetOid(client: TestDatabaseClient, expected: string) {
  if ((await targetOid(client)) !== expected) throw new Error("oid_drift");
}
function assertInventory(migrations: NativeMigration[]) {
  const versions = migrations.map((m) => m.version);
  if (
    migrations.length !== 72 ||
    new Set(versions).size !== 72 ||
    versions[0] !== "drizzle/0000_moaning_the_fury.sql" ||
    versions.at(-1) !== "migrations/0072_ton_invoice_core.sql" ||
    JSON.stringify(versions) !== JSON.stringify([...versions].sort())
  )
    throw new Error("inventory");
  for (const [version, checksum] of Object.entries(FROZEN)) {
    if (migrations.find((m) => m.version === version)?.checksum !== checksum)
      throw new Error("frozen_history");
  }
}
function ton2MigrationInventory(discovered: NativeMigration[]): NativeMigration[] {
  const cutoff = discovered.findIndex(
    (migration) => migration.version === "migrations/0072_ton_invoice_core.sql",
  );
  if (cutoff !== 71) throw new Error("inventory");
  const migrations = discovered.slice(0, cutoff + 1);
  assertInventory(migrations);
  return migrations;
}

async function verifyLedger(
  client: TestDatabaseClient,
  migrations: NativeMigration[],
) {
  const expected = migrations.map((m) => ({
    version: m.version,
    checksum: m.checksum,
    effective_checksum: prepareMigrationSql(m).effectiveChecksum,
  }));
  const actual = await ledger(client);
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error("ledger");
  return actual.length;
}
async function verifyHttpObjects(client: TestDatabaseClient) {
  for (const table of [
    "public.ton_invoices",
    "public.ton_chain_events",
    "public.ton_invoice_event_decisions",
    "public.gateway_http_requests",
    "public.gateway_http_results",
    "public.gateway_http_rejections",
  ]) {
    const result = await client.query<{ object_name: string | null }>({
      text: "SELECT to_regclass($1)::text AS object_name",
      values: [table],
    });
    if (!result.rows[0]?.object_name) throw new Error("http_table");
  }
  for (const signature of [
    "public.aiag_create_ton_invoice_v1(uuid,uuid,jsonb,text)",
    "public.aiag_read_ton_invoice_v1(uuid,uuid,uuid)",
    "public.aiag_expire_ton_invoice_v1(uuid)",
    "public.aiag_settle_ton_invoice_v1(uuid,jsonb)",
    "public.aiag_claim_gateway_http_request_v1(uuid,uuid,uuid,character varying,character varying,text,text,smallint)",
    "public.aiag_record_gateway_http_outcome_v1(uuid,uuid,uuid,text,text,bigint,jsonb,character varying,jsonb,smallint)",
    "public.aiag_read_gateway_http_result_v1(uuid,uuid,character varying,character varying,text,text,smallint)",
    "public.aiag_expire_gateway_http_result_v1(uuid,uuid)",
    "public.aiag_admit_gateway_http_charge_v1(uuid,uuid,uuid,character varying,character varying,character varying,character varying,bigint,jsonb,timestamp with time zone,character varying,jsonb,text,text,smallint)",
    "public.aiag_reject_unstarted_gateway_http_request_v1(uuid,uuid,uuid,character varying,character varying,text,text,smallint)",
    "public.aiag_read_gateway_http_result_v2(uuid,uuid,character varying,character varying,text,text,smallint)",
    "public.aiag_recover_gateway_http_settlement_v1(uuid,uuid,uuid)",
  ]) {
    const result = await client.query<{ object_name: string | null }>({
      text: "SELECT to_regprocedure($1)::text AS object_name",
      values: [signature],
    });
    if (!result.rows[0]?.object_name) throw new Error("http_signature");
  }
}

export async function runCleanRehearsal(
  env: Record<string, string | undefined>,
  options: { clientFactory?: TestDatabaseClientFactory } = {},
): Promise<CleanRehearsalEvidence> {
  const evidence: CleanRehearsalEvidence = {
    ok: false,
    target: TARGET,
    cleanup: "not_created",
    canonicalUnchanged: null,
    gaps: [],
  };
  let stage = "environment";
  const fail = (code: string) => {
    evidence.error ??= `${code}_failed`;
  };
  try {
    assertTestDatabaseEnvironment(env); // Before factory construction/import of pg.
    const targetUrl = new URL(env.TEST_DATABASE_URL!);
    targetUrl.pathname = `/${TARGET}`;
    const factory = options.clientFactory ?? createClient;
    stage = "canonical_guard";
    await withGuardedTestDatabase(
      env,
      {
        clientFactory: async (url) => {
          const client = await factory(url);
          return {
            connect: () => client.connect(),
            query: (config) => client.query(config),
            end: async () => {
              try {
                await boundedClose(client);
              } catch {
                fail("canonical_close");
                evidence.gaps.push("canonical_close_unverified");
              }
            },
          };
        },
      },
      async (canonical) => {
        let before: string | undefined;
        let target: TestDatabaseClient | undefined;
        let targetClosed = false;
        // Ownership exists only in this private invocation, never from caller input.
        let createdByThisRun = false;
        let ownedOid: string | undefined;
        let ownedMarker: string | undefined;
        let markerEstablished = false;
        try {
          stage = "canonical_preflight";
          before = await canonicalSnapshot(canonical);
          stage = "inventory";
          const migrations = ton2MigrationInventory(
            await discoverNativeMigrations(),
          );
          // Prepare every migration before CREATE as well, catching adapter drift.
          migrations.forEach(prepareMigrationSql);
          stage = "create_rights";
          const rights = await canonical.query<{ can_create: boolean }>({
            text: "SELECT (rolcreatedb OR rolsuper) AS can_create FROM pg_roles WHERE rolname = current_user",
            values: [],
          });
          if (rights.rows[0]?.can_create !== true) throw new Error("rights");
          stage = "target_absence";
          if ((await targetOid(canonical)) !== undefined)
            throw new Error("existing_target");
          stage = "run_marker";
          const uuid = await canonical.query<{ run_id: string }>({
            text: "SELECT gen_random_uuid()::text AS run_id",
            values: [],
          });
          const runId = uuid.rows[0]?.run_id;
          if (
            !runId ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
              runId,
            )
          )
            throw new Error("uuid");
          ownedMarker = `ai-aggregator:clean72:${runId}`;
          stage = "create_ack";
          evidence.cleanup = "cleanup_unverified"; // Any CREATE error may hide an ACK loss.
          await canonical.query({
            text: "CREATE DATABASE ai_aggregator_clean72_test TEMPLATE template0",
            values: [],
          });
          createdByThisRun = true;
          stage = "target_oid";
          ownedOid = await targetOid(canonical);
          if (!ownedOid) throw new Error("missing_oid");
          stage = "target_connect";
          target = await factory(targetUrl.href);
          await target.connect();
          stage = "target_identity";
          await identity(target, TARGET, ownedOid);
          stage = "empty_target";
          const empty = await target.query<{ user_objects: string }>({
            text: `SELECT (
          (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') +
          (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') +
          (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
            WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') +
          (SELECT count(*) FROM pg_namespace WHERE nspname !~ '^pg_'
            AND nspname NOT IN ('public', 'information_schema'))
        )::text AS user_objects`,
            values: [],
          });
          if (empty.rows[0]?.user_objects !== "0") throw new Error("not_empty");
          stage = "marker_create";
          await target.query({
            text: `CREATE TABLE public._aiag_test_database_marker (
          singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton), marker TEXT NOT NULL)`,
            values: [],
          });
          await target.query({
            text: "INSERT INTO public._aiag_test_database_marker (singleton, marker) VALUES (TRUE, $1)",
            values: [ownedMarker],
          });
          await identity(target, TARGET, ownedOid);
          await marker(target, ownedMarker);
          markerEstablished = true;
          stage = "first_migration";
          const first = await runNativeMigrations(target, migrations);
          evidence.first = {
            total: 72,
            applied: first.applied.length,
            skipped: first.skipped.length,
          };
          if (first.applied.length !== 72 || first.skipped.length !== 0)
            throw new Error("first_counts");
          stage = "first_ledger";
          evidence.ledgerCount = await verifyLedger(target, migrations);
          stage = "http_objects";
          await verifyHttpObjects(target);
          evidence.httpObjectsVerified = true;
          stage = "rerun_migration";
          const rerun = await runNativeMigrations(target, migrations);
          evidence.rerun = {
            total: 72,
            applied: rerun.applied.length,
            skipped: rerun.skipped.length,
          };
          if (rerun.applied.length !== 0 || rerun.skipped.length !== 72)
            throw new Error("rerun_counts");
          stage = "rerun_ledger";
          await verifyLedger(target, migrations);
        } catch {
          fail(stage);
        } finally {
          if (
            createdByThisRun &&
            ownedOid &&
            ownedMarker &&
            markerEstablished &&
            target
          ) {
            let cleanupStage = "cleanup_identity";
            try {
              await identity(target, TARGET, ownedOid);
              await marker(target, ownedMarker);
              cleanupStage = "target_close";
              targetClosed = true; // One bounded close attempt only; failure prevents DROP.
              await boundedClose(target);
              cleanupStage = "cleanup_oid";
              await identity(canonical, CANONICAL);
              await verifyTargetOid(canonical, ownedOid);
              cleanupStage = "drop_ack";
              // No FORCE, retry or adoption. Foreign sessions make this fail safely.
              await canonical.query({
                text: "DROP DATABASE ai_aggregator_clean72_test",
                values: [],
              });
              evidence.cleanup = "dropped";
            } catch {
              fail(cleanupStage);
              evidence.gaps.push(`${cleanupStage}_unverified`);
            }
          }
          if (target && !targetClosed) {
            try {
              await boundedClose(target);
            } catch {
              fail("target_close");
              evidence.gaps.push("target_close_unverified");
            }
          }
          if (
            evidence.cleanup === "cleanup_unverified" &&
            evidence.gaps.length === 0
          )
            evidence.gaps.push("ownership_or_cleanup_unverified");
          if (before !== undefined) {
            try {
              evidence.canonicalUnchanged =
                (await canonicalSnapshot(canonical)) === before;
              if (!evidence.canonicalUnchanged) {
                fail("canonical_drift");
                evidence.gaps.push("canonical_metadata_changed");
              }
            } catch {
              evidence.canonicalUnchanged = false;
              fail("canonical_recheck");
              evidence.gaps.push("canonical_recheck_unverified");
            }
          }
        }
      },
    );
  } catch {
    fail(stage);
  }
  evidence.ok =
    !evidence.error &&
    evidence.cleanup === "dropped" &&
    evidence.canonicalUnchanged === true &&
    evidence.first?.applied === 72 &&
    evidence.rerun?.skipped === 72;
  return evidence;
}

// Node/Bun compatible and import-safe: unit imports cannot start a DB command.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void runCleanRehearsal(process.env)
    .then((evidence) => {
      console.log(JSON.stringify(evidence));
      process.exitCode = evidence.ok ? 0 : 1;
    })
    .catch(() => {
      console.error("clean72_runner_failed");
      process.exitCode = 1;
    });
}
