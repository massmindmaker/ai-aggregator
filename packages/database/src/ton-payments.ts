/** Server-only invoice core. No environment, database singleton or network imports. */
import { createHash } from "node:crypto";
import {
  createQuote,
  normalizeAsset,
  toDatabaseAtomic,
} from "@aiag/shared/ton-payment-contract";
import type { TonQuote } from "@aiag/shared/ton-payment-contract";
import type {
  CreateTonInvoiceInput,
  TonInvoiceContext,
  TonPaymentDatabase,
  TonServerPolicy,
  TonInvoice,
  VerifiedChainCredit,
  TonSettlementResult,
  TonSourceErrorCode,
  TonProviderCursor,
  TonSweepCursor,
  TonRecipientBinding,
  TonReconciliationSource,
  TonObservationInput,
  TonObservationResult,
} from "./ton-payment-types";
const full = (pattern: string) => new RegExp(`^(?:${pattern})(?![\\s\\S])`);
const UUID = full(
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
);
function id(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value))
    throw new Error("TON_INVALID_ID");
  return value.toLowerCase();
}
function label(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 96 ||
    value.trim() !== value ||
    /[\r\n\x00-\x1f]/.test(value)
  )
    throw new Error("TON_INVALID_LABEL");
  return value;
}
function atomic(value: unknown, zero = false, boundedOnly = false): string {
  if (
    typeof value !== "string" ||
    value.length > 78 ||
    !full("0|[1-9][0-9]*").test(value) ||
    (!zero && value === "0")
  )
    throw new Error("TON_INVALID_AMOUNT");
  if (!boundedOnly) toDatabaseAtomic(BigInt(value), zero);
  return value;
}
function time(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 8640000000000000
  )
    throw new Error("TON_INVALID_TIME");
  return value;
}
function address(value: unknown): string {
  if (
    typeof value !== "string" ||
    !full("(?:0|-1):[0-9a-fA-F]{64}").test(value)
  )
    throw new Error("TON_INVALID_ADDRESS");
  return value.toLowerCase();
}
function object(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error("TON_INVALID_OBJECT");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[]) {
  if (
    Object.keys(value).some((k) => !expected.includes(k)) ||
    expected.some((k) => !(k in value))
  )
    throw new Error("TON_INVALID_FIELDS");
}
/** Stable JSON bytes for SHA; JSONB equality is also required by SQL. */
function stable(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
function quote(value: unknown): TonQuote {
  const q = object(value);
  keys(q, [
    "schemaVersion",
    "quoteId",
    "sourcePrice",
    "asset",
    "fx",
    "additionalFeeAtomic",
    "expiresAtMs",
    "amountAtomic",
    "quotedAtMs",
  ]);
  if (q.schemaVersion !== 1) throw new Error("TON_INVALID_VERSION");
  const source = object(q.sourcePrice),
    fx = object(q.fx);
  keys(source, ["unit", "amountAtomic"]);
  keys(fx, [
    "sourceUnit",
    "targetAsset",
    "numerator",
    "denominator",
    "rounding",
    "source",
    "observedAtMs",
    "expiresAtMs",
  ]);
  if (
    source.unit !== "gateway_microcredits" ||
    fx.sourceUnit !== "gateway_microcredits" ||
    !["floor", "ceil", "half-up"].includes(fx.rounding as string)
  )
    throw new Error("TON_INVALID_UNITS");
  return {
    schemaVersion: 1,
    quoteId: label(q.quoteId),
    sourcePrice: {
      unit: "gateway_microcredits",
      amountAtomic: atomic(source.amountAtomic),
    },
    asset: normalizeAsset(q.asset),
    fx: {
      sourceUnit: "gateway_microcredits",
      targetAsset: normalizeAsset(fx.targetAsset),
      numerator: atomic(fx.numerator),
      denominator: atomic(fx.denominator),
      rounding: fx.rounding as TonQuote["fx"]["rounding"],
      source: label(fx.source),
      observedAtMs: time(fx.observedAtMs),
      expiresAtMs: time(fx.expiresAtMs),
    },
    additionalFeeAtomic: atomic(q.additionalFeeAtomic, true),
    expiresAtMs: time(q.expiresAtMs),
    amountAtomic: atomic(q.amountAtomic),
    quotedAtMs: time(q.quotedAtMs),
  };
}
function payload(ctx: TonInvoiceContext, input: CreateTonInvoiceInput) {
  const raw = object(input);
  keys(raw, [
    "idempotencyKey",
    "grantMicrocredits",
    "priceRevision",
    "quote",
    "recipient",
    "expectedSender",
    "finalityPolicyId",
    "verifierVersion",
  ]);
  if (
    typeof input.idempotencyKey !== "string" ||
    !full("[A-Za-z0-9_-]{1,96}").test(input.idempotencyKey)
  )
    throw new Error("TON_INVALID_KEY");
  const q = quote(input.quote),
    grant = atomic(input.grantMicrocredits);
  if (q.sourcePrice.amountAtomic !== grant)
    throw new Error("TON_INVALID_GRANT_BINDING");
  return {
    schemaVersion: 1,
    purpose: "gateway_topup",
    ownerId: id(ctx.actorUserId),
    orgId: id(ctx.orgId),
    idempotencyKey: input.idempotencyKey,
    grantMicrocredits: grant,
    priceRevision: label(input.priceRevision),
    quote: q,
    recipient: address(input.recipient),
    expectedSender:
      input.expectedSender === null ? null : address(input.expectedSender),
    finalityPolicyId: label(input.finalityPolicyId),
    verifierVersion: label(input.verifierVersion),
  };
}
export async function createTonInvoice(
  db: TonPaymentDatabase,
  ctx: TonInvoiceContext,
  input: CreateTonInvoiceInput,
  policy: TonServerPolicy,
): Promise<TonInvoice> {
  const p = payload(ctx, input),
    serialized = stable(p),
    fingerprint = createHash("sha256").update(serialized).digest("hex");
  if (Buffer.byteLength(serialized) > 16384)
    throw new Error("TON_PAYLOAD_TOO_LARGE");
  return db.transaction(async (tx) => {
    const owner = await tx.query({
      text: "SELECT id FROM organizations WHERE id=$1::uuid AND owner_id=$2::uuid FOR UPDATE",
      values: [p.orgId, p.ownerId],
    });
    if (owner.rowCount !== 1) throw new Error("TON_NOT_AUTHORIZED");
    const existing = await tx.query({
      text: "SELECT id FROM ton_invoices WHERE owner_user_id=$1::uuid AND org_id=$2::uuid AND idempotency_key=$3",
      values: [p.ownerId, p.orgId, p.idempotencyKey],
    });
    // Persisted replay precedes all mutable configuration. SQL compares hash AND payload.
    if (
      existing.rowCount === 0 &&
      stable(createQuote(p.quote, policy.allowlist, p.quote.quotedAtMs)) !==
        stable(p.quote)
    )
      throw new Error("TON_QUOTE_MISMATCH");
    const result = await tx.query<{ result: TonInvoice }>({
      text: "SELECT aiag_create_ton_invoice_v1($1::uuid,$2::uuid,$3::jsonb,$4::text) AS result",
      values: [p.ownerId, p.orgId, serialized, fingerprint],
    });
    return result.rows[0]!.result;
  });
}
export async function getTonInvoice(
  db: TonPaymentDatabase,
  ctx: TonInvoiceContext,
  invoiceId: string,
): Promise<TonInvoice | null> {
  const actor = id(ctx.actorUserId),
    org = id(ctx.orgId),
    invoice = id(invoiceId);
  return db.transaction(
    async (tx) =>
      (
        await tx.query<{ result: TonInvoice | null }>({
          text: "SELECT aiag_read_ton_invoice_v1($1::uuid,$2::uuid,$3::uuid) AS result",
          values: [actor, org, invoice],
        })
      ).rows[0]!.result,
  );
}
export async function expireTonInvoice(
  db: TonPaymentDatabase,
  invoiceId: string,
): Promise<"expired" | "unchanged" | "not_found"> {
  const invoice = id(invoiceId);
  return db.transaction(
    async (tx) =>
      (
        await tx.query<{ result: "expired" | "unchanged" | "not_found" }>({
          text: "SELECT aiag_expire_ton_invoice_v1($1::uuid) AS result",
          values: [invoice],
        })
      ).rows[0]!.result,
  );
}
/** Bounded batch expiry for the worker cron (0100); returns the transitioned count. */
export async function expireStaleTonInvoices(
  db: TonPaymentDatabase,
  limit: number,
): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("TON_EXPIRY_LIMIT_INVALID");
  }
  return db.transaction(
    async (tx) =>
      (
        await tx.query<{ result: number }>({
          text: "SELECT aiag_expire_stale_ton_invoices_v1($1::integer) AS result",
          values: [limit],
        })
      ).rows[0]!.result,
  );
}
function credit(input: VerifiedChainCredit) {
  const c = object(input);
  keys(c, [
    "network",
    "asset",
    "recipient",
    "recipientAccount",
    "sender",
    "amountAtomic",
    "reference",
    "txHash",
    "txLt",
    "messageHash",
    "messageIndex",
    "chainTimeMs",
    "observedAtMs",
    "verifiedAtMs",
    "blockAnchor",
    "masterchainAnchor",
    "executionPathDigest",
    "verifierVersion",
    "finalityPolicyId",
    "jettonCredit",
  ]);
  if (c.network !== "tvm:-3" && c.network !== "tvm:-1") throw new Error("TON_INVALID_NETWORK");
  const asset = normalizeAsset(c.asset);
  const hash = (v: unknown) => {
    if (typeof v !== "string" || !full("[0-9a-fA-F]{64}").test(v))
      throw new Error("TON_INVALID_HASH");
    return v.toLowerCase();
  };
  if (
    typeof c.messageIndex !== "number" ||
    !Number.isInteger(c.messageIndex) ||
    c.messageIndex < 0 ||
    c.messageIndex > 2147483647
  )
    throw new Error("TON_INVALID_INDEX");
  let jettonCredit = null;
  if (asset.kind === "jetton") {
    const j = object(c.jettonCredit);
    keys(j, ["masterAddress", "merchantJettonWallet"]);
    jettonCredit = {
      masterAddress: address(j.masterAddress),
      merchantJettonWallet: address(j.merchantJettonWallet),
    };
  } else if (c.jettonCredit !== null) throw new Error("TON_INVALID_JETTON");
  return {
    network: c.network,
    asset,
    recipient: address(c.recipient),
    recipientAccount: address(c.recipientAccount),
    sender: address(c.sender),
    amountAtomic: atomic(c.amountAtomic, false, true),
    reference: label(c.reference),
    txHash: hash(c.txHash),
    txLt: atomic(c.txLt, true, true),
    messageHash: hash(c.messageHash),
    messageIndex: c.messageIndex,
    chainTimeMs: time(c.chainTimeMs),
    observedAtMs: time(c.observedAtMs),
    verifiedAtMs: time(c.verifiedAtMs),
    blockAnchor: label(c.blockAnchor),
    masterchainAnchor: label(c.masterchainAnchor),
    executionPathDigest: hash(c.executionPathDigest),
    verifierVersion: label(c.verifierVersion),
    finalityPolicyId: label(c.finalityPolicyId),
    jettonCredit,
  };
}
async function runTonSettlement(
  db: TonPaymentDatabase,
  invoiceId: string,
  input: VerifiedChainCredit,
  workerBoundary: boolean,
): Promise<TonSettlementResult> {
  const invoice = id(invoiceId),
    c = credit(input);
  if (workerBoundary && c.asset.kind !== "native")
    throw new Error("TON_SETTLEMENT_ASSET_UNSUPPORTED");
  if (c.chainTimeMs > c.observedAtMs || c.observedAtMs > c.verifiedAtMs)
    throw new Error("TON_INVALID_TIME_ORDER");
  return db.transaction(
    async (tx) =>
      (
        await tx.query<{ result: TonSettlementResult }>({
          text: workerBoundary
            ? "SELECT aiag_ton_worker.settle_invoice_v1($1::uuid,$2::jsonb) AS result"
            : "SELECT aiag_settle_ton_invoice_v1($1::uuid,$2::jsonb) AS result",
          values: [invoice, stable(c)],
        })
      ).rows[0]!.result,
  );
}

