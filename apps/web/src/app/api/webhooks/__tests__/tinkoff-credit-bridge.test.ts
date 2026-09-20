/**
 * Payment → org-credit BRIDGE behaviour (fix/r1a-payment-credit-bridge).
 *
 * The gateway debits organizations.payg_credits / subscription_credits (BIGINT
 * micro-credits). Before this bridge a CONFIRMED Tinkoff payment credited only
 * the legacy users.balance (rubles) and the org stayed at 0 → every model call
 * 402'd. These tests pin the BEHAVIOUR of /api/webhooks/tinkoff (not the
 * formula): they assert the parameters the route hands to the guarded org
 * UPDATE, with the DB layer mocked exactly like src/__tests__/payments/routes.test.ts.
 *
 *   - topup CONFIRMED → organizations.payg_credits += round(rub × 1_200_000/990) micro
 *   - tier  CONFIRMED → organizations.subscription_credits = credits × period × 1000 micro
 *   - the grant lives INSIDE the idempotency gate → a duplicate webhook grants nothing
 *   - the org is scoped from the PAYMENT's userId, never the request body
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// --- capture holders (module scope; hoisted vi.mock factories reference them
//     lazily inside arrows so this stays TDZ-safe, mirroring routes.test.ts) ---
const txExecute = vi.fn();
const txInsert = vi.fn();
const getOrgMock = vi.fn();
const confirmTopupMock = vi.fn();
const reconcileFullMock = vi.fn();
const getTierMock = vi.fn();
const blockGrantMock = vi.fn();
let gateReturning: unknown[] = [];
let webhookAmount = 990;
let webhookStatus = "CONFIRMED";
let webhookSuccess = true;
let currentPayment: unknown = null;

// tinkoff.parseWebhook → a valid CONFIRMED callback. `amount` is the only field
// the credit path reads from here; tier/billing come from the payment row.
vi.mock("@/lib/tinkoff", () => ({
  tinkoff: {
    parseWebhook: () => ({
      isValid: true,
      success: webhookSuccess,
      status: webhookStatus,
      paymentId: "t1",
      orderId: "o1",
      amount: webhookAmount,
      rebillId: "rb1",
      cardPan: "4111",
    }),
  },
}));

vi.mock("@/lib/payments/topup-confirmation", () => ({
  rublesToKopecks: (value: string) => Math.round(Number(value) * 100),
  calculateTopupGrantCredits: (kopecks: number) =>
    Math.round((kopecks * 1_200_000) / 99_000),
  confirmTinkoffTopup: (...args: unknown[]) => confirmTopupMock(...args),
  blockUnconfirmedTopupGrantForRefund: (...args: unknown[]) =>
    blockGrantMock(...args),
}));

vi.mock("@/lib/payments/topup-refund", () => ({
  reconcileFullTopupRefund: (...args: unknown[]) => reconcileFullMock(...args),
}));

vi.mock("@/lib/payments/providers", () => ({
  resolveTinkoffSecret: () => "secret",
  getTier: (...args: unknown[]) => getTierMock(...args),
}));

vi.mock("@/lib/dashboard/org", () => ({
  getOrCreateDefaultOrg: (...a: unknown[]) => getOrgMock(...a),
}));

// Real schema replaced with sentinels so the tx mock can route .returning() by
// table without loading the (heavy) Drizzle schema.
vi.mock("@aiag/database/schema", () => ({
  payments: { __table: "payments" },
  paymentWebhookLogs: { __table: "paymentWebhookLogs" },
  subscriptions: { __table: "subscriptions" },
  balanceTransactions: { __table: "balanceTransactions" },
  users: { __table: "users" },
}));

// sql tag → capture raw + the interpolated values (the point of the assertions).
vi.mock("@aiag/database", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    raw: strings.raw.join("?"),
    values,
  }),
  eq: (...a: unknown[]) => ({ eq: a }),
  and: (...a: unknown[]) => ({ and: a }),
  inArray: (...a: unknown[]) => ({ inArray: a }),
}));

function makeTx() {
  let lastTable = "";
  const whereChain = {
    // thenable: `await tx.update(subscriptions).set().where()` has no .returning()
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(undefined).then(res, rej),
    returning: () => {
      if (lastTable === "payments") return Promise.resolve(gateReturning);
      if (lastTable === "users")
        return Promise.resolve([{ balance: String(webhookAmount) }]);
      return Promise.resolve([]);
    },
  };
  return {
    update: (table: { __table?: string }) => {
      lastTable = table?.__table ?? "";
      return { set: () => ({ where: () => whereChain }) };
    },
    insert: (table: unknown) => {
      txInsert(table);
      return { values: () => Promise.resolve(undefined) };
    },
    execute: (...a: unknown[]) => txExecute(...a),
  };
}

vi.mock("@/lib/db", () => ({
  db: {
    query: { payments: { findFirst: () => Promise.resolve(currentPayment) } },
    transaction: (fn: (tx: unknown) => unknown) => fn(makeTx()),
    insert: (table: unknown) => ({
      values: (value: unknown) => txInsert(table, value),
    }),
  },
}));

import { POST } from "@/app/api/webhooks/tinkoff/route";

function makeReq(): Request {
  return new Request("http://localhost/api/webhooks/tinkoff", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      Success: webhookSuccess,
      Status: webhookStatus,
      PaymentId: "t1",
      OrderId: "o1",
      Amount: Math.round(webhookAmount * 100),
      Token: "signed",
    }),
  });
}

beforeEach(() => {
  txExecute.mockReset().mockResolvedValue({ rows: [] });
  txInsert.mockReset();
  getOrgMock.mockReset().mockResolvedValue("org-123");
  confirmTopupMock.mockReset().mockResolvedValue({ kind: "confirmed" });
  reconcileFullMock.mockReset().mockResolvedValue({ kind: "settled" });
  getTierMock.mockReset().mockImplementation(
    (id: string) =>
      (
        ({
          basic: { name: "Basic", monthly: 990, yearly: 9900, credits: 1200 },
          starter: {
            name: "Starter",
            monthly: 2490,
            yearly: 24900,
            credits: 3200,
          },
          pro: { name: "Pro", monthly: 6990, yearly: 69900, credits: 10000 },
        }) as Record<string, unknown>
      )[id] ?? null,
  );
  blockGrantMock.mockReset().mockResolvedValue({ kind: "blocked" });
  gateReturning = [];
  webhookAmount = 990;
  webhookStatus = "CONFIRMED";
  webhookSuccess = true;
  currentPayment = null;
});

describe("POST /api/webhooks/tinkoff — payment→org-credit bridge", () => {
  it("TOPUP: passes exact signed kopecks and canonical grant to the atomic confirmation helper", async () => {
    currentPayment = {
      id: "pay_1",
      userId: "user-1",
      subscriptionId: null,
      amount: "990.00",
      status: "pending",
      tinkoffPaymentId: "t1",
      tinkoffOrderId: "o1",
      metadata: { kind: "topup", provider: "tinkoff" },
    };
    webhookAmount = 990;

    const res = await POST(makeReq() as never);
    expect(res.status).toBe(200);

    await expect(res.text()).resolves.toBe("OK");
    expect(confirmTopupMock).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "pay_1",
        userId: "user-1",
        providerPaymentId: "t1",
        providerOrderId: "o1",
        paidKopecks: 99_000,
        grantCredits: 1_200_000,
      }),
    );
  });

  it("TOPUP is linear (not hardcoded): 495 ₽ → 600_000 micro", async () => {
    currentPayment = {
      id: "pay_1",
      userId: "user-1",
      subscriptionId: null,
      amount: "495.00",
      status: "pending",
      tinkoffPaymentId: "t1",
      tinkoffOrderId: "o1",
      metadata: { kind: "topup", provider: "tinkoff" },
    };
    webhookAmount = 495;

    await POST(makeReq() as never);
    expect(confirmTopupMock).toHaveBeenCalledWith(
      expect.objectContaining({ grantCredits: 600_000 }),
    );
  });

  it("SUBSCRIPTION monthly (basic): sets subscription_credits = 1200×1×1000 = 1_200_000 micro (+ expiry)", async () => {
    currentPayment = {
      id: "pay_2",
      tinkoffPaymentId: "t1",
      tinkoffOrderId: "o1",
      subscriptionId: "sub_1",
    };
    gateReturning = [
      {
        id: "pay_2",
        userId: "user-2",
        subscriptionId: "sub_1",
        metadata: {
          kind: "subscription",
          tier_id: "basic",
          billing: "monthly",
        },
      },
    ];

    const res = await POST(makeReq() as never);
    expect(res.status).toBe(200);
    expect(getOrgMock).toHaveBeenCalledWith("user-2", expect.any(Object));

    expect(txExecute).toHaveBeenCalledTimes(1);
    const q = txExecute.mock.calls[0][0] as { raw: string; values: unknown[] };
    expect(q.raw).toContain("subscription_credits =");
    expect(q.raw).toContain("subscription_credits_expires_at");
    // SET (not +=): fresh period replaces the bucket
    expect(q.raw).not.toContain(
      "subscription_credits = subscription_credits +",
    );
    expect(q.values[0]).toBe(1_200_000);
    // period end is bound as a Date, org id is the last param
    expect(q.values[1]).toBeInstanceOf(Date);
    expect(q.values[q.values.length - 1]).toBe("org-123");
  });

  it("SUBSCRIPTION yearly (basic): sets subscription_credits = 1200×12×1000 = 14_400_000 micro", async () => {
    currentPayment = {
      id: "pay_3",
      tinkoffPaymentId: "t1",
      tinkoffOrderId: "o1",
      subscriptionId: "sub_2",
    };
    gateReturning = [
      {
        id: "pay_3",
        userId: "user-3",
        subscriptionId: "sub_2",
        metadata: { kind: "subscription", tier_id: "basic", billing: "yearly" },
      },
    ];

    await POST(makeReq() as never);
    const q = txExecute.mock.calls[0][0] as { values: unknown[] };
    expect(q.values[0]).toBe(14_400_000);
  });

  it("IDEMPOTENT: duplicate CONFIRMED trusts its snapshot when Basic later disappears", async () => {
    currentPayment = {
      id: "pay_1",
      userId: "user-1",
      subscriptionId: null,
      amount: "990.00",
      status: "confirmed",
      tinkoffPaymentId: "t1",
      tinkoffOrderId: "o1",
      metadata: { kind: "topup", provider: "tinkoff" },
    };
    getTierMock.mockReturnValue(null);
    confirmTopupMock.mockResolvedValue({ kind: "duplicate" });

    const res = await POST(makeReq() as never);
    expect(res.status).toBe(200);
    expect(getTierMock).not.toHaveBeenCalled();
    expect(confirmTopupMock).toHaveBeenCalledWith(
      expect.objectContaining({ grantCredits: undefined }),
    );
    expect(txExecute).not.toHaveBeenCalled();
  });

  it("rejects a signed integer Amount that differs from persisted RUB before confirmation", async () => {
    currentPayment = {
      id: "pay_1",
      userId: "user-1",
      subscriptionId: null,
      amount: "990.01",
      status: "pending",
      tinkoffPaymentId: "t1",
      tinkoffOrderId: "o1",
      metadata: { kind: "topup", provider: "tinkoff" },
    };

    const res = await POST(makeReq() as never);
    expect(res.status).toBe(409);
    expect(confirmTopupMock).not.toHaveBeenCalled();
    expect(txInsert).toHaveBeenCalledWith(
      { __table: "paymentWebhookLogs" },
      expect.objectContaining({
        processingError: expect.stringContaining("Amount differs"),
      }),
    );
  });

  it("reconciles a full top-up refund from the immutable snapshot and acknowledges exact OK", async () => {
    webhookStatus = "REFUNDED";
    currentPayment = {
      id: "pay_1",
      subscriptionId: null,
      tinkoffPaymentId: "t1",
      tinkoffOrderId: "o1",
      topupOrgId: "org-1",
      topupPaidKopecks: 99_000n,
      topupGrantCredits: 1_200_000n,
      metadata: { kind: "topup", provider: "tinkoff" },
    };

    const res = await POST(makeReq() as never);
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe("OK");
    expect(reconcileFullMock).toHaveBeenCalledWith("pay_1", {
      provider: "tinkoff",
      providerPaymentId: "t1",
      providerOrderId: "o1",
    });
  });

  it("fails closed and records a minimal durable HIGH error for partial top-up refund", async () => {
    webhookStatus = "PARTIAL_REFUNDED";
    currentPayment = {
      id: "pay_1",
      subscriptionId: null,
      status: "pending",
      tinkoffPaymentId: "t1",
      tinkoffOrderId: "o1",
      metadata: { kind: "topup", provider: "tinkoff" },
    };

    const res = await POST(makeReq() as never);
    expect(res.status).toBe(409);
    expect(blockGrantMock).toHaveBeenCalledOnce();
    expect(reconcileFullMock).not.toHaveBeenCalled();
    expect(txInsert).toHaveBeenCalledWith(
      { __table: "paymentWebhookLogs" },
      expect.objectContaining({
        payload: { status: "PARTIAL_REFUNDED", paymentId: "t1", orderId: "o1" },
        processingError: expect.stringContaining("HIGH:"),
      }),
    );
  });

  it("durably blocks a full refund delivered before confirmation and grants nothing", async () => {
    webhookStatus = "REFUNDED";
    currentPayment = {
      id: "pay_1",
      subscriptionId: null,
      status: "pending",
      tinkoffPaymentId: "t1",
      tinkoffOrderId: "o1",
      metadata: { kind: "topup", provider: "tinkoff" },
    };

    const res = await POST(makeReq() as never);

    expect(res.status).toBe(409);
    expect(blockGrantMock).toHaveBeenCalledWith({
      paymentId: "pay_1",
      providerPaymentId: "t1",
      providerOrderId: "o1",
    });
    expect(confirmTopupMock).not.toHaveBeenCalled();
    expect(reconcileFullMock).not.toHaveBeenCalled();
  });

  it("reconciles a full refund after marker CAS observes that confirmation won", async () => {
    webhookStatus = "REFUNDED";
    currentPayment = {
      id: "pay_1",
      subscriptionId: null,
      status: "pending",
      tinkoffPaymentId: "t1",
      tinkoffOrderId: "o1",
      metadata: { kind: "topup", provider: "tinkoff" },
    };
    blockGrantMock.mockResolvedValue({ kind: "snapshot_exists" });

    const res = await POST(makeReq() as never);

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe("OK");
    expect(reconcileFullMock).toHaveBeenCalledOnce();
  });
});
