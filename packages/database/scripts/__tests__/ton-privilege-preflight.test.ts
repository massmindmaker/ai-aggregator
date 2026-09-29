import { describe, expect, it, vi } from "vitest";
import {
  inspectTonPrivileges,
  withTonPrivilegeSnapshot,
  type TonPrivilegeReader,
} from "../ton-privilege-preflight";
const roles = { web: "app_web", api: "app_api", worker: "ton_worker" };
describe("read-only TON privilege report boundary", () => {
  it.each([
    null,
    {},
    { ...roles, extra: "forged" },
    { ...roles, web: "app_web;GRANT" },
    { ...roles, api: "x".repeat(64) },
    { ...roles, worker: "" },
  ])("rejects invalid role contracts before SQL", async (value) => {
    const query = vi.fn();
    const r = await inspectTonPrivileges(
      { query } as TonPrivilegeReader,
      value as never,
    );
    expect(r.status).toBe("blocked");
    expect(r.runtimeSettlementAllowed).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
  it("does not leak raw errors or credentials when catalog lookup fails", async () => {
    const query = vi
      .fn()
      .mockRejectedValue(
        new Error("postgresql://private:secret@db payment row"),
      );
    const result = await inspectTonPrivileges(
      { query } as TonPrivilegeReader,
      roles,
    );
    expect(result.status).toBe("blocked");
    expect(JSON.stringify(result)).not.toMatch(/secret|payment row/);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: "CATALOG_INSPECTION_FAILED" }),
    );
  });
  it("rejects unsupported PostgreSQL before membership inspection", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          database: "test",
          audit_role: "auditor",
          version: 150000,
          read_only: "on",
        },
      ],
      rowCount: 1,
    });
    const r = await inspectTonPrivileges(
      { query } as TonPrivilegeReader,
      roles,
    );
    expect(r.findings).toContainEqual(
      expect.objectContaining({ code: "POSTGRES_VERSION_UNSUPPORTED" }),
    );
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("owns one read-only snapshot and always rolls it back", async () => {
    const statements: string[] = [];
    const query = vi.fn(async ({ text }: { text: string }) => {
      statements.push(text);
      if (text.startsWith("SELECT current_database"))
        return {
          rows: [
            {
              database: "test",
              audit_role: "auditor",
              version: 150000,
              read_only: "on",
            },
          ],
          rowCount: 1,
        };
      return { rows: [], rowCount: 0 };
    });
    const result = await withTonPrivilegeSnapshot(
      { query } as TonPrivilegeReader,
      roles,
    );
    expect(result.runtimeSettlementAllowed).toBe(false);
    expect(statements[0]).toBe(
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(
      statements.filter((s) =>
        /^(CREATE|ALTER|GRANT|REVOKE|INSERT|UPDATE|DELETE|DROP|TRUNCATE)/.test(
          s,
        ),
      ),
    ).toEqual([]);
  });
  it("reports uncertain snapshot closure instead of silently treating it as accepted", async () => {
    const query = vi.fn(async ({ text }: { text: string }) => {
      if (text === "ROLLBACK") throw Error("sensitive connection detail");
      if (text.startsWith("SELECT current_database"))
        return {
          rows: [
            {
              database: "test",
              audit_role: "auditor",
              version: 150000,
              read_only: "on",
            },
          ],
          rowCount: 1,
        };
      return { rows: [], rowCount: 0 };
    });
    const r = await withTonPrivilegeSnapshot(
      { query } as TonPrivilegeReader,
      roles,
    );
    expect(r.findings).toContainEqual(
      expect.objectContaining({ code: "AUDIT_SNAPSHOT_CLOSE_FAILED" }),
    );
    expect(r.status).toBe("blocked");
  });
});
