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
import { TON_JETTON_REFERENCE } from "./ton-jetton-evidence.js";
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
/**
 * Canonical asset literal used by the source-id hash — MUST byte-match the
 * SQL canonicalizer `aiag_ton_reconciliation_source_id_v1` (migration 0109):
 * alphabetical key order, lowercase raw addresses.
 */
export function assetLiteral(
  asset: TonReconciliationSource["asset"],
): string {
  if (asset.kind === "native") {
    return `{"decimals":9,"kind":"native","network":"${asset.network}"}`;
  }
  return `{"decimals":${asset.decimals},"kind":"jetton","masterAddress":"${asset.masterAddress}","network":"${asset.network}"}`;
}

function sourceIdentity(network: unknown): {
  network: "tvm:-3" | "tvm:-1";
  providerId: "toncenter-v3-testnet" | "toncenter-v3-mainnet";
} {
  return network === "tvm:-1"
    ? { network: "tvm:-1", providerId: "toncenter-v3-mainnet" }
    : { network: "tvm:-3", providerId: "toncenter-v3-testnet" };
}

/** General (native + jetton) reconciliation-source parser (migration 0109 contract). */
export function reconciliationSource(
  value: unknown,
): TonReconciliationSource {
  const r = object(value);
  exact(r, [
    "sourceId",
    "network",
    "asset",
    "invoiceRecipient",
    "scanFloorTimeMs",
  ]);
  const identity = sourceIdentity(r.network);
  if (
    r.network !== identity.network ||
    typeof r.invoiceRecipient !== "string" ||
    !/^(?:0|-1):[a-f0-9]{64}$/.test(r.invoiceRecipient) ||
    !Number.isSafeInteger(r.scanFloorTimeMs) ||
    (r.scanFloorTimeMs as number) < 0
  )
    throw Error("TON_SOURCE_IDENTITY");
  const a = object(r.asset);
  let asset: TonReconciliationSource["asset"];
  if (a.kind === "native") {
    exact(a, ["network", "kind", "decimals"]);
    if (a.network !== identity.network || a.decimals !== 9)
      throw Error("TON_SOURCE_IDENTITY");
    asset = { network: identity.network, kind: "native", decimals: 9 };
  } else if (a.kind === "jetton") {
    exact(a, ["network", "kind", "decimals", "masterAddress"]);
    if (
      a.network !== identity.network ||
      !Number.isSafeInteger(a.decimals) ||
      (a.decimals as number) < 0 ||
      (a.decimals as number) > 18 ||
      typeof a.masterAddress !== "string" ||
      !/^(?:0|-1):[a-f0-9]{64}$/.test(a.masterAddress)
    )
      throw Error("TON_SOURCE_IDENTITY");
    asset = {
      network: identity.network,
      kind: "jetton",
      masterAddress: a.masterAddress,
      decimals: a.decimals as number,
    };
  } else {
    throw Error("TON_SOURCE_IDENTITY");
  }
  const id = createHash("sha256")
    .update(
      identity.providerId + `\0${assetLiteral(asset)}\0` + r.invoiceRecipient,
    )
    .digest("hex");
  if (hash(r.sourceId) !== id) throw Error("TON_SOURCE_IDENTITY");
  return {
    sourceId: id,
    network: identity.network,
    asset,
    invoiceRecipient: r.invoiceRecipient,
    scanFloorTimeMs: r.scanFloorTimeMs as number,
  };
}

