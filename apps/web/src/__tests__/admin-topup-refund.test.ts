import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  audit: vi.fn(),
  dbExecute: vi.fn(),
  getRefundMethodContext: vi.fn(),
  cancelClaimBoundRefund: vi.fn(),
  claimTopupRefund: vi.fn(),
  markTopupRefundDispatched: vi.fn(),
  finalizeTopupRefundProof: vi.fn(),
  genericRefund: vi.fn(),
}));

vi.mock("@/lib/admin/guard", () => ({
  AdminAuthError: class AdminAuthError extends Error {
    constructor(public code: string) {
      super(code);
    }
  },
  requireAdmin: (...args: unknown[]) => mocks.requireAdmin(...args),
  audit: (...args: unknown[]) => mocks.audit(...args),
}));

vi.mock("@/lib/db", () => ({
  db: { execute: (...args: unknown[]) => mocks.dbExecute(...args) },
  sql: (strings: TemplateStringsArray) => ({ raw: strings.raw.join(" ") }),
}));

vi.mock("@/lib/tinkoff", () => ({
  tinkoff: {
    getRefundMethodContext: (...args: unknown[]) =>
      mocks.getRefundMethodContext(...args),
    cancelClaimBoundRefund: (...args: unknown[]) =>
      mocks.cancelClaimBoundRefund(...args),
  },
}));

vi.mock("@/lib/payments/topup-refund", () => ({
  claimTopupRefund: (...args: unknown[]) => mocks.claimTopupRefund(...args),
  markTopupRefundDispatched: (...args: unknown[]) =>
    mocks.markTopupRefundDispatched(...args),
  finalizeTopupRefundProof: (...args: unknown[]) =>
    mocks.finalizeTopupRefundProof(...args),
}));

vi.mock("@/lib/payments/providers", () => ({
  getPaymentProvider: () => ({
    refund: (...args: unknown[]) => mocks.genericRefund(...args),
  }),
}));

import type { NextRequest } from "next/server";
import { POST } from "@/app/api/admin/payments/refund/route";

const PAYMENT_ID = "11111111-1111-4111-8111-111111111111";
const CLAIM_ID = "22222222-2222-4222-8222-222222222222";
const METHOD_CONTEXT = Object.freeze({ proof: "client-owned" });
const PROOF = {
  paymentId: "bank-payment-1",
  orderId: "bank-order-1",
  externalRequestId: "provider-key-1",
  status: "REFUNDED",
  originalAmountKopecks: 99_000,
  newAmountKopecks: 0,
};

const PAYMENT = {
  id: PAYMENT_ID,
  subscription_id: null,
  amount: "990.00",
  currency: "RUB",
  status: "confirmed",
  payment_method: "tinkoff",
  metadata: { kind: "topup", provider: "tinkoff" },
  tinkoff_payment_id: "bank-payment-1",
  tinkoff_order_id: "bank-order-1",
  topup_paid_kopecks: "99000",
  topup_refunded_kopecks: "0",
  refund_claim_id: null,
};

const CLAIM = {
  claimId: CLAIM_ID,
  providerKey: "provider-key-1",
  paymentId: PAYMENT_ID,
  providerPaymentId: "bank-payment-1",
  providerOrderId: "bank-order-1",
  requestedKopecks: 99_000,
  paidKopecks: 99_000,
  refundedKopecks: 0,
  route: "ACQ",
  source: "cards",
  receiptMode: "full_no_receipt",
  claimedAt: new Date("2026-09-20T00:00:00Z"),
  dispatchedAt: null,
};

function request(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    paymentId: PAYMENT_ID,
    provider: "tinkoff",
    providerPaymentId: "bank-payment-1",
    amount: 990,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({ user: { email: "admin@test" } });
  mocks.audit.mockResolvedValue(undefined);
  mocks.dbExecute.mockResolvedValue({ rows: [PAYMENT] });
  mocks.getRefundMethodContext.mockResolvedValue({
    kind: "supported",
    context: METHOD_CONTEXT,
  });
  mocks.claimTopupRefund.mockResolvedValue({ kind: "claimed", claim: CLAIM });
  mocks.markTopupRefundDispatched.mockResolvedValue({
    kind: "marked",
    claim: { ...CLAIM, dispatchedAt: new Date("2026-09-20T00:00:01Z") },
  });
  mocks.cancelClaimBoundRefund.mockResolvedValue({
    kind: "settled",
    proof: PROOF,
  });
  mocks.finalizeTopupRefundProof.mockResolvedValue({ kind: "settled" });
});