export function settleTonInvoice(
  db: TonPaymentDatabase,
  invoiceId: string,
  input: VerifiedChainCredit,
): Promise<TonSettlementResult> {
  return runTonSettlement(db, invoiceId, input, false);
}
/** Separate authority: no fallback to the legacy core if worker credentials/installation fail. */
export function settleTonInvoiceAsWorker(
  db: TonPaymentDatabase,
  invoiceId: string,
  input: VerifiedChainCredit,
): Promise<TonSettlementResult> {
  return runTonSettlement(db, invoiceId, input, true);
}

const TON_PROVIDER_ID = "toncenter-v3-testnet" as const;
const TON_EVIDENCE_MODEL = "server_trusted_indexer" as const;
const SOURCE_ID = full("[0-9a-f]{64}");
const CANONICAL_REFERENCE = full(
  "aiag-ton:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
);
const SOURCE_ERRORS = new Set<TonSourceErrorCode>([
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
const OBSERVED_REASONS = new Set([
  "candidate_not_found",
  "trace_incomplete",
  "finality_pending",
]);
const REVIEW_REASONS = new Set([
  "network_mismatch",
  "policy_mismatch",
  "trace_oversized",
  "trace_emulated",
  "trace_aborted",
  "trace_bounced",
  "trace_failed",
  "message_linkage_invalid",
  "inclusion_mismatch",
  "asset_mismatch",
  "recipient_mismatch",
  "sender_mismatch",
  "reference_mismatch",
  "amount_mismatch",
  "jetton_master_mismatch",
  "jetton_wallet_mismatch",
  "jetton_notification_invalid",
  "settlement_evidence_conflict",
]);
const INVOICE_STATUSES = new Set<TonInvoice["status"]>([
  "pending",
  "observed",
  "confirmed",
  "settled",
  "expired",
  "review_required",
]);

function canonicalId(value: unknown): string {
  const result = id(value);
  if (result !== value) throw new Error("TON_INVALID_ID");
  return result;
}

function canonicalAddress(value: unknown): string {
  const result = address(value);
  if (result !== value) throw new Error("TON_INVALID_ADDRESS");
  return result;
}

function lowerHash(value: unknown, code = "TON_INVALID_HASH"): string {
  if (typeof value !== "string" || !SOURCE_ID.test(value))
    throw new Error(code);
  return value;
}

function canonicalJson(value: unknown): string {
  const visit = (current: unknown): string => {
    if (current === null) return "null";
    if (typeof current === "string" || typeof current === "boolean")
      return JSON.stringify(current);
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error("TON_INVALID_JSON");
      return JSON.stringify(current);
    }
    if (Array.isArray(current)) return `[${current.map(visit).join(",")}]`;
    if (
      typeof current !== "object" ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(current))
    )
      throw new Error("TON_INVALID_JSON");
    const record = current as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${visit(record[key])}`)
      .join(",")}}`;
  };
  return visit(value);
}

