import { createHash } from "node:crypto";
import { parseIntoClientConfig } from "pg-connection-string";
import type {
  TestDatabaseClient,
  TestDatabaseClientFactory,
} from "./test-db-guard";

type Environment = Record<string, string | undefined>;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/;
const HEX = /^[0-9a-f]{64}(?![\s\S])/;
export function assertTonCoreTestEnvironment(env: Environment): void {
  if (
    env.AIAG_TON_CORE_TEST !== "1" ||
    env.RUN_TON_CORE_DB_INTEGRATION !== "1" ||
    env.RUN_NATIVE_DB_INTEGRATION !== undefined ||
    !UUID.test(env.AIAG_TON_CORE_TEST_RUN_ID ?? "") ||
    !/^[1-9][0-9]{0,19}(?![\s\S])/.test(env.AIAG_TON_CORE_TEST_DB_OID ?? "") ||
    !HEX.test(env.AIAG_TON_CORE_TEST_MARKER_SHA256 ?? "") ||
    !env.DATABASE_URL ||
    env.DATABASE_URL !== env.TEST_DATABASE_URL
  )
    throw new Error("ton_core_environment");
  let url: URL;
  try {
    url = new URL(env.TEST_DATABASE_URL!);
  } catch {
    throw new Error("ton_core_url");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "15432" ||
    url.pathname !== "/ai_aggregator_ton_core_test" ||
    url.search ||
    url.hash ||
    !/^postgres(?:ql)?:\/\/[^/?#]*@127\.0\.0\.1:15432\/ai_aggregator_ton_core_test(?![\s\S])/.test(
      env.TEST_DATABASE_URL!,
    )
  )
    throw new Error("ton_core_url");
  const parsed = parseIntoClientConfig(env.TEST_DATABASE_URL!);
  if (
    parsed.host !== "127.0.0.1" ||
    parsed.port !== 15432 ||
    parsed.database !== "ai_aggregator_ton_core_test"
  )
    throw new Error("ton_core_identity");
}
async function close(client: TestDatabaseClient) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.end(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("ton_core_close")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const factory: TestDatabaseClientFactory = async (connectionString) => {
  const { Client } = await import("pg");
  const parsed = parseIntoClientConfig(connectionString);
  const client = new Client({
    host: parsed.host,
    port: parsed.port,
    database: parsed.database,
    user: parsed.user,
    password: parsed.password,
    ssl: false,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
    query_timeout: 35000,
    options: "-c lock_timeout=5000",
    idle_in_transaction_session_timeout: 30000,
  });
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
export async function withTonCoreTestDatabase<T>(
  env: Environment,
  options: { clientFactory?: TestDatabaseClientFactory },
  run: (client: TestDatabaseClient) => Promise<T>,
): Promise<T> {
  assertTonCoreTestEnvironment(env);
  const client = await (options.clientFactory ?? factory)(
    env.TEST_DATABASE_URL!,
  );
  try {
    await client.connect();
    const identity = await client.query({
      text: `SELECT current_database() AS database_name,
      (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
      host(inet_server_addr()) AS host, inet_server_port() AS port`,
      values: [],
    });
    const row = identity.rows[0];
    if (
      identity.rows.length !== 1 ||
      row?.database_name !== "ai_aggregator_ton_core_test" ||
      row.oid !== env.AIAG_TON_CORE_TEST_DB_OID ||
      row.host !== "127.0.0.1" ||
      row.port !== 15432
    )
      throw new Error("ton_core_live_identity");
    const markers = await client.query<{ marker: string }>({
      text: "SELECT marker FROM public._aiag_test_database_marker WHERE singleton = TRUE",
      values: [],
    });
    const marker = markers.rows[0]?.marker;
    if (
      markers.rows.length !== 1 ||
      typeof marker !== "string" ||
      !marker.startsWith(
        `ai-aggregator:ton-core:${env.AIAG_TON_CORE_TEST_RUN_ID}:`,
      ) ||
      !HEX.test(marker.slice(marker.lastIndexOf(":") + 1)) ||
      createHash("sha256").update(marker).digest("hex") !==
        env.AIAG_TON_CORE_TEST_MARKER_SHA256
    )
      throw new Error("ton_core_live_marker");
    return await run(client);
  } finally {
    await close(client);
  }
}
