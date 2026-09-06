import { describe, expect, it, vi } from "vitest";

import {
  TEST_DATABASE_MARKER,
  type QueryConfig,
  type TestDatabaseClient,
} from "../../../../packages/database/scripts/test-db-guard";
import { loadApiRegisterTestModules } from "./api-register-test-loader";

const productionImports = vi.hoisted(() => ({
  route: 0,
  db: 0,
  schema: 0,
  database: 0,
}));

vi.mock("../app/api/auth/register/route", () => {
  productionImports.route += 1;
  return { POST: vi.fn() };
});
vi.mock("@/lib/db", () => {
  productionImports.db += 1;
  return { db: {} };
});
vi.mock("@aiag/database/schema", () => {
  productionImports.schema += 1;
  return { users: {} };
});
vi.mock("@aiag/database", () => {
  productionImports.database += 1;
  return { eq: vi.fn() };
});

const allowedUrl = "postgres://local:test@127.0.0.1:15432/ai_aggregator_test";

function environment(overrides: Record<string, string | undefined> = {}) {
  return {
    DATABASE_URL: allowedUrl,
    TEST_DATABASE_URL: allowedUrl,
    AIAG_TEST_DATABASE: "1",
    ...overrides,
  };
}

class MarkerClient implements TestDatabaseClient {
  markerTable: string | null = "_aiag_test_database_marker";
  marker = TEST_DATABASE_MARKER;

  async connect() {}
  async end() {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    config: QueryConfig,
  ): Promise<{ rows: Row[]; rowCount: number | null }> {
    if (config.text.includes("current_database()")) {
      return {
        rows: [{ database_name: "ai_aggregator_test" } as unknown as Row],
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
      return {
        rows: [{ marker: this.marker } as unknown as Row],
        rowCount: 1,
      };
    }
    throw new Error("unexpected query");
  }
}

describe("api-register production import boundary", () => {
  it("imports no production modules for a wrong database identity", async () => {
    const factory = vi.fn(async () => new MarkerClient());

    await expect(
      loadApiRegisterTestModules(
        environment({
          TEST_DATABASE_URL:
            "postgres://local:test@127.0.0.1:15432/not_ai_aggregator_test",
        }),
        factory,
      ),
    ).rejects.toThrow("same test database");

    expect(factory).not.toHaveBeenCalled();
    expect(productionImports).toEqual({
      route: 0,
      db: 0,
      schema: 0,
      database: 0,
    });
  });

  it.each([
    ["absent marker", null, TEST_DATABASE_MARKER, "marker is absent"],
    [
      "wrong marker",
      "_aiag_test_database_marker",
      "wrong-marker",
      "does not match",
    ],
  ])(
    "imports no production modules for %s",
    async (_case, markerTable, marker, error) => {
      const client = new MarkerClient();
      client.markerTable = markerTable;
      client.marker = marker;

      await expect(
        loadApiRegisterTestModules(environment(), async () => client),
      ).rejects.toThrow(error);

      expect(productionImports).toEqual({
        route: 0,
        db: 0,
        schema: 0,
        database: 0,
      });
    },
  );
});
