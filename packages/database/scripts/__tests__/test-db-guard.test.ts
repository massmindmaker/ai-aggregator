import { describe, expect, it, vi } from "vitest";

import {
  TEST_DATABASE_MARKER,
  assertTestDatabaseEnvironment,
  withGuardedTestDatabase,
  type QueryConfig,
  type TestDatabaseClient,
} from "../test-db-guard";

const allowedUrl = "postgres://alice:secret@127.0.0.1:15432/ai_aggregator_test";

function validEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    DATABASE_URL: allowedUrl,
    TEST_DATABASE_URL: allowedUrl,
    AIAG_TEST_DATABASE: "1",
    ...overrides,
  };
}

class FakeClient implements TestDatabaseClient {
  readonly connect = vi.fn(async () => undefined);
  readonly end = vi.fn(async () => undefined);
  readonly queries: QueryConfig[] = [];
  markerTable: string | null = "_aiag_test_database_marker";
  marker = TEST_DATABASE_MARKER;
  databaseName = "ai_aggregator_test";

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    config: QueryConfig,
  ): Promise<{ rows: Row[]; rowCount: number | null }> {
    this.queries.push(config);
    if (config.text.includes("current_database()")) {
      return {
        rows: [
          {
            database_name: this.databaseName,
            server_address: "127.0.0.1",
            server_port: 15432,
          } as unknown as Row,
        ],
        rowCount: 1,
      };
    }
    if (config.text.includes("to_regclass")) {
      return {
        rows: [{ marker_table: this.markerTable } as unknown as Row],
        rowCount: 1,
      };
    }
    if (config.text.includes("SELECT marker")) {
      return { rows: [{ marker: this.marker } as unknown as Row], rowCount: 1 };
    }
    if (config.text.includes("INSERT INTO public._aiag_test_database_marker")) {
      this.markerTable = "_aiag_test_database_marker";
      this.marker = String(config.values?.[0]);
    }
    return { rows: [], rowCount: 0 };
  }
}

