import { describe, expect, it } from "vitest";

import { createQuote } from "@aiag/shared/ton-payment-contract";
import { createTonInvoice, settleTonInvoice, type TonPaymentDatabase, type TonSqlClient } from "../index";

const asset = { network: "tvm:-3", kind: "native", decimals: 9 } as const;
const actor = "00000000-0000-4000-8000-000000000001";
const org = "00000000-0000-4000-8000-000000000002";

function input() {
  const quotedAtMs = Date.now();
  return {
    idempotencyKey: "unit-key", grantMicrocredits: "3", priceRevision: "unit-v1",
    quote: createQuote({
      quoteId: "unit-quote", sourcePrice: { unit: "gateway_microcredits", amountAtomic: "3" }, asset,
      fx: { sourceUnit: "gateway_microcredits", targetAsset: asset, numerator: "1", denominator: "1", rounding: "floor", source: "unit", observedAtMs: quotedAtMs, expiresAtMs: quotedAtMs + 60_000 },
      additionalFeeAtomic: "2", expiresAtMs: quotedAtMs + 60_000,
    }, [asset], quotedAtMs),
    recipient: `0:${"1".repeat(64)}`, expectedSender: `0:${"2".repeat(64)}`,
    finalityPolicyId: "unit-finality", verifierVersion: "unit-verifier",
  };
}

function recordingDatabase(rows: unknown[][] = []) {
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  const tx: TonSqlClient = { query: async <Row extends Record<string, unknown> = Record<string, unknown>>(config: { text: string; values: readonly unknown[] }) => {
    calls.push(config);
    const next = rows.shift() ?? [];
    return { rows: next as Row[], rowCount: next.length };
  } };
  return { db: { transaction: (run) => run(tx) } satisfies TonPaymentDatabase, calls };
}

describe("TON invoice wrappers", () => {
  it("uses prepared values and preserves exact atomic strings for the SQL boundary", async () => {
    const invoice = { invoiceId: "00000000-0000-4000-8000-000000000003" };
    const { db, calls } = recordingDatabase([[{ id: org }], [], [{ result: invoice }]]);
    await expect(createTonInvoice(db, { actorUserId: actor, orgId: org }, input(), { allowlist: [asset] })).resolves.toEqual(invoice);
    expect(calls).toHaveLength(3);
    expect(calls[2]?.text).toContain("aiag_create_ton_invoice_v1($1::uuid,$2::uuid,$3::jsonb,$4::text)");
    expect(calls[2]?.values[0]).toBe(actor);
    expect(calls[2]?.values[1]).toBe(org);
    expect(calls[2]?.values[2]).toEqual(expect.stringContaining('"grantMicrocredits":"3"'));
    expect(calls[2]?.values[3]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects noncanonical or unsafe local inputs before issuing SQL", async () => {
    const { db, calls } = recordingDatabase();
    await expect(createTonInvoice(db, { actorUserId: actor, orgId: org }, { ...input(), grantMicrocredits: "03" }, { allowlist: [asset] })).rejects.toThrow("TON_INVALID_AMOUNT");
    await expect(createTonInvoice(db, { actorUserId: actor, orgId: org }, { ...input(), recipient: `0:${"1".repeat(64)}\n` }, { allowlist: [asset] })).rejects.toThrow("TON_INVALID_ADDRESS");
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["grantMicrocredits", "03"], ["grantMicrocredits", "9223372036854775808"],
    ["recipient", "not-an-address"], ["priceRevision", "x".repeat(17000)],
    ["quote.sourcePrice.unit", "rub_kopecks"], ["quote.sourcePrice.amountAtomic", "4"],
    ["quote.fx.sourceUnit", "rub_kopecks"], ["quote.fx.denominator", "0"],
    ["quote.fx.numerator", "9223372036854775807"], ["quote.fx.rounding", "bankers"],
    ["quote.additionalFeeAtomic", "-1"], ["quote.additionalFeeAtomic", "9223372036854775807"],
    ["quote.amountAtomic", "6"], ["quote.asset.decimals", 6], ["invoiceId", "client-chosen"],
  ])("rejects malformed %s without a mutating query", async (field, value) => {
    const { db, calls } = recordingDatabase([[{ id: org }], []]);
    const malformed = JSON.parse(JSON.stringify(input()));
    const parts = String(field).split(".");
    let target = malformed;
    for (const part of parts.slice(0, -1)) target = target[part];
    target[parts.at(-1)!] = value;
    await expect(createTonInvoice(db, { actorUserId: actor, orgId: org }, malformed, { allowlist: [asset] })).rejects.toThrow();
    expect(calls.every((call) => call.text.startsWith("SELECT id FROM"))).toBe(true);
  });

  it("validates credit shape before calling the settlement SQL entrypoint", async () => {
    const { db, calls } = recordingDatabase();
    await expect(settleTonInvoice(db, "00000000-0000-4000-8000-000000000003", {
      network: "tvm:-3", asset, recipient: `0:${"1".repeat(64)}`, recipientAccount: `0:${"1".repeat(64)}`, sender: `0:${"2".repeat(64)}`,
      amountAtomic: "1", reference: "r", txHash: "3".repeat(64), txLt: "1", messageHash: "4".repeat(64), messageIndex: 0,
      chainTimeMs: 2, observedAtMs: 1, verifiedAtMs: 3, blockAnchor: "b", masterchainAnchor: "m", executionPathDigest: "5".repeat(64), verifierVersion: "v", finalityPolicyId: "p", jettonCredit: null,
    })).rejects.toThrow("TON_INVALID_TIME_ORDER");
    expect(calls).toHaveLength(0);
  });
});
