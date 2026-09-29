import { describe, expect, it, vi } from "vitest";
import {
  parseTonBoundaryRoles,
  installTonWorkerBoundary,
} from "../ton-worker-boundary";
const roles = {
  web: "test_web",
  api: "test_api",
  worker: "test_worker",
  owner: "test_owner",
};
describe("strict TON privilege provisioning inputs", () => {
  it("accepts exactly4canonical distinct roles without normalizing authority", () =>
    expect(parseTonBoundaryRoles(roles)).toEqual(roles));
  it.each([
    null,
    [],
    { ...roles, web: roles.worker },
    { ...roles, owner: "test_owner;GRANT ALL" },
    { ...roles, worker: "worker\n" },
    { ...roles, web: "a".repeat(64) },
    { ...roles, public: "PUBLIC" },
    Object.assign(Object.create({ admin: true }), roles),
  ])(
    "rejects malformed or ambiguous privilege inputs before DB access",
    async (input) => {
      const c = { query: vi.fn() };
      await expect(
        installTonWorkerBoundary(c as never, input as never),
      ).rejects.toThrow();
      expect(c.query).not.toHaveBeenCalled();
    },
  );
  it("does not run getters while reading role input", () => {
    let calls = 0;
    const x = Object.defineProperty({ ...roles }, "worker", {
      enumerable: true,
      get() {
        calls++;
        return "test_worker";
      },
    });
    expect(() => parseTonBoundaryRoles(x)).toThrow();
    expect(calls).toBe(0);
  });
  it("refuses non-owned connection before any DDL or GRANT", async () => {
    const c = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            database: "production",
            port: 5432,
            host: "10.0.0.1",
            session_role: "owner",
            current_role: "owner",
            superuser: true,
          },
        ],
      }),
    };
    await expect(installTonWorkerBoundary(c as never, roles)).rejects.toThrow(
      "TON_BOUNDARY_LOCAL_IDENTITY_REQUIRED",
    );
    expect(
      c.query.mock.calls
        .flat()
        .map((q: any) => q.text)
        .some((s: string) => /CREATE|GRANT|ALTER|REVOKE/.test(s)),
    ).toBe(false);
  });
});