function normalizeCursor(value: unknown): TonProviderCursor {
  const raw = object(value);
  keys(raw, [
    "schemaVersion",
    "beforeLt",
    "beforeTransactionHash",
    "cycleUpperLt",
  ]);
  if (raw.schemaVersion !== 1) throw new Error("TON_INVALID_CURSOR");
  const beforeLt = atomic(raw.beforeLt, true, true);
  const cycleUpperLt = atomic(raw.cycleUpperLt, true, true);
  if (BigInt(beforeLt) > BigInt(cycleUpperLt))
    throw new Error("TON_INVALID_CURSOR");
  return {
    schemaVersion: 1,
    beforeLt,
    beforeTransactionHash: lowerHash(
      raw.beforeTransactionHash,
      "TON_INVALID_CURSOR",
    ),
    cycleUpperLt,
  };
}

function nullableCursor(value: unknown): TonProviderCursor | null {
  return value === null ? null : normalizeCursor(value);
}

function normalizeSource(value: unknown): TonReconciliationSource {
  const raw = object(value);
  keys(raw, [
    "sourceId",
    "network",
    "asset",
    "invoiceRecipient",
    "scanFloorTimeMs",
  ]);
  // Source identity pairs each network with its canonical provider id
  // (tvm:-3 → toncenter-v3-testnet, tvm:-1 → toncenter-v3-mainnet).
  const identity: { network: "tvm:-3" | "tvm:-1"; providerId: string } =
    raw.network === "tvm:-1"
      ? { network: "tvm:-1", providerId: "toncenter-v3-mainnet" }
      : { network: "tvm:-3", providerId: "toncenter-v3-testnet" };
  if (raw.network !== identity.network)
    throw new Error("TON_INVALID_NETWORK");
  const rawAsset = object(raw.asset);
  keys(rawAsset, ["decimals", "kind", "network"]);
  if (
    rawAsset.network !== identity.network ||
    rawAsset.kind !== "native" ||
    rawAsset.decimals !== 9
  )
    throw new Error("TON_INVALID_ASSET");
  const invoiceRecipient = canonicalAddress(raw.invoiceRecipient);
  const sourceId = lowerHash(raw.sourceId, "TON_INVALID_SOURCE");
  const expected = createHash("sha256")
    .update(
      `${identity.providerId}\0{"decimals":9,"kind":"native","network":"${identity.network}"}\0${invoiceRecipient}`,
    )
    .digest("hex");
  if (sourceId !== expected) throw new Error("TON_INVALID_SOURCE");
  return {
    sourceId,
    network: identity.network,
    asset: { decimals: 9, kind: "native", network: identity.network },
    invoiceRecipient,
    scanFloorTimeMs: time(raw.scanFloorTimeMs),
  };
}

