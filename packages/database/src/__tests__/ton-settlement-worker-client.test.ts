import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
  end: vi.fn(),
  pool: vi.fn(),
}));
vi.mock("pg", () => ({
  Pool: vi.fn(function (options: unknown) {
    m.pool(options);
    return { connect: m.connect, end: m.end };
  }),
}));
import {
  createTonSettlementWorkerDatabase,
  settleTonInvoiceAsWorker,
} from "../ton-reconciliation-internal";
const role = "test_settler",
  owner = "test_owner",
  url = "postgresql://test_settler:synthetic@127.0.0.1:15432/local";
const identity = {
  session_role: role,
  current_role: role,
  superuser: false,
  createrole: false,
  createdb: false,
  replication: false,
  bypassrls: false,
  owner_name: owner,
  owner_login: false,
  owner_superuser: false,
  owner_createrole: false,
  owner_createdb: false,
  owner_replication: false,
  owner_bypassrls: false,
  owner_member: false,
  definer: true,
  config: ["search_path=pg_catalog, public, pg_temp"],
};
const credit = {
  network: "tvm:-3" as const,
  asset: {
    network: "tvm:-3" as const,
    kind: "native" as const,
    decimals: 9 as const,
  },
  recipient: "0:" + "1".repeat(64),
  recipientAccount: "0:" + "1".repeat(64),
  sender: "0:" + "2".repeat(64),
  amountAtomic: "1000",
  reference: "fixture",
  txHash: "a".repeat(64),
  txLt: "1",
  messageHash: "b".repeat(64),
  messageIndex: 0,
  chainTimeMs: 1,
  observedAtMs: 2,
  verifiedAtMs: 3,
  blockAnchor: "fixture",
  masterchainAnchor: "fixture",
  executionPathDigest: "c".repeat(64),
  verifierVersion: "fixture",
  finalityPolicyId: "fixture",
  jettonCredit: null,
};
beforeEach(() => {
  vi.clearAllMocks();
  m.connect.mockResolvedValue({ query: m.query, release: m.release });
  m.end.mockResolvedValue(undefined);
  m.query.mockImplementation(async ({ text }) => ({
    rows: text.startsWith("SELECT session_user")
      ? [identity]
      : text.includes("settle_invoice_v1($1")
        ? [{ result: { kind: "not_found" } }]
        : [],
    rowCount: 1,
  }));
});
describe("dedicated settlement database session", () => {
  it.each([
    "postgresql://web@127.0.0.1/db",
    "postgresql://test_settler@127.0.0.1/db?options=-c+role%3Dadmin",
    "postgresql://test_settler@127.0.0.1/db#x",
    "https://test_settler@127.0.0.1/db",
  ])("refuses incompatible identity/settings before creating a pool", (u) => {
    expect(() =>
      createTonSettlementWorkerDatabase(u, {
        workerRole: role,
        ownerRole: owner,
      }),
    ).toThrow("TON_SETTLEMENT_DATABASE_CONFIG");
    expect(m.pool).not.toHaveBeenCalled();
  });
  it("checks actual session inside every bounded transaction and calls only the worker RPC", async () => {
    const db = createTonSettlementWorkerDatabase(url, {
      workerRole: role,
      ownerRole: owner,
    });
    try {
      expect(
        await settleTonInvoiceAsWorker(
          db,
          "00000000-0000-4000-8000-000000000001",
          credit,
        ),
      ).toEqual({ kind: "not_found" });
      const q = m.query.mock.calls.map((c) => c[0].text);
      expect(q[0]).toBe("BEGIN");
      expect(q[1]).toContain("SELECT session_user");
      expect(q[2]).toBe(
        "SELECT aiag_ton_worker.settle_invoice_v1($1::uuid,$2::jsonb) AS result",
      );
      expect(q[3]).toBe("COMMIT");
      expect(q.some((s) => s.includes("SELECT aiag_settle_ton_invoice"))).toBe(
        false,
      );
    } finally {
      await db.close();
    }
  });
  it.each([
    { session_role: "web" },
    { current_role: owner },
    { superuser: true },
    { owner_login: true },
    { owner_superuser: true },
    { owner_name: "wrong" },
    { owner_member: true },
    { definer: false },
    { config: ["search_path=pg_temp, public"] },
  ])(
    "refuses wrong actual privilege state %j without financial RPC",
    async (patch) => {
      m.query.mockImplementation(async ({ text }) => ({
        rows: text.startsWith("SELECT session_user")
          ? [{ ...identity, ...patch }]
          : [],
        rowCount: 1,
      }));
      const db = createTonSettlementWorkerDatabase(url, {
        workerRole: role,
        ownerRole: owner,
      });
      try {
        await expect(
          settleTonInvoiceAsWorker(
            db,
            "00000000-0000-4000-8000-000000000001",
            credit,
          ),
        ).rejects.toThrow("TON_SETTLEMENT_SESSION_REFUSED");
        expect(
          m.query.mock.calls.some((c) =>
            c[0].text.includes("settle_invoice_v1($1"),
          ),
        ).toBe(false);
        expect(m.query.mock.calls.at(-1)?.[0].text).toBe("ROLLBACK");
      } finally {
        await db.close();
      }
    },
  );
});
