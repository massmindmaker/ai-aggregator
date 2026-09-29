/** Deliberately local-only preflight. No dotenv loading, role writes, migration or settlement. */
import { pathToFileURL } from "node:url";
import {
  assertTestDatabaseEnvironment,
  withGuardedTestDatabase,
  type TestDatabaseClientFactory,
} from "./test-db-guard";
import {
  parseTonAuditRoles,
  withTonPrivilegeSnapshot,
  type TonPrivilegeReport,
} from "./ton-privilege-preflight";

const makeAuditClient: TestDatabaseClientFactory = async (connectionString) => {
  const { Client } = await import("pg");
  const client = new Client({
    connectionString,
    ssl: false,
    application_name: "aiag-ton-privilege-audit",
    connectionTimeoutMillis: 5000,
    query_timeout: 6000,
    statement_timeout: 5000,
    idle_in_transaction_session_timeout: 10000,
  });
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
function refused(): TonPrivilegeReport {
  return {
    schemaVersion: 1,
    status: "blocked",
    runtimeSettlementAllowed: false,
    roles: null,
    database: null,
    auditRole: null,
    serverVersion: null,
    findings: [
      { code: "LOCAL_AUDIT_REFUSED_OR_UNAVAILABLE", severity: "blocker" },
    ],
  };
}
export async function runLocalTonPrivilegeAudit(
  env: Record<string, string | undefined> = process.env,
  factory: TestDatabaseClientFactory = makeAuditClient,
): Promise<{ exitCode: 1 | 2; report: TonPrivilegeReport }> {
  try {
    assertTestDatabaseEnvironment(env);
    // URL options cannot override the dedicated audit connection's timing or role identity.
    if (
      new URL(env.DATABASE_URL!).search ||
      new URL(env.TEST_DATABASE_URL!).search
    )
      throw Error("options");
    const roles = parseTonAuditRoles({
      web: env.TON_AUDIT_WEB_ROLE!,
      api: env.TON_AUDIT_API_ROLE!,
      worker: env.TON_AUDIT_WORKER_ROLE!,
    });
    const report = await withGuardedTestDatabase(
      env,
      { clientFactory: factory },
      (client) => withTonPrivilegeSnapshot(client, roles),
    );
    return { exitCode: report.status === "blocked" ? 1 : 2, report };
  } catch {
    return { exitCode: 1, report: refused() };
  }
}
if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  void runLocalTonPrivilegeAudit().then(
    ({ exitCode, report }) => {
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = exitCode;
    },
    () => {
      console.log(JSON.stringify(refused()));
      process.exitCode = 1;
    },
  );
}
