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
  if (c.network !== "tvm:-3") throw new Error("TON_INVALID_NETWORK");
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
    network: "tvm:-3",
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
export async function settleTonInvoice(
  db: TonPaymentDatabase,
  invoiceId: string,
  input: VerifiedChainCredit,
): Promise<TonSettlementResult> {
  const invoice = id(invoiceId),
    c = credit(input);
  if (c.chainTimeMs > c.observedAtMs || c.observedAtMs > c.verifiedAtMs)
    throw new Error("TON_INVALID_TIME_ORDER");
  return db.transaction(
    async (tx) =>
      (
        await tx.query<{ result: TonSettlementResult }>({
          text: "SELECT aiag_settle_ton_invoice_v1($1::uuid,$2::jsonb) AS result",
          values: [invoice, stable(c)],
        })
      ).rows[0]!.result,
  );
}
