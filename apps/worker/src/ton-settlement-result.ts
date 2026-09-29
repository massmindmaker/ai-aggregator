/** Exact ACK validation, never a new settlement or grant authority. */
import type {
  TonInvoice,
  TonReceipt,
  TonSettlementResult,
} from "@aiag/database";
import { uuid } from "./ton-recovery-contract.js";
const reasons = new Set([
  "additional_transfer",
  "event_already_consumed",
  "invoice_in_review",
  "late_payment",
  "owner_changed",
  "payment_mismatch",
  "verification_policy_mismatch",
  "multiple_transfers",
  "underpayment",
  "overpayment",
  "refund_blocked",
  "balance_invariant",
  "balance_compatibility_limit",
]);
function fail(): never {
  throw Error("TON_INVALID_SETTLEMENT_RESULT");
}
/** Known shallow records only. No getters, symbols, inherited fields or serialization hooks. */
function record(
  value: unknown,
  names: readonly string[],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== names.length ||
    keys.some((k) => typeof k !== "string" || !names.includes(k))
  )
    fail();
  const result: Record<string, unknown> = Object.create(null);
  for (const name of names) {
    const d = Object.getOwnPropertyDescriptor(value, name);
    if (!d || !("value" in d) || !d.enumerable) fail();
    result[name] = d.value;
  }
  return result;
}
function discriminant(value: unknown): string {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail();
  const d = Object.getOwnPropertyDescriptor(value, "kind");
  if (
    !d ||
    !("value" in d) ||
    typeof d.value !== "string" ||
    d.value.length > 32
  )
    fail();
  return d.value;
}
function atomic(value: unknown, positive = false): string {
  if (
    typeof value !== "string" ||
    value.length > 19 ||
    !/^(0|[1-9][0-9]*)$/.test(value)
  )
    fail();
  const number = BigInt(value);
  if (number > 9223372036854775807n || (positive && number === 0n)) fail();
  return value;
}
function timestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 40) fail();
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match || match[0] !== value) fail();
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1] ||
    Number(match[4]) > 23 ||
    Number(match[5]) > 59 ||
    Number(match[6]) > 59 ||
    !Number.isFinite(Date.parse(value))
  )
    fail();
  return value;
}
function readReceipt(value: unknown, expected: TonInvoice): TonReceipt {
  const r = record(value, [
    "receiptId",
    "invoiceId",
    "ownerId",
    "orgId",
    "orderId",
    "eventId",
    "grantMicrocredits",
    "amountAtomic",
    "network",
    "asset",
    "settledAt",
    "paygAfterMicrocredits",
    "refundDebtAfterMicrocredits",
  ]);
  const asset = record(r.asset, ["network", "kind", "decimals"]);
  if (
    expected.network !== "tvm:-3" ||
    expected.asset.kind !== "native" ||
    expected.asset.decimals !== 9 ||
    r.network !== "tvm:-3" ||
    asset.network !== "tvm:-3" ||
    asset.kind !== "native" ||
    asset.decimals !== 9
  )
    fail();
  const receipt: TonReceipt = {
    receiptId: uuid(r.receiptId),
    invoiceId: uuid(r.invoiceId),
    ownerId: uuid(r.ownerId),
    orgId: uuid(r.orgId),
    orderId: uuid(r.orderId),
    eventId: uuid(r.eventId),
    grantMicrocredits: atomic(r.grantMicrocredits, true),
    amountAtomic: atomic(r.amountAtomic, true),
    network: "tvm:-3",
    asset: { network: "tvm:-3", kind: "native", decimals: 9 },
    settledAt: timestamp(r.settledAt),
    paygAfterMicrocredits: atomic(r.paygAfterMicrocredits),
    refundDebtAfterMicrocredits: atomic(r.refundDebtAfterMicrocredits),
  };
  for (const name of [
    "invoiceId",
    "ownerId",
    "orgId",
    "orderId",
    "grantMicrocredits",
    "amountAtomic",
  ] as const) {
    if (receipt[name] !== expected[name]) fail();
  }
  // Invoice-owned receipt is historical; current provider event and current balance are not its identity.
  return receipt;
}
export function parseTonSettlementResult(
  value: unknown,
  invoice: TonInvoice,
): TonSettlementResult {
  const kind = discriminant(value);
  if (kind === "settled" || kind === "already_settled") {
    const r = record(value, ["kind", "receipt"]);
    return { kind, receipt: readReceipt(r.receipt, invoice) };
  }
  if (kind === "not_found") {
    record(value, ["kind"]);
    return { kind };
  }
  if (kind === "evidence_conflict") {
    const r = record(value, ["kind", "eventId"]);
    return { kind, eventId: uuid(r.eventId) };
  }
  if (kind === "review_required") {
    const r = record(value, ["kind", "invoiceId", "eventId", "reason"]);
    const id = uuid(r.invoiceId);
    if (
      id !== invoice.invoiceId ||
      typeof r.reason !== "string" ||
      r.reason.length > 64 ||
      !reasons.has(r.reason)
    )
      fail();
    return { kind, invoiceId: id, eventId: uuid(r.eventId), reason: r.reason };
  }
  return fail();
}
