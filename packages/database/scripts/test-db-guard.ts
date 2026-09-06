import { parse as parseConnectionString } from "pg-connection-string";

export const TEST_DATABASE_MARKER = "ai-aggregator:test-database:v1";

const EXPECTED_IDENTITY = {
  host: "127.0.0.1",
  port: 15432,
  database: "ai_aggregator_test",
} as const;

const IDENTITY_OVERRIDE_KEYS = new Set([
  "host",
  "hostaddr",
  "port",
  "database",
  "dbname",
]);

export interface QueryConfig {
  text: string;
  values?: readonly unknown[];
}

export interface QueryResult<Row extends Record<string, unknown>> {
  rows: Row[];
  rowCount: number | null;
}

export interface TestDatabaseClient {
  connect(): Promise<unknown>;
  end(): Promise<unknown>;
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    config: QueryConfig,
  ): Promise<QueryResult<Row>>;
}

export interface TestDatabaseIdentity {
  host: string;
  port: number;
  database: string;
}

export type TestDatabaseClientFactory = (
  connectionString: string,
) => Promise<TestDatabaseClient>;

type TestDatabaseEnvironment = Record<string, string | undefined>;

function parseIdentity(label: string, value: string): TestDatabaseIdentity {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid PostgreSQL URL`);
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`${label} must use postgres:// or postgresql://`);
  }

  for (const key of url.searchParams.keys()) {
    if (IDENTITY_OVERRIDE_KEYS.has(key.toLowerCase())) {
      throw new Error(
        `${label} contains a forbidden identity override: ${key}`,
      );
    }
  }

  const parsed = parseConnectionString(value);
  const port =
    parsed.port === null || parsed.port === undefined
      ? 5432
      : Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${label} has an invalid PostgreSQL port`);
  }

  const host = parsed.host?.toLowerCase();
  const database = parsed.database;
  if (!host || !database) {
    throw new Error(`${label} must include a host and database name`);
  }

  return { host, port, database };
}

function sameIdentity(left: TestDatabaseIdentity, right: TestDatabaseIdentity) {
  return (
    left.host === right.host &&
    left.port === right.port &&
    left.database === right.database
  );
}

export function assertTestDatabaseEnvironment(
  env: TestDatabaseEnvironment,
): TestDatabaseIdentity {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for guarded database tests");
  }
  if (!env.TEST_DATABASE_URL) {
    throw new Error("TEST_DATABASE_URL is required for guarded database tests");
  }
  if (env.AIAG_TEST_DATABASE !== "1") {
    throw new Error(
      "AIAG_TEST_DATABASE=1 is required for guarded database tests",
    );
  }

  const databaseIdentity = parseIdentity("DATABASE_URL", env.DATABASE_URL);
  const testIdentity = parseIdentity(
    "TEST_DATABASE_URL",
    env.TEST_DATABASE_URL,
  );
  if (!sameIdentity(databaseIdentity, testIdentity)) {
    throw new Error(
      "DATABASE_URL and TEST_DATABASE_URL must identify the same test database",
    );
  }
  if (!sameIdentity(testIdentity, EXPECTED_IDENTITY)) {
    throw new Error(
      "guarded database tests only allow 127.0.0.1:15432/ai_aggregator_test",
    );
  }

  return testIdentity;
}

async function assertConnectedIdentity(client: TestDatabaseClient) {
  const result = await client.query<{ database_name: string }>({
    text: `
      SELECT current_database() AS database_name
    `,
    values: [],
  });
  if (result.rows[0]?.database_name !== EXPECTED_IDENTITY.database) {
    throw new Error(
      "connected PostgreSQL database is not the allowed local test database",
    );
  }
}

async function readMarker(client: TestDatabaseClient): Promise<string | null> {
  const table = await client.query<{ marker_table: string | null }>({
    text: "SELECT to_regclass($1)::text AS marker_table",
    values: ["public._aiag_test_database_marker"],
  });
  if (!table.rows[0]?.marker_table) return null;

  const marker = await client.query<{ marker: string }>({
    text: "SELECT marker FROM public._aiag_test_database_marker WHERE singleton = TRUE",
    values: [],
  });
  return marker.rows[0]?.marker ?? "";
}

async function bootstrapMarker(client: TestDatabaseClient) {
  await client.query({ text: "BEGIN", values: [] });
  try {
    await client.query({
      text: `
        CREATE TABLE public._aiag_test_database_marker (
          singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
          marker TEXT NOT NULL
        )
      `,
      values: [],
    });
    await client.query({
      text: `
        INSERT INTO public._aiag_test_database_marker (singleton, marker)
        VALUES (TRUE, $1)
      `,
      values: [TEST_DATABASE_MARKER],
    });
    await client.query({ text: "COMMIT", values: [] });
  } catch (error) {
    await client.query({ text: "ROLLBACK", values: [] });
    throw error;
  }
}

export async function withGuardedTestDatabase<T>(
  env: TestDatabaseEnvironment,
  options: {
    bootstrapMarker?: boolean;
    clientFactory: TestDatabaseClientFactory;
  },
  operation: (client: TestDatabaseClient) => Promise<T>,
): Promise<T> {
  assertTestDatabaseEnvironment(env);
  const client = await options.clientFactory(env.TEST_DATABASE_URL!);

  try {
    await client.connect();
    await assertConnectedIdentity(client);
    const marker = await readMarker(client);
    if (marker === null) {
      if (!options.bootstrapMarker) {
        throw new Error("test database marker is absent");
      }
      await bootstrapMarker(client);
    } else if (marker !== TEST_DATABASE_MARKER) {
      throw new Error("test database marker does not match");
    }
    return await operation(client);
  } finally {
    await client.end();
  }
}
