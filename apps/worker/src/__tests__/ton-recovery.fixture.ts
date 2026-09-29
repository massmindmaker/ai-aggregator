import { createHash } from "node:crypto";
import { vi } from "vitest";
import type {
  TonInvoice,
  TonObservationInput,
  TonObservationResult,
} from "@aiag/database";
import native from "../__fixtures__/ton/synthetic-native-success.json";
import {
  normalizeCanonicalTonEvidence,
  TON_EVIDENCE_LIMITS,
} from "../ton-payment-evidence.js";
import {
  TON_VERIFIER_VERSION,
  TON_FINALITY_POLICY_ID,
} from "../ton-payment-verifier.js";
import type { TonObserveReconcilerDeps } from "../ton-payment-reconciler.js";
export const owner = "20000000-0000-4000-8000-000000000001";
export const address = "0:" + "1".repeat(64);
export function source() {
  return {
    sourceId: createHash("sha256")
      .update(
        'toncenter-v3-testnet\0{"decimals":9,"kind":"native","network":"tvm:-3"}\0' +
          address,
      )
      .digest("hex"),
    network: "tvm:-3" as const,
    asset: {
      network: "tvm:-3" as const,
      kind: "native" as const,
      decimals: 9 as const,
    },
    invoiceRecipient: address,
    scanFloorTimeMs: 1699999900000,
  };
}
export function evidence(
  lt = "1000",
  reference = "aiag-ton:10000000-0000-4000-8000-000000000001",
) {
  const e = structuredClone(native.evidence);
  e.transactions[0].lt = lt;
  e.transactions[0].inMessage.decodedPayload.reference = reference;
  const hash = createHash("sha256")
    .update("synthetic-transaction:" + lt)
    .digest("hex");
  e.transactions[0].hash = hash;
  e.trace.orderedTransactionHashes = [hash];
  e.creditPath.recipientTransactionHash = hash;
  const parsed = normalizeCanonicalTonEvidence(e, TON_EVIDENCE_LIMITS);
  if ("kind" in parsed) throw Error(parsed.code);
  return parsed;
}
export function invoice(): TonInvoice {
  const asset = source().asset;
  return {
    schemaVersion: 1,
    product: "aggregator",
    purpose: "gateway_topup",
    invoiceId: "10000000-0000-4000-8000-000000000001",
    ownerId: "10000000-0000-4000-8000-000000000002",
    orgId: "10000000-0000-4000-8000-000000000003",
    orderId: "10000000-0000-4000-8000-000000000004",
    idempotencyKey: "synthetic-native",
    quoteId: "synthetic-quote",
    quote: {
      schemaVersion: 1,
      quoteId: "synthetic-quote",
      sourcePrice: { unit: "gateway_microcredits", amountAtomic: "1000" },
      asset,
      fx: {
        sourceUnit: "gateway_microcredits",
        targetAsset: asset,
        numerator: "1000000000",
        denominator: "1000",
        rounding: "floor",
        source: "synthetic",
        observedAtMs: 1699999990000,
        expiresAtMs: 1700001000000,
      },
      additionalFeeAtomic: "0",
      amountAtomic: "1000000000",
      quotedAtMs: 1699999995000,
      expiresAtMs: 1700001000000,
    },
    grantMicrocredits: "1000",
    priceRevision: "synthetic-v1",
    network: "tvm:-3",
    asset,
    amountAtomic: "1000000000",
    recipient: address,
    reference: "aiag-ton:10000000-0000-4000-8000-000000000001",
    expectedSender: "0:" + "2".repeat(64),
    finalityPolicyId: TON_FINALITY_POLICY_ID,
    verifierVersion: TON_VERIFIER_VERSION,
    expiresAt: "2023-11-14T22:30:00.000Z",
    createdAt: "2023-11-14T22:00:00.000Z",
    status: "pending",
    reviewReason: null,
  };
}
export function cursor(lt = "1000", upper = "1000") {
  return {
    schemaVersion: 1 as const,
    beforeLt: lt,
    beforeTransactionHash: evidence(lt).transactions[0].hash,
    cycleUpperLt: upper,
  };
}
export function fixture() {
  const events: string[] = [],
    observations: TonObservationInput[] = [];
  const committed = new Map<string, string>();
  const deps = {
    newLeaseOwner: () => owner,
    getInvoice: vi.fn(async () => invoice()),
    listSources: vi.fn(async () => [source()]),
    findInvoices: vi.fn(async () => {
      events.push("find");
      return [invoice()];
    }),
    provider: {
      resolveRecipientAccount: vi.fn(async () => {
        events.push("resolve");
        return { kind: "resolved" as const, recipientAccount: address };
      }),
      scanAccountPage: vi.fn(async () => {
        events.push("scan");
        return {
          kind: "page" as const,
          evidence: [evidence()],
          nextCursor: null,
          exhausted: true,
        };
      }),
    },
    claimLease: vi.fn(async () => {
      events.push("claim");
      return { kind: "claimed" as const, cursor: null, binding: null };
    }),
    bindRecipient: vi.fn(async () => {
      events.push("bind");
      return "bound" as const;
    }),
    renewLease: vi.fn(async () => {
      events.push("renew");
      return "renewed" as const;
    }),
    recordObservation: vi.fn(
      async (input: TonObservationInput): Promise<TonObservationResult> => {
        events.push("observe");
        observations.push(input);
        const key = JSON.stringify({ ...input, observedAtMs: 0 });
        let id = committed.get(key);
        const outcome = id ? "already_recorded" : "inserted";
        if (!id) {
          id =
            "30000000-0000-4000-8000-" +
            String(committed.size + 1).padStart(12, "0");
          committed.set(key, id);
        }
        return {
          observationId: id,
          outcome,
          invoiceStatus: input.invoiceId ? "observed" : null,
        };
      },
    ),
    advanceCursor: vi.fn(async () => {
      events.push("advance");
      return "advanced" as const;
    }),
    releaseLease: vi.fn(async () => {
      events.push("release");
      return "released" as const;
    }),
  } satisfies TonObserveReconcilerDeps;
  return { deps, events, observations, committed };
}
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
export const input = () => ({
  source: source(),
  limit: 16,
  signal: new AbortController().signal,
});