describe("POST /api/admin/payments/refund — Tinkoff top-up binding", () => {
  it("uses DB identity, exact kopecks, one persisted key and strict proof finalization", async () => {
    const response = await POST(request(body()));

    expect(response.status).toBe(200);
    expect(mocks.getRefundMethodContext).toHaveBeenCalledWith({
      paymentId: "bank-payment-1",
      orderId: "bank-order-1",
    });
    expect(mocks.claimTopupRefund).toHaveBeenCalledWith(
      PAYMENT_ID,
      99_000,
      expect.objectContaining({ receiptMode: "full_no_receipt" }),
    );
    expect(mocks.cancelClaimBoundRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        providerKey: "provider-key-1",
        paymentId: "bank-payment-1",
        orderId: "bank-order-1",
        requestedKopecks: 99_000,
        methodContext: METHOD_CONTEXT,
      }),
    );
    expect(mocks.finalizeTopupRefundProof).toHaveBeenCalledWith(
      CLAIM_ID,
      PROOF,
    );
  });

  it("rejects contradictory client provider identity before GetState or Cancel", async () => {
    const response = await POST(
      request(body({ providerPaymentId: "attacker-payment" })),
    );

    expect(response.status).toBe(409);
    expect(mocks.getRefundMethodContext).not.toHaveBeenCalled();
    expect(mocks.cancelClaimBoundRefund).not.toHaveBeenCalled();
  });

  it("rejects fractional sub-kopeck RUB input before DB/provider work", async () => {
    const response = await POST(request(body({ amount: 1.001 })));

    expect(response.status).toBe(400);
    expect(mocks.dbExecute).not.toHaveBeenCalled();
    expect(mocks.cancelClaimBoundRefund).not.toHaveBeenCalled();
  });

  it.each([
    [128.02, 12_802],
    [300.03, 30_003],
  ])(
    "accepts exact decimal RUB %s and sends Cancel with %i kopecks",
    async (amount, kopecks) => {
      const decimalPayment = {
        ...PAYMENT,
        amount: amount.toFixed(2),
        topup_paid_kopecks: String(kopecks),
      };
      const decimalClaim = {
        ...CLAIM,
        requestedKopecks: kopecks,
        paidKopecks: kopecks,
      };
      mocks.dbExecute.mockResolvedValue({ rows: [decimalPayment] });
      mocks.claimTopupRefund.mockResolvedValue({
        kind: "claimed",
        claim: decimalClaim,
      });
      mocks.markTopupRefundDispatched.mockResolvedValue({
        kind: "marked",
        claim: {
          ...decimalClaim,
          dispatchedAt: new Date("2026-09-20T00:00:01Z"),
        },
      });

      const response = await POST(request(body({ amount })));

      expect(response.status).toBe(200);
      expect(mocks.claimTopupRefund).toHaveBeenCalledWith(
        PAYMENT_ID,
        kopecks,
        expect.any(Object),
      );
      expect(mocks.cancelClaimBoundRefund).toHaveBeenCalledWith(
        expect.objectContaining({ requestedKopecks: kopecks }),
      );
    },
  );

  it("rejects 128.021 RUB before DB or Cancel instead of rounding to kopecks", async () => {
    const response = await POST(request(body({ amount: 128.021 })));

    expect(response.status).toBe(400);
    expect(mocks.dbExecute).not.toHaveBeenCalled();
    expect(mocks.cancelClaimBoundRefund).not.toHaveBeenCalled();
  });

  it("refuses partial refund without proven receipt context before claim and Cancel", async () => {
    const response = await POST(request(body({ amount: 100 })));

    expect(response.status).toBe(409);
    expect(mocks.getRefundMethodContext).toHaveBeenCalledOnce();
    expect(mocks.claimTopupRefund).not.toHaveBeenCalled();
    expect(mocks.cancelClaimBoundRefund).not.toHaveBeenCalled();
  });

  it("refuses an unsupported GetState method with zero Cancel calls", async () => {
    mocks.getRefundMethodContext.mockResolvedValue({
      kind: "unsupported",
      code: "METHOD_PARAMS_UNSUPPORTED",
    });

    const response = await POST(request(body()));

    expect(response.status).toBe(409);
    expect(mocks.claimTopupRefund).not.toHaveBeenCalled();
    expect(mocks.cancelClaimBoundRefund).not.toHaveBeenCalled();
  });

  it("keeps an indeterminate dispatched claim for reconciliation", async () => {
    mocks.cancelClaimBoundRefund.mockResolvedValue({
      kind: "indeterminate",
      code: "NETWORK_ERROR",
    });

    const response = await POST(request(body()));
    const json = await response.json();

    expect(response.status).toBe(502);
    expect(json.state).toBe("reconciliation_required");
    expect(mocks.finalizeTopupRefundProof).not.toHaveBeenCalled();
  });

  it("does not call Cancel when dispatch CAS loses to a full webhook", async () => {
    mocks.markTopupRefundDispatched.mockResolvedValue({ kind: "unavailable" });

    const response = await POST(request(body()));

    expect(response.status).toBe(409);
    expect(mocks.cancelClaimBoundRefund).not.toHaveBeenCalled();
  });

  it("allows only one concurrent claimant to reach Cancel", async () => {
    mocks.claimTopupRefund
      .mockResolvedValueOnce({ kind: "claimed", claim: CLAIM })
      .mockResolvedValueOnce({ kind: "rejected", code: "CLAIM_ACTIVE" });

    const [first, second] = await Promise.all([
      POST(request(body())),
      POST(request(body())),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(mocks.cancelClaimBoundRefund).toHaveBeenCalledTimes(1);
  });

  it("short-circuits an already active claim without minting a fresh context or key", async () => {
    mocks.dbExecute.mockResolvedValue({
      rows: [{ ...PAYMENT, refund_claim_id: CLAIM_ID }],
    });

    const response = await POST(request(body()));

    expect(response.status).toBe(409);
    expect(mocks.getRefundMethodContext).not.toHaveBeenCalled();
    expect(mocks.claimTopupRefund).not.toHaveBeenCalled();
    expect(mocks.cancelClaimBoundRefund).not.toHaveBeenCalled();
  });
});
