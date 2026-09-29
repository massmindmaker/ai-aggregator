import { describe, expect, it } from "vitest";
import type { TonReceipt } from "@aiag/database";
import { invoice } from "./ton-recovery.fixture";
import { parseTonSettlementResult } from "../ton-settlement-result.js";
import { receipt } from "./ton-settlement.fixture";
describe("exact invoice-bound settlement ACK", () => {
  it.each(["settled", "already_settled"] as const)(
    "accepts %s with the original immutable receipt",
    (kind) => {
      const value = { kind, receipt: receipt() };
      expect(parseTonSettlementResult(value, invoice())).toEqual(value);
    },
  );
  it.each(["not_found", "evidence_conflict", "review_required"])(
    "accepts only the documented %s branch",
    (kind) => {
      const value =
        kind === "not_found"
          ? { kind }
          : kind === "evidence_conflict"
            ? { kind, eventId: receipt().eventId }
            : {
                kind,
                eventId: receipt().eventId,
                invoiceId: invoice().invoiceId,
                reason: "late_payment",
              };
      expect(parseTonSettlementResult(value, invoice())).toEqual(value);
    },
  );
  it.each([
    "invoiceId",
    "ownerId",
    "orgId",
    "orderId",
    "grantMicrocredits",
    "amountAtomic",
    "network",
  ])("rejects a mismatched receipt %s", (key) => {
    const value = {
      ...receipt(),
      [key]: key.endsWith("Id") ? "90000000-0000-4000-8000-000000000099" : "5",
    };
    expect(() =>
      parseTonSettlementResult({ kind: "settled", receipt: value }, invoice()),
    ).toThrow();
  });
  it.each([
    null,
    [],
    { kind: "not_found", receipt: receipt() },
    { kind: "evidence_conflict", eventId: "bad" },
    {
      kind: "review_required",
      invoiceId: "90000000-0000-4000-8000-000000000099",
      eventId: receipt().eventId,
      reason: "late_payment",
    },
    {
      kind: "review_required",
      invoiceId: invoice().invoiceId,
      eventId: receipt().eventId,
      reason: "forged",
    },
    { kind: "settled", receipt: { ...receipt(), settledAt: "not-a-date" } },
    {
      kind: "settled",
      receipt: { ...receipt(), paygAfterMicrocredits: "1".repeat(20000) },
    },
    {
      kind: "settled",
      receipt: { ...receipt(), refundDebtAfterMicrocredits: "-1" },
    },
    {
      kind: "settled",
      receipt: { ...receipt(), asset: { ...receipt().asset, untrusted: true } },
    },
    {
      kind: "settled",
      receipt: { ...receipt(), paygAfterMicrocredits: "9223372036854775808" },
    },
    { kind: "settled", receipt: { ...receipt(), paygAfterMicrocredits: 1000 } },
  ])("rejects malformed or excessive result %j", (value) => {
    expect(() => parseTonSettlementResult(value, invoice())).toThrow();
  });
  it("does not evaluate getters or serialization hooks in an untrusted ACK", () => {
    let accessed = 0;
    const value = Object.defineProperty({}, "kind", {
      enumerable: true,
      get() {
        accessed++;
        return "not_found";
      },
    });
    expect(() => parseTonSettlementResult(value, invoice())).toThrow();
    expect(accessed).toBe(0);
    const hooked = {
      kind: "not_found",
      toJSON() {
        accessed++;
        return { kind: "not_found" };
      },
    };
    expect(() => parseTonSettlementResult(hooked, invoice())).toThrow();
    expect(accessed).toBe(0);
  });
  it("does not use the current ledger balance or current provider event as the historical receipt", () => {
    const r = {
      ...receipt(),
      eventId: "50000000-0000-4000-8000-000000000009",
      paygAfterMicrocredits: "9007199254740991",
    };
    expect(
      parseTonSettlementResult(
        { kind: "already_settled", receipt: r },
        invoice(),
      ),
    ).toEqual({ kind: "already_settled", receipt: r });
  });
  it.each([
    "receiptId",
    "eventId",
    "paygAfterMicrocredits",
    "refundDebtAfterMicrocredits",
  ])("rejects whitespace suffix in canonical receipt field %s", (field) => {
    const r = receipt();
    expect(() =>
      parseTonSettlementResult(
        {
          kind: "settled",
          receipt: { ...r, [field]: r[field as keyof TonReceipt] + "\n" },
        },
        invoice(),
      ),
    ).toThrow();
  });

  it.each([
    "2026-02-29T12:00:00Z",
    "2024-02-30T12:00:00.123456Z",
    "2026-04-31T12:00:00+00:00",
    "2026-09-29T24:00:00Z",
  ])("rejects normalized but impossible timestamp %s", (settledAt) => {
    expect(() =>
      parseTonSettlementResult(
        { kind: "settled", receipt: { ...receipt(), settledAt } },
        invoice(),
      ),
    ).toThrow();
  });
  it.each(["2024-02-29T12:00:00.123456+03:00", "2026-09-29T00:00:00Z"])(
    "preserves supported real timestamp %s",
    (settledAt) => {
      expect(
        parseTonSettlementResult(
          { kind: "settled", receipt: { ...receipt(), settledAt } },
          invoice(),
        ),
      ).toMatchObject({ receipt: { settledAt } });
    },
  );
  it.each(["hidden", "symbol", "inherited"])(
    "rejects %s receipt authority",
    (kind) => {
      const r = receipt();
      let value: unknown = r;
      if (kind === "hidden") Object.defineProperty(r, "memo", { value: "bad" });
      if (kind === "symbol")
        Object.defineProperty(r, Symbol("memo"), { value: "bad" });
      if (kind === "inherited")
        value = Object.assign(Object.create({ memo: "bad" }), r);
      expect(() =>
        parseTonSettlementResult(
          { kind: "settled", receipt: value },
          invoice(),
        ),
      ).toThrow();
    },
  );
});
