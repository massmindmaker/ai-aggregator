import { createHash } from "node:crypto";
import type {
  TonInvoice,
  TonProviderCursor,
  TonReconciliationSource,
  TonRecipientBinding,
  TonObservationResult,
  TonSourceErrorCode,
} from "@aiag/database";
import {
  TON_PROVIDER_ID,
  TON_EVIDENCE_LIMITS,
  normalizeCanonicalTonEvidence,
  type NormalizedTonEvidence,
} from "./ton-payment-evidence.js";
import type { TonProviderResult } from "./ton-payment-provider.js";
export class TonSourceFailure extends Error {
  constructor(readonly code: TonSourceErrorCode) {
    super(code);
  }
}
export function object(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw Error("TON_INVALID_OBJECT");
  return value as Record<string, unknown>;
}
export function exact(
  value: Record<string, unknown>,
  names: readonly string[],
) {
  if (
    Object.keys(value).length !== names.length ||
    Object.keys(value).some((k) => !names.includes(k))
  )
    throw Error("TON_INVALID_KEYS");
}
export function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw Error("TON_INVALID_HASH");
  return value;
}
export function uuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      value,
    )
  )
    throw Error("TON_INVALID_ID");
  return value;
}
export function nativeSource(value: unknown): TonReconciliationSource {
  const r = object(value);
  exact(r, [
    "sourceId",
    "network",
    "asset",
    "invoiceRecipient",
    "scanFloorTimeMs",
  ]);
  const a = object(r.asset);
  exact(a, ["network", "kind", "decimals"]);
  if (
    r.network !== "tvm:-3" ||
    a.network !== "tvm:-3" ||
    a.kind !== "native" ||
    a.decimals !== 9 ||
    typeof r.invoiceRecipient !== "string" ||
    !/^(?:0|-1):[a-f0-9]{64}$/.test(r.invoiceRecipient) ||
    !Number.isSafeInteger(r.scanFloorTimeMs) ||
    (r.scanFloorTimeMs as number) < 0
  )
    throw Error("TON_SOURCE_IDENTITY");
  const id = createHash("sha256")
    .update(
      TON_PROVIDER_ID +
        '\0{"decimals":9,"kind":"native","network":"tvm:-3"}\0' +
        r.invoiceRecipient,
    )
    .digest("hex");
  if (hash(r.sourceId) !== id) throw Error("TON_SOURCE_IDENTITY");
  return {
    sourceId: id,
    network: "tvm:-3",
    asset: { network: "tvm:-3", kind: "native", decimals: 9 },
    invoiceRecipient: r.invoiceRecipient,
    scanFloorTimeMs: r.scanFloorTimeMs as number,
  };
}
export function sourceForInvoice(invoice: TonInvoice): TonReconciliationSource {
  const sourceId = createHash("sha256")
    .update(
      TON_PROVIDER_ID +
        '\0{"decimals":9,"kind":"native","network":"tvm:-3"}\0' +
        invoice.recipient,
    )
    .digest("hex");
  return nativeSource({
    sourceId,
    network: invoice.network,
    asset: invoice.asset,
    invoiceRecipient: invoice.recipient,
    scanFloorTimeMs: 0,
  });
}
export function cursor(value: unknown): TonProviderCursor | null {
  if (value === null) return null;
  const r = object(value);
  exact(r, [
    "schemaVersion",
    "beforeLt",
    "beforeTransactionHash",
    "cycleUpperLt",
  ]);
  if (
    r.schemaVersion !== 1 ||
    typeof r.beforeLt !== "string" ||
    typeof r.cycleUpperLt !== "string" ||
    !/^(?:0|[1-9][0-9]{0,77})$/.test(r.beforeLt) ||
    !/^(?:0|[1-9][0-9]{0,77})$/.test(r.cycleUpperLt) ||
    BigInt(r.beforeLt) > BigInt(r.cycleUpperLt)
  )
    throw Error("TON_INVALID_CURSOR");
  return {
    schemaVersion: 1,
    beforeLt: r.beforeLt,
    beforeTransactionHash: hash(r.beforeTransactionHash),
    cycleUpperLt: r.cycleUpperLt,
  };
}
export function binding(
  value: unknown,
  s: TonReconciliationSource,
): TonRecipientBinding | null {
  if (value === null) return null;
  const r = object(value);
  exact(r, ["recipientAccount", "derivation"]);
  const d = object(r.derivation);
  exact(d, ["kind", "ownerAddress"]);
  if (
    r.recipientAccount !== s.invoiceRecipient ||
    d.kind !== "native" ||
    d.ownerAddress !== s.invoiceRecipient
  )
    throw new TonSourceFailure("recipient_binding_changed");
  return {
    recipientAccount: s.invoiceRecipient,
    derivation: { kind: "native", ownerAddress: s.invoiceRecipient },
  };
}
export const SOURCE_ERRORS: ReadonlySet<string> = new Set([
  "origin_mismatch",
  "redirect_rejected",
  "response_too_large",
  "http_unauthorized",
  "rate_limited",
  "timeout",
  "upstream_5xx",
  "provider_schema_invalid",
  "pagination_regressed",
  "recipient_binding_changed",
  "unsupported_asset",
]);
export function sourceError(
  value: unknown,
): Extract<TonProviderResult, { kind: "source_error" }> {
  const r = object(value);
  exact(r, ["kind", "code", "retryAfterMs"]);
  if (
    r.kind !== "source_error" ||
    !SOURCE_ERRORS.has(String(r.code)) ||
    (r.retryAfterMs !== null &&
      (!Number.isSafeInteger(r.retryAfterMs) ||
        (r.retryAfterMs as number) < 0 ||
        r.code !== "rate_limited"))
  )
    throw new TonSourceFailure("provider_schema_invalid");
  return {
    kind: "source_error",
    code: r.code as TonSourceErrorCode,
    retryAfterMs:
      r.retryAfterMs === null
        ? null
        : Math.max(1000, Math.min(900000, r.retryAfterMs as number)),
  };
}
export function creditCandidate(e: NormalizedTonEvidence) {
  if (
    e.network !== "tvm:-3" ||
    e.asset.kind !== "native" ||
    e.creditPath.kind !== "native"
  )
    throw new TonSourceFailure("unsupported_asset");
  const tx = e.transactions.find(
    (t) =>
      t.hash ===
      (e.creditPath as { recipientTransactionHash: string })
        .recipientTransactionHash,
  );
  if (!tx || tx.inMessage.hash !== e.creditPath.creditMessageHash)
    throw new TonSourceFailure("provider_schema_invalid");
  const payload = tx.inMessage.decodedPayload;
  return {
    tx,
    event: { txHash: tx.hash, txLt: tx.lt, messageHash: tx.inMessage.hash },
    reference: payload.kind === "native_comment" ? payload.reference : null,
  };
}
export function providerPage(
  value: unknown,
  previous: TonProviderCursor | null,
  account: string,
): Extract<TonProviderResult, { kind: "page" }> {
  try {
    const p = object(value);
    exact(p, ["kind", "evidence", "nextCursor", "exhausted"]);
    if (
      p.kind !== "page" ||
      !Array.isArray(p.evidence) ||
      p.evidence.length > 8 ||
      typeof p.exhausted !== "boolean"
    )
      throw new TonSourceFailure("provider_schema_invalid");
    const next = cursor(p.nextCursor);
    if (p.exhausted !== (next === null) || (!p.evidence.length && !p.exhausted))
      throw new TonSourceFailure("pagination_regressed");
    const evidence = p.evidence.map((item) => {
      const e = normalizeCanonicalTonEvidence(item, TON_EVIDENCE_LIMITS);
      if ("kind" in e) throw new TonSourceFailure(e.code);
      return e;
    });
    let lt = previous ? BigInt(previous.beforeLt) : null;
    const seen = new Set<string>();
    for (const e of evidence) {
      const c = creditCandidate(e),
        number = BigInt(c.tx.lt);
      if (c.tx.account !== account)
        throw new TonSourceFailure("recipient_binding_changed");
      if (
        (lt !== null && number >= lt) ||
        seen.has(c.tx.hash) ||
        (previous && number > BigInt(previous.cycleUpperLt))
      )
        throw new TonSourceFailure("pagination_regressed");
      seen.add(c.tx.hash);
      lt = number;
    }
    if (next && evidence.length) {
      const first = creditCandidate(evidence[0]).tx,
        last = creditCandidate(evidence[evidence.length - 1]).tx;
      if (
        next.beforeLt !== last.lt ||
        next.beforeTransactionHash !== last.hash ||
        next.cycleUpperLt !== (previous?.cycleUpperLt ?? first.lt)
      )
        throw new TonSourceFailure("pagination_regressed");
    }
    return { kind: "page", evidence, nextCursor: next, exhausted: p.exhausted };
  } catch (error) {
    if (error instanceof TonSourceFailure) throw error;
    throw new TonSourceFailure("provider_schema_invalid");
  }
}
export function observedAck(value: unknown) {
  const r = object(value);
  exact(r, ["observationId", "outcome", "invoiceStatus"]);
  uuid(r.observationId);
  if (
    !["inserted", "already_recorded"].includes(String(r.outcome)) ||
    !(
      r.invoiceStatus === null ||
      [
        "pending",
        "observed",
        "confirmed",
        "settled",
        "expired",
        "review_required",
      ].includes(String(r.invoiceStatus))
    )
  )
    throw Error("TON_INVALID_OBSERVATION_ACK");
  return value as TonObservationResult;
}
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const r = value as Record<string, unknown>;
    return (
      "{" +
      Object.keys(r)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + stableJson(r[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}
export function evidenceDigest(e: NormalizedTonEvidence) {
  return createHash("sha256").update(stableJson(e)).digest("hex");
}