function normalizeBinding(
  value: unknown,
  source: TonReconciliationSource,
): TonRecipientBinding {
  const raw = object(value);
  keys(raw, ["recipientAccount", "derivation"]);
  const derivation = object(raw.derivation);
  keys(derivation, ["kind", "ownerAddress"]);
  if (derivation.kind !== "native") throw new Error("TON_INVALID_BINDING");
  const recipientAccount = canonicalAddress(raw.recipientAccount);
  const ownerAddress = canonicalAddress(derivation.ownerAddress);
  if (
    recipientAccount !== source.invoiceRecipient ||
    ownerAddress !== source.invoiceRecipient
  )
    throw new Error("TON_INVALID_BINDING");
  return {
    recipientAccount,
    derivation: { kind: "native", ownerAddress },
  };
}

function normalizeObservation(value: TonObservationInput): TonObservationInput {
  const raw = object(value);
  keys(raw, [
    "schemaVersion",
    "invoiceId",
    "sourceId",
    "recipientAccount",
    "eventIdentity",
    "providerId",
    "evidenceModel",
    "result",
    "providerCursor",
    "snapshot",
    "observedAtMs",
  ]);
  if (
    raw.schemaVersion !== 1 ||
    raw.providerId !== TON_PROVIDER_ID ||
    raw.evidenceModel !== TON_EVIDENCE_MODEL
  )
    throw new Error("TON_INVALID_OBSERVATION");
  const result = object(raw.result);
  keys(result, ["kind", "reason", "evidenceDigest"]);
  const kind = result.kind;
  const reason = result.reason;
  const digest = result.evidenceDigest;
  if (
    (kind === "source_error" &&
      (!SOURCE_ERRORS.has(reason as TonSourceErrorCode) || digest !== null)) ||
    (kind === "observed" &&
      (!OBSERVED_REASONS.has(reason as string) ||
        (digest !== null && !SOURCE_ID.test(String(digest))))) ||
    (kind === "unmatched" &&
      (reason !== "invoice_reference_not_found" ||
        typeof digest !== "string" ||
        !SOURCE_ID.test(digest))) ||
    (kind === "verified_candidate" &&
      (reason !== "verified_candidate" ||
        typeof digest !== "string" ||
        !SOURCE_ID.test(digest))) ||
    (kind === "review_required" &&
      (!REVIEW_REASONS.has(reason as string) ||
        typeof digest !== "string" ||
        !SOURCE_ID.test(digest))) ||
    ![
      "source_error",
      "observed",
      "unmatched",
      "verified_candidate",
      "review_required",
    ].includes(kind as string)
  )
    throw new Error("TON_INVALID_OBSERVATION_RESULT");

  const invoiceId = raw.invoiceId === null ? null : canonicalId(raw.invoiceId);
  let eventIdentity: TonObservationInput["eventIdentity"] = null;
  if (raw.eventIdentity !== null) {
    const event = object(raw.eventIdentity);
    keys(event, ["txHash", "messageHash", "txLt"]);
    eventIdentity = {
      txHash: lowerHash(event.txHash),
      messageHash: lowerHash(event.messageHash),
      txLt: atomic(event.txLt, true, true),
    };
  }
  const noCandidate =
    kind === "source_error" ||
    (kind === "observed" && reason === "candidate_not_found");
  if (
    (noCandidate && (invoiceId !== null || eventIdentity !== null)) ||
    (kind === "unmatched" && (invoiceId !== null || eventIdentity === null)) ||
    (!noCandidate &&
      kind !== "unmatched" &&
      (invoiceId === null || eventIdentity === null))
  )
    throw new Error("TON_INVALID_OBSERVATION_IDENTITY");

  const snapshot = object(raw.snapshot);
  if (invoiceId !== null) {
    if (
      typeof snapshot.reference !== "string" ||
      !CANONICAL_REFERENCE.test(snapshot.reference)
    )
      throw new Error("TON_INVALID_REFERENCE");
  }
  const normalized = {
    schemaVersion: 1,
    invoiceId,
    sourceId: lowerHash(raw.sourceId, "TON_INVALID_SOURCE"),
    recipientAccount: canonicalAddress(raw.recipientAccount),
    eventIdentity,
    providerId: TON_PROVIDER_ID,
    evidenceModel: TON_EVIDENCE_MODEL,
    result: {
      kind,
      reason,
      evidenceDigest: digest,
    },
    providerCursor: nullableCursor(raw.providerCursor),
    snapshot,
    observedAtMs: time(raw.observedAtMs),
  } as TonObservationInput;
  const serialized = canonicalJson(normalized.snapshot);
  if (Buffer.byteLength(serialized) > 32_768)
    throw new Error("TON_SNAPSHOT_TOO_LARGE");
  return normalized;
}

