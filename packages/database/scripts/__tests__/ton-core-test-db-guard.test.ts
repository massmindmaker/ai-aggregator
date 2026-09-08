import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  assertTonCoreTestEnvironment,
  withTonCoreTestDatabase,
} from "../ton-core-test-db-guard";
import type { TestDatabaseClient } from "../test-db-guard";
const run = "f27c2992-347b-4f2f-811e-581ac39af548";
const marker = `ai-aggregator:ton-core:${run}:${"a".repeat(64)}`;
const env = {
  DATABASE_URL:
    "postgres://unit:unit@127.0.0.1:15432/ai_aggregator_ton_core_test",
  TEST_DATABASE_URL:
    "postgres://unit:unit@127.0.0.1:15432/ai_aggregator_ton_core_test",
  AIAG_TON_CORE_TEST: "1",
  RUN_TON_CORE_DB_INTEGRATION: "1",
  AIAG_TON_CORE_TEST_DB_OID: "12345",
  AIAG_TON_CORE_TEST_RUN_ID: run,
  AIAG_TON_CORE_TEST_MARKER_SHA256: createHash("sha256")
    .update(marker)
    .digest("hex"),
};
function fixture(fault = "") {
  const query = vi.fn(async (q: { text: string }) => ({
    rows: q.text.includes("current_database")
      ? [
          {
            database_name:
              fault === "database"
                ? "ai_aggregator_test"
                : "ai_aggregator_ton_core_test",
            oid: fault === "oid" ? "2" : "12345",
            host: fault === "host" ? "remote" : "127.0.0.1",
            port: fault === "port" ? 5432 : 15432,
          },
        ]
      : [{ marker: fault === "marker" ? "forged" : marker }],
    rowCount: 1,
  }));
  const end = vi.fn(async () => {});
  const clientFactory = vi.fn(
    async () => ({ connect: async () => {}, end, query }) as TestDatabaseClient,
  );
  return { query, end, clientFactory, callback: vi.fn(async () => true) };
}
describe("strict dedicated TON guard", () => {
  it("proves identity and marker before callback and closes", async () => {
    const f = fixture();
    expect(await withTonCoreTestDatabase(env, f, f.callback)).toBe(true);
    expect(f.query).toHaveBeenCalledTimes(2);
    expect(f.end).toHaveBeenCalledOnce();
  });
  it.each(["database", "oid", "host", "port", "marker"])(
    "rejects live %s before callback",
    async (fault) => {
      const f = fixture(fault);
      await expect(withTonCoreTestDatabase(env, f, f.callback)).rejects.toThrow(
        "ton_core_live",
      );
      expect(f.callback).not.toHaveBeenCalled();
      expect(f.end).toHaveBeenCalledOnce();
    },
  );
  it.each(["ai_aggregator_test", "ai_aggregator_clean72_test", "arbitrary"])(
    "rejects %s before factory",
    async (name) => {
      const f = fixture();
      const url = env.DATABASE_URL.replace("ai_aggregator_ton_core_test", name);
      await expect(
        withTonCoreTestDatabase(
          { ...env, DATABASE_URL: url, TEST_DATABASE_URL: url },
          f,
          f.callback,
        ),
      ).rejects.toThrow();
      expect(f.clientFactory).not.toHaveBeenCalled();
    },
  );
  it.each(["?host=remote", "?application_name=test", "#x", "\n"])(
    "rejects URL suffix %j",
    (suffix) => {
      const url = env.DATABASE_URL + suffix;
      expect(() =>
        assertTonCoreTestEnvironment({
          ...env,
          DATABASE_URL: url,
          TEST_DATABASE_URL: url,
        }),
      ).toThrow();
    },
  );
  it.each([
    "AIAG_TON_CORE_TEST",
    "RUN_TON_CORE_DB_INTEGRATION",
    "AIAG_TON_CORE_TEST_DB_OID",
    "AIAG_TON_CORE_TEST_RUN_ID",
    "AIAG_TON_CORE_TEST_MARKER_SHA256",
  ])("rejects absent %s before factory", async (key) => {
    const f = fixture();
    await expect(
      withTonCoreTestDatabase({ ...env, [key]: undefined }, f, f.callback),
    ).rejects.toThrow();
    expect(f.clientFactory).not.toHaveBeenCalled();
  });
  it("rejects inherited canonical suite flag", () =>
    expect(() =>
      assertTonCoreTestEnvironment({ ...env, RUN_NATIVE_DB_INTEGRATION: "1" }),
    ).toThrow());
});
