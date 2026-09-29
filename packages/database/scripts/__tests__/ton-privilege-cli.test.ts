import { describe, expect, it, vi } from "vitest";
import { runLocalTonPrivilegeAudit } from "../ton-privilege-preflight-cli";
import {
  TEST_DATABASE_MARKER,
  type TestDatabaseClientFactory,
} from "../test-db-guard";
const url = "postgresql://test@127.0.0.1:15432/ai_aggregator_test";
const env = {
  DATABASE_URL: url,
  TEST_DATABASE_URL: url,
  AIAG_TEST_DATABASE: "1",
  TON_AUDIT_WEB_ROLE: "app_web",
  TON_AUDIT_API_ROLE: "app_api",
  TON_AUDIT_WORKER_ROLE: "worker",
};
describe("local read-only audit command", () => {
  it.each([
    { ...env, DATABASE_URL: "postgresql://user@production.example/db" },
    { ...env, TEST_DATABASE_URL: undefined },
    { ...env, AIAG_TEST_DATABASE: "0" },
    { ...env, TON_AUDIT_WEB_ROLE: undefined },
  ])("refuses unsafe or ambiguous config before connecting", async (e) => {
    const factory = vi.fn();
    const result = await runLocalTonPrivilegeAudit(e, factory);
    expect(result.report.status).toBe("blocked");
    expect(result.exitCode).toBe(1);
    expect(factory).not.toHaveBeenCalled();
  });
  it.each([
    "?role=worker",
    "?options=-c%20role%3Dworker",
    "?statement_timeout=0",
    "?host=production.example",
  ])("rejects URL overrides before connection: %s", async (suffix) => {
    const factory = vi.fn();
    const result = await runLocalTonPrivilegeAudit(
      { ...env, DATABASE_URL: url + suffix, TEST_DATABASE_URL: url + suffix },
      factory,
    );
    expect(result.exitCode).toBe(1);
    expect(factory).not.toHaveBeenCalled();
  });
  it("never creates a missing local marker", async () => {
    const end = vi.fn();
    const query = vi.fn(async ({ text }: { text: string }) => ({
      rows: text.includes("database_name")
        ? [{ database_name: "ai_aggregator_test" }]
        : [{ marker_table: null }],
      rowCount: 1,
    }));
    const factory = vi.fn(async () => ({
      connect: async () => {},
      end,
      query,
    }));
    const result = await runLocalTonPrivilegeAudit(
      env,
      factory as TestDatabaseClientFactory,
    );
    expect(result.exitCode).toBe(1);
    expect(end).toHaveBeenCalledTimes(1);
    expect(
      query.mock.calls.some(([q]) =>
        /CREATE|INSERT|UPDATE|GRANT|REVOKE/.test(q.text),
      ),
    ).toBe(false);
  });
  it("rolls back its snapshot and closes the connection after supported catalog rejection", async () => {
    const end = vi.fn();
    const query = vi.fn(async ({ text }: { text: string }) => ({
      rows: text.includes("database_name")
        ? [{ database_name: "ai_aggregator_test" }]
        : text.includes("marker_table")
          ? [{ marker_table: "public._aiag_test_database_marker" }]
          : text.startsWith("SELECT marker")
            ? [{ marker: TEST_DATABASE_MARKER }]
            : text.startsWith("SELECT current_database()::")
              ? [
                  {
                    database: "ai_aggregator_test",
                    audit_role: "test",
                    version: 150000,
                  },
                ]
              : [],
      rowCount: 1,
    }));
    const factory = vi.fn(async () => ({
      connect: async () => {},
      end,
      query,
    }));
    const result = await runLocalTonPrivilegeAudit(
      env,
      factory as TestDatabaseClientFactory,
    );
    expect(result.exitCode).toBe(1);
    expect(result.report.runtimeSettlementAllowed).toBe(false);
    expect(end).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.at(-1)?.[0].text).toBe("ROLLBACK");
  });
  it("does not disclose the connection string when the factory fails", async () => {
    const factory = vi
      .fn()
      .mockRejectedValue(new Error("postgresql://private:secret@server"));
    const result = await runLocalTonPrivilegeAudit(env, factory);
    expect(result.exitCode).toBe(1);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