function sourceJson(source: TonReconciliationSource): string {
  return canonicalJson(source);
}

const INVOICE_KEYS = [
  "schemaVersion",
  "product",
  "purpose",
  "invoiceId",
  "ownerId",
  "orgId",
  "orderId",
  "idempotencyKey",
  "quoteId",
  "quote",
  "grantMicrocredits",
  "priceRevision",
  "network",
  "asset",
  "amountAtomic",
  "recipient",
  "reference",
  "expectedSender",
  "finalityPolicyId",
  "verifierVersion",
  "expiresAt",
  "createdAt",
  "status",
  "reviewReason",
] as const;

function exactInvoiceAsset(value: unknown): TonInvoice["asset"] {
  const raw = object(value);
  if (raw.kind === "native") keys(raw, ["network", "kind", "decimals"]);
  else keys(raw, ["network", "kind", "masterAddress", "decimals"]);
  const normalized = normalizeAsset(raw);
  if (canonicalJson(normalized) !== canonicalJson(raw))
    throw new Error("TON_INVALID_DATABASE_RESULT");
  return normalized;
}

function invoiceTimestamp(value: unknown): string {
  if (typeof value !== "string") throw new Error("TON_INVALID_DATABASE_RESULT");
  const match = full(
    "([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\\.([0-9]{0,5}[1-9]))?([+-])([0-9]{2}):([0-9]{2})",
  ).exec(value);
  if (!match) throw new Error("TON_INVALID_DATABASE_RESULT");
  const [
    ,
    year,
    month,
    day,
    hour,
    minute,
    second,
    ,
    sign,
    offsetHour,
    offsetMinute,
  ] = match;
  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const offsetHourNumber = Number(offsetHour);
  const offsetMinuteNumber = Number(offsetMinute);
  const leapYear =
    yearNumber % 4 === 0 && (yearNumber % 100 !== 0 || yearNumber % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    monthNumber < 1 ||
    monthNumber > 12 ||
    dayNumber < 1 ||
    dayNumber > (daysInMonth[monthNumber - 1] ?? 0) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    offsetHourNumber > 15 ||
    offsetMinuteNumber > 59 ||
    (sign === "-" && offsetHourNumber === 0 && offsetMinuteNumber === 0) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error("TON_INVALID_DATABASE_RESULT");
  return value;
}

function parseTonInvoiceResult(value: unknown): TonInvoice {
  try {
    const raw = object(value);
    keys(raw, [...INVOICE_KEYS]);
    if (
      raw.schemaVersion !== 1 ||
      raw.product !== "aggregator" ||
      raw.purpose !== "gateway_topup" ||
      (raw.network !== "tvm:-3" && raw.network !== "tvm:-1") ||
      typeof raw.idempotencyKey !== "string" ||
      !full("[A-Za-z0-9_-]{1,96}").test(raw.idempotencyKey) ||
      typeof raw.reference !== "string" ||
      !CANONICAL_REFERENCE.test(raw.reference) ||
      !INVOICE_STATUSES.has(raw.status as TonInvoice["status"])
    )
      throw new Error("TON_INVALID_DATABASE_RESULT");

    const parsedQuote = quote(raw.quote);
    const quoteRaw = object(raw.quote);
    exactInvoiceAsset(quoteRaw.asset);
    exactInvoiceAsset(object(quoteRaw.fx).targetAsset);
    if (canonicalJson(parsedQuote) !== canonicalJson(quoteRaw))
      throw new Error("TON_INVALID_DATABASE_RESULT");
    const parsedAsset = exactInvoiceAsset(raw.asset);
    const grantMicrocredits = atomic(raw.grantMicrocredits);
    const amountAtomic = atomic(raw.amountAtomic);
    const reviewReason =
      raw.reviewReason === null ? null : label(raw.reviewReason);
    if (
      raw.quoteId !== parsedQuote.quoteId ||
      canonicalJson(parsedAsset) !== canonicalJson(parsedQuote.asset) ||
      grantMicrocredits !== parsedQuote.sourcePrice.amountAtomic ||
      amountAtomic !== parsedQuote.amountAtomic ||
      (raw.status === "review_required") !== (reviewReason !== null)
    )
      throw new Error("TON_INVALID_DATABASE_RESULT");

    return {
      schemaVersion: 1,
      product: "aggregator",
      purpose: "gateway_topup",
      invoiceId: canonicalId(raw.invoiceId),
      ownerId: canonicalId(raw.ownerId),
      orgId: canonicalId(raw.orgId),
      orderId: canonicalId(raw.orderId),
      idempotencyKey: raw.idempotencyKey,
      quoteId: label(raw.quoteId),
      quote: parsedQuote,
      grantMicrocredits,
      priceRevision: label(raw.priceRevision),
      network: raw.network,
      asset: parsedAsset,
      amountAtomic,
      recipient: canonicalAddress(raw.recipient),
      reference: raw.reference,
      expectedSender:
        raw.expectedSender === null
          ? null
          : canonicalAddress(raw.expectedSender),
      finalityPolicyId: label(raw.finalityPolicyId),
      verifierVersion: label(raw.verifierVersion),
      expiresAt: invoiceTimestamp(raw.expiresAt),
      createdAt: invoiceTimestamp(raw.createdAt),
      status: raw.status as TonInvoice["status"],
      reviewReason,
    };
  } catch {
    throw new Error("TON_INVALID_DATABASE_RESULT");
  }
}

function requireResult<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T))
    throw new Error("TON_INVALID_DATABASE_RESULT");
  return value as T;
}