describe("test database identity guard", () => {
  it("accepts postgres/postgresql aliases, different credentials, harmless parameters and a decoded matching database name", () => {
    const identity = assertTestDatabaseEnvironment(
      validEnv({
        DATABASE_URL:
          "postgres://first:one@127.0.0.1:15432/ai%5Faggregator%5Ftest?application_name=unit",
        TEST_DATABASE_URL:
          "postgresql://second:two@127.0.0.1:15432/ai_aggregator_test?sslmode=disable",
      }),
    );

    expect(identity).toEqual({
      host: "127.0.0.1",
      port: 15432,
      database: "ai_aggregator_test",
    });
  });

  it.each([
    [{ DATABASE_URL: undefined }, "DATABASE_URL"],
    [{ TEST_DATABASE_URL: undefined }, "TEST_DATABASE_URL"],
    [{ AIAG_TEST_DATABASE: undefined }, "AIAG_TEST_DATABASE"],
    [{ AIAG_TEST_DATABASE: "0" }, "AIAG_TEST_DATABASE"],
    [
      { TEST_DATABASE_URL: "postgres://u:p@127.0.0.1:15432/other_test" },
      "same test database",
    ],
    [
      {
        TEST_DATABASE_URL: "postgres://u:p@localhost:15432/ai_aggregator_test",
      },
      "same test database",
    ],
    [
      { TEST_DATABASE_URL: "postgres://u:p@127.0.0.1:5432/ai_aggregator_test" },
      "same test database",
    ],
  ])("fails closed for invalid environment %o", (override, message) => {
    expect(() => assertTestDatabaseEnvironment(validEnv(override))).toThrow(
      message,
    );
  });

  it.each(["host", "hostaddr", "port", "database", "dbname"])(
    "rejects the %s query override before constructing a client",
    async (key) => {
      const factory = vi.fn(async () => new FakeClient());
      const env = validEnv({
        TEST_DATABASE_URL: `${allowedUrl}?${key}=attacker-controlled`,
        DATABASE_URL: `${allowedUrl}?${key}=attacker-controlled`,
      });

      await expect(
        withGuardedTestDatabase(
          env,
          { clientFactory: factory },
          async () => undefined,
        ),
      ).rejects.toThrow("identity override");
      expect(factory).not.toHaveBeenCalled();
    },
  );

  it("does not construct or connect a client when URL identities differ", async () => {
    const client = new FakeClient();
    const factory = vi.fn(async () => client);

    await expect(
      withGuardedTestDatabase(
        validEnv({
          TEST_DATABASE_URL: "postgres://u:p@127.0.0.1:15432/other_test",
        }),
        { clientFactory: factory },
        async () => undefined,
      ),
    ).rejects.toThrow("same test database");

    expect(factory).not.toHaveBeenCalled();
    expect(client.connect).not.toHaveBeenCalled();
  });

  it("checks the connected server identity and marker before invoking the operation", async () => {
    const client = new FakeClient();
    const operation = vi.fn(async () => "done");

    const result = await withGuardedTestDatabase(
      validEnv(),
      { clientFactory: async () => client },
      operation,
    );

    expect(result).toBe("done");
    expect(operation).toHaveBeenCalledWith(client);
    expect(client.queries.slice(0, 3).map((query) => query.text)).toEqual([
      expect.stringContaining("current_database()"),
      expect.stringContaining("to_regclass"),
      expect.stringContaining("SELECT marker"),
    ]);
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("fails without writes when the marker is absent", async () => {
    const client = new FakeClient();
    client.markerTable = null;
    const operation = vi.fn(async () => undefined);

    await expect(
      withGuardedTestDatabase(
        validEnv(),
        { clientFactory: async () => client },
        operation,
      ),
    ).rejects.toThrow("marker is absent");

    expect(operation).not.toHaveBeenCalled();
    expect(
      client.queries.every((query) => /^\s*SELECT/i.test(query.text)),
    ).toBe(true);
  });

  it("fails before the marker or operation when the server reports another database", async () => {
    const client = new FakeClient();
    client.databaseName = "unexpected_database";
    const operation = vi.fn(async () => undefined);

    await expect(
      withGuardedTestDatabase(
        validEnv(),
        { clientFactory: async () => client },
        operation,
      ),
    ).rejects.toThrow("connected PostgreSQL database");

    expect(operation).not.toHaveBeenCalled();
    expect(client.queries).toHaveLength(1);
    expect(client.queries[0].text).toContain("current_database()");
  });

  it("fails without writes when the marker value is wrong", async () => {
    const client = new FakeClient();
    client.marker = "wrong-marker";
    const operation = vi.fn(async () => undefined);

    await expect(
      withGuardedTestDatabase(
        validEnv(),
        { clientFactory: async () => client },
        operation,
      ),
    ).rejects.toThrow("marker does not match");

    expect(operation).not.toHaveBeenCalled();
    expect(
      client.queries.every((query) => /^\s*SELECT/i.test(query.text)),
    ).toBe(true);
  });

  it("explicit bootstrap creates the marker only after the connected identity check", async () => {
    const client = new FakeClient();
    client.markerTable = null;

    await withGuardedTestDatabase(
      validEnv(),
      { bootstrapMarker: true, clientFactory: async () => client },
      async () => undefined,
    );

    const texts = client.queries.map((query) => query.text);
    expect(texts[0]).toContain("current_database()");
    expect(texts[1]).toContain("to_regclass");
    expect(texts).toContain("BEGIN");
    expect(texts).toContain("COMMIT");
    const insert = client.queries.find((query) =>
      query.text.includes("INSERT INTO public._aiag_test_database_marker"),
    );
    expect(insert?.values).toEqual([TEST_DATABASE_MARKER]);
  });
});
