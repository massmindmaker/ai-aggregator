import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ constructor: vi.fn() }));
vi.mock("pg", () => ({
  Client: vi.fn(function () {
    m.constructor();
  }),
}));
import { rehearseTonWorkerRestore } from "../ton-worker-restore";
const roles = {
  web: "test_web",
  api: "test_api",
  worker: "test_worker",
  owner: "test_owner",
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AIAG_TEST_DATABASE", "1");
});
afterEach(() => vi.unstubAllEnvs());
describe("restore never targets a real or ambiguous database", () => {
  it.each([
    "postgresql://owner@production.example/db",
    "postgresql://owner@127.0.0.1:15432/ai_aggregator_test",
    "postgresql://owner@127.0.0.1:15432/aiag_author_http_" +
      "a".repeat(32) +
      "?options=x",
    "postgresql://owner@127.0.0.1:5432/aiag_author_http_" + "a".repeat(32),
  ])("rejects %s before connection or subprocess", async (url) => {
    await expect(rehearseTonWorkerRestore(url, roles, vi.fn())).rejects.toThrow(
      "TON_RESTORE_LOCAL_ONLY",
    );
    expect(m.constructor).not.toHaveBeenCalled();
  });
  it("requires the explicit disposable-test environment", async () => {
    vi.stubEnv("AIAG_TEST_DATABASE", "");
    await expect(
      rehearseTonWorkerRestore(
        "postgresql://owner@127.0.0.1:15432/aiag_author_http_" + "a".repeat(32),
        roles,
        vi.fn(),
      ),
    ).rejects.toThrow("TON_RESTORE_LOCAL_ONLY");
    expect(m.constructor).not.toHaveBeenCalled();
  });
});