export async function listTonReconciliationSources(
  db: TonPaymentDatabase,
  input: {
    afterSourceId: string | null;
    limit: number;
    assetKind: "native";
  },
): Promise<readonly TonReconciliationSource[]> {
  const raw = object(input);
  keys(raw, ["afterSourceId", "limit", "assetKind"]);
  if (
    raw.assetKind !== "native" ||
    !Number.isInteger(raw.limit) ||
    (raw.limit as number) < 1 ||
    (raw.limit as number) > 16
  )
    throw new Error("TON_INVALID_LIMIT");
  const after =
    raw.afterSourceId === null
      ? null
      : lowerHash(raw.afterSourceId, "TON_INVALID_SOURCE");
  return db.transaction(async (tx) => {
    const result = await tx.query<{ result: unknown }>({
      text: "SELECT aiag_list_ton_reconciliation_sources_v1($1::text,$2::integer,$3::text) AS result",
      values: [after, raw.limit, "native"],
    });
    const rows = result.rows[0]?.result;
    if (!Array.isArray(rows) || rows.length > (raw.limit as number))
      throw new Error("TON_INVALID_DATABASE_RESULT");
    return rows.map(normalizeSource);
  });
}

export async function findTonInvoicesForReconciliation(
  db: TonPaymentDatabase,
  input: {
    source: TonReconciliationSource;
    references: readonly string[];
  },
): Promise<readonly TonInvoice[]> {
  const raw = object(input);
  keys(raw, ["source", "references"]);
  const source = normalizeSource(raw.source);
  if (
    !Array.isArray(raw.references) ||
    raw.references.length > 8 ||
    raw.references.some(
      (reference) =>
        typeof reference !== "string" || !CANONICAL_REFERENCE.test(reference),
    ) ||
    new Set(raw.references).size !== raw.references.length
  )
    throw new Error("TON_INVALID_REFERENCES");
  const requestedReferences = raw.references as readonly string[];
  if (requestedReferences.length === 0) return [];
  return db.transaction(async (tx) => {
    const result = await tx.query<{ result: unknown }>({
      text: "SELECT aiag_find_ton_invoices_for_reconciliation_v1($1::jsonb,$2::text[]) AS result",
      values: [sourceJson(source), requestedReferences],
    });
    if (result.rows.length !== 1 || !Array.isArray(result.rows[0]?.result))
      throw new Error("TON_INVALID_DATABASE_RESULT");
    const rows = result.rows[0].result;
    if (rows.length > requestedReferences.length)
      throw new Error("TON_INVALID_DATABASE_RESULT");
    const references = new Set(requestedReferences);
    const seenReferences = new Set<string>();
    const seenInvoices = new Set<string>();
    return rows.map((value) => {
      const invoice = parseTonInvoiceResult(value);
      if (
        !references.has(invoice.reference) ||
        seenReferences.has(invoice.reference) ||
        seenInvoices.has(invoice.invoiceId) ||
        invoice.network !== source.network ||
        invoice.asset.kind !== "native" ||
        invoice.asset.decimals !== 9 ||
        invoice.recipient !== source.invoiceRecipient
      )
        throw new Error("TON_INVALID_DATABASE_RESULT");
      seenReferences.add(invoice.reference);
      seenInvoices.add(invoice.invoiceId);
      return invoice;
    });
  });
}

export async function getTonInvoiceForReconciliation(
  db: TonPaymentDatabase,
  invoiceId: string,
): Promise<TonInvoice | null> {
  const invoice = canonicalId(invoiceId);
  return db.transaction(async (tx) => {
    const result = await tx.query<{ result: unknown }>({
      text: "SELECT aiag_get_ton_invoice_for_reconciliation_v1($1::uuid) AS result",
      values: [invoice],
    });
    if (result.rows.length !== 1)
      throw new Error("TON_INVALID_DATABASE_RESULT");
    const value = result.rows[0]?.result;
    if (value === null) return null;
    const parsed = parseTonInvoiceResult(value);
    if (parsed.invoiceId !== invoice)
      throw new Error("TON_INVALID_DATABASE_RESULT");
    return parsed;
  });
}

export async function recordTonChainObservation(
  db: TonPaymentDatabase,
  input: TonObservationInput,
): Promise<TonObservationResult> {
  const normalized = normalizeObservation(input);
  const serialized = canonicalJson(normalized);
  if (Buffer.byteLength(serialized) > 65_536)
    throw new Error("TON_OBSERVATION_TOO_LARGE");
  return db.transaction(async (tx) => {
    const value = (
      await tx.query<{ result: unknown }>({
        text: "SELECT aiag_record_ton_chain_observation_v1($1::jsonb) AS result",
        values: [serialized],
      })
    ).rows[0]?.result;
    const raw = object(value);
    keys(raw, ["observationId", "outcome", "invoiceStatus"]);
    const invoiceStatus =
      raw.invoiceStatus === null && raw.invoiceStatus !== undefined
        ? null
        : requireResult(raw.invoiceStatus, [...INVOICE_STATUSES]);
    return {
      observationId: canonicalId(raw.observationId),
      outcome: requireResult(raw.outcome, ["inserted", "already_recorded"]),
      invoiceStatus,
    };
  });
}

export async function claimTonReconciliationLease(
  db: TonPaymentDatabase,
  input: {
    source: TonReconciliationSource;
    providerId: "toncenter-v3-testnet";
    leaseOwner: string;
    leaseMs: 90_000;
  },
): Promise<
  | {
      kind: "claimed";
      cursor: TonSweepCursor | null;
      binding: TonRecipientBinding | null;
    }
  | { kind: "busy" }
  | { kind: "source_identity_mismatch" }