/** Native-only narrow view kept for call sites that must never see jettons. */
export function nativeSource(value: unknown): TonReconciliationSource {
  const source = reconciliationSource(value);
  if (source.asset.kind !== "native") throw Error("TON_SOURCE_IDENTITY");
  return source;
}
export function sourceForInvoice(invoice: TonInvoice): TonReconciliationSource {
  const providerId =
    invoice.network === "tvm:-1"
      ? "toncenter-v3-mainnet"
      : "toncenter-v3-testnet";
  const sourceId = createHash("sha256")
    .update(
      providerId + `\0${assetLiteral(invoice.asset)}\0` + invoice.recipient,
    )
    .digest("hex");
  return reconciliationSource({
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
  if (
    r.recipientAccount !== s.invoiceRecipient ||
    d.ownerAddress !== s.invoiceRecipient
  )
    throw new TonSourceFailure("recipient_binding_changed");
  if (d.kind === "native") {
    exact(d, ["kind", "ownerAddress"]);
    if (s.asset.kind !== "native")
      throw new TonSourceFailure("recipient_binding_changed");
    return {
      recipientAccount: s.invoiceRecipient,
      derivation: { kind: "native", ownerAddress: s.invoiceRecipient },
    };
  }
  if (d.kind === "jetton") {
    exact(d, ["kind", "masterAddress", "ownerAddress"]);
    if (
      s.asset.kind !== "jetton" ||
      d.masterAddress !== s.asset.masterAddress ||
      typeof d.masterAddress !== "string" ||
      !/^(?:0|-1):[a-f0-9]{64}$/.test(d.masterAddress)
    )
      throw new TonSourceFailure("recipient_binding_changed");
    return {
      recipientAccount: s.invoiceRecipient,
      derivation: {
        kind: "jetton",
        masterAddress: d.masterAddress,
        ownerAddress: s.invoiceRecipient,
      },
    };
  }
  throw new TonSourceFailure("recipient_binding_changed");
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
  if (e.network !== "tvm:-3" && e.network !== "tvm:-1")
    throw new TonSourceFailure("unsupported_asset");
  if (e.asset.kind === "native" && e.creditPath.kind === "native") {
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
      owner: tx.account,
      event: { txHash: tx.hash, txLt: tx.lt, messageHash: tx.inMessage.hash },
      reference: payload.kind === "native_comment" ? payload.reference : null,
    };
  }
  if (e.asset.kind === "jetton" && e.creditPath.kind === "jetton") {
    // The credit transaction lives on the merchant's jetton wallet; the
    // invoice reference rides the transfer_notification message it emits.
    // Local alias keeps the union narrowed inside the find() closures below.
    const creditPath = e.creditPath;
    const tx = e.transactions.find(
      (t) => t.hash === creditPath.creditTransactionHash,
    );
    if (
      !tx ||
      tx.inMessage.hash !== creditPath.internalTransferMessageHash ||
      tx.inMessage.decodedPayload.kind !== "jetton_internal_transfer"
    )
      throw new TonSourceFailure("provider_schema_invalid");
    const notification = tx.outMessages.find(
      (m) => m.hash === creditPath.notificationMessageHash,
    );
    if (
      !notification ||
      notification.decodedPayload.kind !== "jetton_notification"
    )
      throw new TonSourceFailure("provider_schema_invalid");
    return {
      tx,
      owner: creditPath.walletDerivationOwner,
      event: { txHash: tx.hash, txLt: tx.lt, messageHash: tx.inMessage.hash },
      // Gate the raw forward text to the canonical reference shape here: a
      // foreign comment ("thanks") is a valid chain fact that must surface as
      // a NULL reference (unmatched path), never as a junk invoice lookup.
      reference:
        notification.decodedPayload.forwardReference &&
        TON_JETTON_REFERENCE.test(notification.decodedPayload.forwardReference)
          ? notification.decodedPayload.forwardReference
          : null,
    };
  }
  throw new TonSourceFailure("unsupported_asset");
}
export function providerPage(
  value: unknown,
  previous: TonProviderCursor | null,
  source: TonReconciliationSource,
  preset: import("./ton-payment-evidence.js").TonPreset,
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
      const e = normalizeCanonicalTonEvidence(item, TON_EVIDENCE_LIMITS, preset);
      if ("kind" in e) throw new TonSourceFailure(e.code);
      return e;
    });
    let lt = previous ? BigInt(previous.beforeLt) : null;
    const seen = new Set<string>();
    for (const e of evidence) {
      const c = creditCandidate(e),
        number = BigInt(c.tx.lt);
      // Native credits land on the merchant wallet account; jetton credits on
      // the derived jetton wallet — the OWNER binding is the invariant both
      // kinds share.
      if (c.owner !== source.invoiceRecipient)
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
