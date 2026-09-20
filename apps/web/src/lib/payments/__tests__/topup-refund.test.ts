import { describe, expect, it, vi } from "vitest";
import {
  claimTopupRefund,
  releaseProvenNoEffectTopupRefundClaim,
} from "../topup-refund";

function databaseThatMustNotBeTouched() {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("database must not be touched");
      },
    },
  );
}

describe("top-up refund validation", () => {
  it("rejects unsupported method facts before touching the database", async () => {
    await expect(
      claimTopupRefund(
        "00000000-0000-4000-8000-000000000001",
        100,
        {
          paymentId: "provider-payment",
          orderId: "provider-order",
          route: "QR" as "ACQ",
          source: "cards",
          receiptMode: "trusted_no_receipt_required",
        },
        databaseThatMustNotBeTouched() as never,
      ),
    ).resolves.toEqual({ kind: "rejected", code: "UNSUPPORTED_METHOD" });
  });

  it("rejects unknown and verified receipt modes before touching the database", async () => {
    const base = {
      paymentId: "provider-payment",
      orderId: "provider-order",
      route: "ACQ" as const,
      source: "cards" as const,
    };
    const database = databaseThatMustNotBeTouched() as never;

    await expect(
      claimTopupRefund(
        "00000000-0000-4000-8000-000000000001",
        100,
        { ...base, receiptMode: "unknown" as "full_no_receipt" },
        database,
      ),
    ).resolves.toEqual({
      kind: "rejected",
      code: "RECEIPT_CONTEXT_UNSUPPORTED",
    });
    await expect(
      claimTopupRefund(
        "00000000-0000-4000-8000-000000000001",
        100,
        { ...base, receiptMode: "verified_receipt" as "full_no_receipt" },
        database,
      ),
    ).resolves.toEqual({
      kind: "rejected",
      code: "RECEIPT_CONTEXT_UNSUPPORTED",
    });
  });

  it("rejects unsafe amounts before touching the database", async () => {
    const context = {
      paymentId: "provider-payment",
      orderId: "provider-order",
      route: "ACQ" as const,
      source: "cards" as const,
      receiptMode: "full_no_receipt" as const,
    };
    const database = databaseThatMustNotBeTouched() as never;

    for (const requested of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        claimTopupRefund(
          "00000000-0000-4000-8000-000000000001",
          requested,
          context,
          database,
        ),
      ).resolves.toEqual({ kind: "rejected", code: "INVALID_REQUEST" });
    }
  });

  it("never releases a dispatched claim for an unapproved provider result", async () => {
    const database = { transaction: vi.fn() } as never;

    await expect(
      releaseProvenNoEffectTopupRefundClaim(
        "00000000-0000-4000-8000-000000000001",
        "Success=false",
        database,
      ),
    ).resolves.toEqual({ kind: "proof_not_allowed" });
    expect(
      (database as { transaction: ReturnType<typeof vi.fn> }).transaction,
    ).not.toHaveBeenCalled();
  });
});