> {
  const raw = object(input);
  keys(raw, ["source", "providerId", "leaseOwner", "leaseMs"]);
  if (raw.providerId !== TON_PROVIDER_ID || raw.leaseMs !== 90_000)
    throw new Error("TON_INVALID_LEASE");
  const source = normalizeSource(raw.source);
  const owner = canonicalId(raw.leaseOwner);
  return db.transaction(async (tx) => {
    const value = (
      await tx.query<{ result: unknown }>({
        text: "SELECT aiag_claim_ton_reconciliation_lease_v1($1::jsonb,$2::text,$3::uuid,$4::integer) AS result",
        values: [sourceJson(source), TON_PROVIDER_ID, owner, 90_000],
      })
    ).rows[0]?.result;
    const result = object(value);
    if (result.kind === "busy" || result.kind === "source_identity_mismatch") {
      keys(result, ["kind"]);
      return { kind: result.kind };
    }
    keys(result, ["kind", "cursor", "binding"]);
    if (result.kind !== "claimed")
      throw new Error("TON_INVALID_DATABASE_RESULT");
    const binding =
      result.binding === null ? null : normalizeBinding(result.binding, source);
    return {
      kind: "claimed" as const,
      cursor: nullableCursor(result.cursor),
      binding,
    };
  });
}

export async function bindTonReconciliationRecipient(
  db: TonPaymentDatabase,
  input: {
    source: TonReconciliationSource;
    leaseOwner: string;
    expected: TonSweepCursor | null;
    binding: TonRecipientBinding;
  },
): Promise<
  | "bound"
  | "binding_mismatch"
  | "lease_lost"
  | "cursor_conflict"
  | "source_identity_mismatch"
> {
  const raw = object(input);
  keys(raw, ["source", "leaseOwner", "expected", "binding"]);
  const source = normalizeSource(raw.source);
  const owner = canonicalId(raw.leaseOwner);
  const expected = nullableCursor(raw.expected);
  const binding = normalizeBinding(raw.binding, source);
  return db.transaction(async (tx) =>
    requireResult(
      (
        await tx.query<{ result: unknown }>({
          text: "SELECT aiag_bind_ton_reconciliation_recipient_v1($1::jsonb,$2::uuid,$3::jsonb,$4::jsonb) AS result",
          values: [
            sourceJson(source),
            owner,
            expected === null ? null : canonicalJson(expected),
            canonicalJson(binding),
          ],
        })
      ).rows[0]?.result,
      [
        "bound",
        "binding_mismatch",
        "lease_lost",
        "cursor_conflict",
        "source_identity_mismatch",
      ] as const,
    ),
  );
}

export async function renewTonReconciliationLease(
  db: TonPaymentDatabase,
  input: {
    sourceId: string;
    leaseOwner: string;
    expected: TonSweepCursor | null;
    leaseMs: 90_000;
  },
): Promise<"renewed" | "lease_lost" | "cursor_conflict"> {
  const raw = object(input);
  keys(raw, ["sourceId", "leaseOwner", "expected", "leaseMs"]);
  if (raw.leaseMs !== 90_000) throw new Error("TON_INVALID_LEASE");
  const sourceId = lowerHash(raw.sourceId, "TON_INVALID_SOURCE");
  const owner = canonicalId(raw.leaseOwner);
  const expected = nullableCursor(raw.expected);
  return db.transaction(async (tx) =>
    requireResult(
      (
        await tx.query<{ result: unknown }>({
          text: "SELECT aiag_renew_ton_reconciliation_lease_v1($1::text,$2::uuid,$3::jsonb,$4::integer) AS result",
          values: [
            sourceId,
            owner,
            expected === null ? null : canonicalJson(expected),
            90_000,
          ],
        })
      ).rows[0]?.result,
      ["renewed", "lease_lost", "cursor_conflict"] as const,
    ),
  );
}

export async function advanceTonReconciliationCursor(
  db: TonPaymentDatabase,
  input: {
    sourceId: string;
    leaseOwner: string;
    expected: TonSweepCursor | null;
    next: TonSweepCursor | null;
    outcome: "success" | "source_error";
    retryAfterMs: number | null;
    errorCode: TonSourceErrorCode | null;
  },
): Promise<"advanced" | "lease_lost" | "cursor_conflict"> {
  const raw = object(input);
  keys(raw, [
    "sourceId",
    "leaseOwner",
    "expected",
    "next",
    "outcome",
    "retryAfterMs",
    "errorCode",
  ]);
  const sourceId = lowerHash(raw.sourceId, "TON_INVALID_SOURCE");
  const owner = canonicalId(raw.leaseOwner);
  const expected = nullableCursor(raw.expected);
  const next = nullableCursor(raw.next);
  if (
    (raw.outcome !== "success" && raw.outcome !== "source_error") ||
    (raw.retryAfterMs !== null &&
      (!Number.isSafeInteger(raw.retryAfterMs) ||
        (raw.retryAfterMs as number) < 0 ||
        (raw.retryAfterMs as number) > 900_000)) ||
    (raw.errorCode !== null &&
      !SOURCE_ERRORS.has(raw.errorCode as TonSourceErrorCode)) ||
    (raw.outcome === "success" &&
      (raw.errorCode !== null || raw.retryAfterMs !== null)) ||
    (raw.outcome === "source_error" &&
      (raw.errorCode === null ||
        canonicalJson(next) !== canonicalJson(expected))) ||
    (raw.errorCode !== "rate_limited" && raw.retryAfterMs !== null)
  )
    throw new Error("TON_INVALID_ADVANCE");
  return db.transaction(async (tx) =>
    requireResult(
      (
        await tx.query<{ result: unknown }>({
          text: "SELECT aiag_advance_ton_reconciliation_cursor_v1($1::text,$2::uuid,$3::jsonb,$4::jsonb,$5::text,$6::integer,$7::text) AS result",
          values: [
            sourceId,
            owner,
            expected === null ? null : canonicalJson(expected),
            next === null ? null : canonicalJson(next),
            raw.outcome,
            raw.retryAfterMs,
            raw.errorCode,
          ],
        })
      ).rows[0]?.result,
      ["advanced", "lease_lost", "cursor_conflict"] as const,
    ),
  );
}

export async function releaseTonReconciliationLease(
  db: TonPaymentDatabase,
  sourceId: string,
  leaseOwner: string,
): Promise<"released" | "lease_lost"> {
  const source = lowerHash(sourceId, "TON_INVALID_SOURCE");
  const owner = canonicalId(leaseOwner);
  return db.transaction(async (tx) =>
    requireResult(
      (
        await tx.query<{ result: unknown }>({
          text: "SELECT aiag_release_ton_reconciliation_lease_v1($1::text,$2::uuid) AS result",
          values: [source, owner],
        })
      ).rows[0]?.result,
      ["released", "lease_lost"] as const,
    ),
  );
}

export interface TonReviewRequiredEntry {
  invoiceId: string;
  eventId: string;
  orgId: string;
  reference: string;
  reviewReason: string;
  amountAtomic: string;
  assetKind: string;
  network: string;
  txHash: string;
  updatedAt: string;
}

/** Operator queue (task 4.1): invoices currently in review_required with their latest review cause. */
export async function listTonReviewRequired(
  db: TonPaymentDatabase,
  limit: number,
): Promise<TonReviewRequiredEntry[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("TON_REVIEW_LIMIT_INVALID");
  }
  return db.transaction(async (tx) => {
    const result = await tx.query<{
      invoice_id: string;
      event_id: string;
      org_id: string;
      reference: string;
      review_reason: string;
      amount_atomic: string;
      asset_kind: string;
      network: string;
      tx_hash: string;
      updated_at: string;
    }>({
      text: `SELECT i.id::text AS invoice_id, d.event_id::text AS event_id, i.org_id::text AS org_id, i.reference,
        i.review_reason, i.amount_atomic::text AS amount_atomic, i.asset_kind, i.network::text AS network,
        e.tx_hash::text AS tx_hash, i.updated_at::text AS updated_at
        FROM ton_invoices i
        JOIN LATERAL (SELECT ed.event_id, ed.reason FROM ton_invoice_event_decisions ed
          WHERE ed.invoice_id=i.id AND ed.decision='review_required'
          ORDER BY ed.created_at DESC, ed.id DESC LIMIT 1) d ON TRUE
        JOIN ton_chain_events e ON e.id=d.event_id
        WHERE i.status='review_required'
          AND NOT EXISTS (SELECT 1 FROM ton_invoice_event_decisions a WHERE a.invoice_id=i.id AND a.decision='acknowledged_no_credit')
        ORDER BY i.updated_at DESC, i.id
        LIMIT $1::integer`,
      values: [limit],
    });
    return result.rows.map((row) => ({
      invoiceId: row.invoice_id,
      eventId: row.event_id,
      orgId: row.org_id,
      reference: row.reference,
      reviewReason: row.review_reason,
      amountAtomic: row.amount_atomic,
      assetKind: row.asset_kind,
      network: row.network,
      txHash: row.tx_hash,
      updatedAt: row.updated_at,
    }));
  });
}

export type TonReviewAction = "acknowledge_no_credit" | "retry_settle";

/**
 * Append-only operator decision (task 4.1). `acknowledge_no_credit` is the
 * terminal "no credit" verdict (the settle function honours it); `retry_settle`
 * only records the audit row — the worker sweep re-evaluates the causes on its
 * next tick (durable-but-re-evaluable review decisions, migration 0101).
 */
export async function resolveTonReviewDecision(
  db: TonPaymentDatabase,
  input: {
    invoiceId: string;
    eventId: string;
    actor: string;
    action: TonReviewAction;
  },
): Promise<"acknowledged" | "retry_scheduled"> {
  const invoiceId = id(input.invoiceId);
  const eventId = id(input.eventId);
  if (
    typeof input.actor !== "string" ||
    input.actor.length === 0 ||
    input.actor.length > 255
  ) {
    throw new Error("TON_REVIEW_ACTOR_INVALID");
  }
  return db.transaction(async (tx) => {
    const current = await tx.query<{ status: string; reason: string | null }>({
      text: `SELECT i.status, d.reason
        FROM ton_invoices i
        JOIN ton_invoice_event_decisions d ON d.invoice_id=i.id AND d.event_id=$2::uuid AND d.decision='review_required'
        WHERE i.id=$1::uuid AND i.status='review_required'
          AND NOT EXISTS (SELECT 1 FROM ton_invoice_event_decisions a WHERE a.invoice_id=i.id AND a.decision='acknowledged_no_credit')`,
      values: [invoiceId, eventId],
    });
    const row = current.rows[0];
    if (!row || row.reason === null) {
      throw new Error("TON_REVIEW_TARGET_INVALID");
    }
    if (input.action === "acknowledge_no_credit") {
      await tx.query({
        text: `INSERT INTO ton_invoice_event_decisions(invoice_id,event_id,decision,reason)
          VALUES($1::uuid,$2::uuid,'acknowledged_no_credit',$3)
          ON CONFLICT (invoice_id,event_id,decision) DO NOTHING`,
        values: [invoiceId, eventId, row.reason],
      });
      return "acknowledged";
    }
    await tx.query({
      text: `INSERT INTO ton_invoice_event_decisions(invoice_id,event_id,decision)
        VALUES($1::uuid,$2::uuid,'retry_requested')
        ON CONFLICT (invoice_id,event_id,decision) DO NOTHING`,
      values: [invoiceId, eventId],
    });
    return "retry_scheduled";
  });
}
