/**
 * Pure jetton evidence parsing for the USDT reconciliation rail (task 9).
 *
 * Every schema below was verified against live TonCenter v3 responses
 * (/api/v3/jetton/transfers rows and /api/v3/traces decoded message bodies,
 * mainnet + testnet mirrors, 2026-10-11):
 *
 *  - transfer row: { query_id, source, destination, amount, source_wallet,
 *    jetton_master, transaction_hash (base64), transaction_lt, transaction_now,
 *    transaction_aborted, response_destination, custom_payload,
 *    decoded_custom_payload, forward_ton_amount, forward_payload,
 *    decoded_forward_payload, trace_id (base64) }
 *    `source`/`destination` are OWNER addresses (raw form, uppercase hex),
 *    `source_wallet` the sender's jetton wallet contract.
 *  - decoded bodies: `jetton_transfer` / `jetton_internal_transfer` /
 *    `jetton_notify` with `var_uint` ({ @type, len, value }) amounts,
 *    `addr_std` ({ @type, anycast, workchain_id, address:HEX64 }) addresses
 *    and `forward_payload` ({ @type: first_from_either|second_from_either,
 *    value }) where a text forward payload arrives as
 *    { @type: "text_comment", text }.
 *
 * This module is provider-free and effect-free: it only validates, rejects
 * and reshapes. Fail-closed unknowns surface as `'schema_invalid'`; semantic
 * rejections (foreign master, foreign owner, aborted transaction) surface as
 * row rejections the scanner skips.
 */
import type { NormalizedTonMessage } from './ton-payment-evidence.js';

export const TON_JETTON_TRANSFER_OPCODE = '0x0f8a7ea5' as const;
export const TON_JETTON_INTERNAL_OPCODE = '0x178d4519' as const;
export const TON_JETTON_NOTIFICATION_OPCODE = '0x7362d09c' as const;

/** Canonical invoice reference carried in the forward payload comment. */
export const TON_JETTON_REFERENCE =
  /^aiag-ton:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const RAW_ADDRESS = /^(?:0|-1):[0-9a-fA-F]{64}$/;
const HEX_64 = /^[0-9a-fA-F]{64}$/;
const BASE64_32 = /^(?:[A-Za-z0-9+/]{43}=|[A-Za-z0-9+/]{44})$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;

/** Rejections are data-dependent (the row belongs to someone else or never
 *  credited); schema breakage is provider failure and fails closed instead. */
export type JettonRowRejection =
  | { kind: 'row_rejected'; reason: 'master_mismatch' }
  | { kind: 'row_rejected'; reason: 'owner_mismatch' }
  | { kind: 'row_rejected'; reason: 'aborted_transaction' };

export type JettonRowSchemaFailure = { kind: 'schema_invalid' };

export interface JettonTransferRowFacts {
  /** Discriminant: distinguishes accepted facts from row/schema rejections. */
  kind: 'facts';
  /** Hex tx hash of the credit transaction on the merchant jetton wallet. */
  transactionHash: string;
  transactionLt: string;
  transactionTimeMs: number;
  /** Hex trace id — must equal the fetched trace's id. */
  traceId: string;
  /** Jetton atomic units, canonical decimal string. */
  amountAtomic: string;
  /** Canonical aiag-ton reference from the forward payload comment, or null. */
  reference: string | null;
  /** Sender owner address, raw lowercase. */
  sourceOwner: string;
  /** Receiver owner address, raw lowercase (always the scanned merchant). */
  destinationOwner: string;
  /** Jetton master, raw lowercase (always the expected master on accept). */
  masterAddress: string;
  /** Sender's jetton wallet contract, raw lowercase. */
  sourceWallet: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function rawAddress(value: unknown): string | null {
  if (typeof value !== 'string' || !RAW_ADDRESS.test(value)) return null;
  return value.toLowerCase();
}

/** addr_std decoded wrapper → raw `wc:hex` form (lowercase). */
export function jettonAddrStd(value: unknown): string {
  if (!isObject(value)) throw new Error('JETTON_BODY_INVALID');
  const address = value.address;
  const workchain = value.workchain_id;
  if (
    typeof address !== 'string' ||
    !HEX_64.test(address) ||
    (workchain !== '0' && workchain !== 0 && workchain !== '-1' && workchain !== -1)
  ) {
    throw new Error('JETTON_BODY_INVALID');
  }
  const wc = typeof workchain === 'number' ? workchain : Number(workchain);
  return `${wc}:${address.toLowerCase()}`;
}

/** var_uint decoded wrapper → canonical decimal string. */
export function jettonVarUint(value: unknown): string {
  if (!isObject(value)) throw new Error('JETTON_BODY_INVALID');
  const amount = value.value;
  if (typeof amount !== 'string' || amount.length > 78 || !DECIMAL.test(amount)) {
    throw new Error('JETTON_BODY_INVALID');
  }
  return amount;
}

/**
 * Forward payload reference extraction. Accepts the trace body shapes
 * (first_from_either/second_from_either wrappers around text_comment with a
 * `text` field) and the transfer-row shape (decoded_forward_payload with a
 * `comment` field). Anything else — including an empty payload — yields ''.
 */
export function jettonForwardReference(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (!isObject(value)) return '';
  const inner = isObject(value.value) ? value.value : value;
  const type = inner['@type'] ?? inner.type;
  if (type !== 'text_comment') return '';
  const text = inner.text ?? inner.comment;
  if (typeof text !== 'string' || text.length > 96) return '';
  return text;
}

function referenceOrNone(text: string): string | null {
  return TON_JETTON_REFERENCE.test(text) ? text : null;
}

/**
 * Parse one /api/v3/jetton/transfers row against the scanned source.
 * Only the fields the rail consumes are validated; TonCenter extras
 * (query_id, custom payloads, forward amounts) are ignored, mirroring the
 * native scanner's row policy.
 */
export function parseJettonTransferRow(
  input: unknown,
  expected: { masterAddress: string; ownerAddress: string },
): JettonTransferRowFacts | JettonRowRejection | JettonRowSchemaFailure {
  if (!isObject(input)) return { kind: 'schema_invalid' };
  const masterAddress = rawAddress(input.jetton_master);
  const sourceOwner = rawAddress(input.source);
  const destinationOwner = rawAddress(input.destination);
  const sourceWallet = rawAddress(input.source_wallet);
  const amountAtomic = input.amount;
  const transactionLt = input.transaction_lt;
  const transactionHash = input.transaction_hash;
  const traceId = input.trace_id;
  const transactionNow = input.transaction_now;
  const transactionAborted = input.transaction_aborted;
  if (
    masterAddress === null ||
    sourceOwner === null ||
    destinationOwner === null ||
    sourceWallet === null ||
    typeof amountAtomic !== 'string' ||
    amountAtomic.length > 78 ||
    !DECIMAL.test(amountAtomic) ||
    typeof transactionLt !== 'string' ||
    transactionLt.length > 78 ||
    !DECIMAL.test(transactionLt) ||
    typeof transactionHash !== 'string' ||
    !BASE64_32.test(transactionHash) ||
    typeof traceId !== 'string' ||
    !BASE64_32.test(traceId) ||
    !Number.isSafeInteger(transactionNow) ||
    (transactionNow as number) < 0 ||
    typeof transactionAborted !== 'boolean'
  ) {
    return { kind: 'schema_invalid' };
  }
  // A foreign master cannot pay an invoice of this source's asset; a foreign
  // owner is not this merchant; an aborted credit transaction never landed.
  if (masterAddress !== expected.masterAddress.toLowerCase()) {
    return { kind: 'row_rejected', reason: 'master_mismatch' };
  }
  if (destinationOwner !== expected.ownerAddress.toLowerCase()) {
    return { kind: 'row_rejected', reason: 'owner_mismatch' };
  }
  if (transactionAborted) {
    return { kind: 'row_rejected', reason: 'aborted_transaction' };
  }
  return {
    kind: 'facts' as const,
    transactionHash: Buffer.from(transactionHash, 'base64').toString('hex'),
    transactionLt,
    transactionTimeMs: (transactionNow as number) * 1000,
    traceId: Buffer.from(traceId, 'base64').toString('hex'),
    amountAtomic,
    reference: referenceOrNone(jettonForwardReference(input.decoded_forward_payload)),
    sourceOwner,
    destinationOwner,
    masterAddress,
    sourceWallet,
  };
}

type JettonTransferPayload = Extract<
  NormalizedTonMessage['decodedPayload'],
  { kind: 'jetton_transfer' }
>;
type JettonInternalPayload = Extract<
  NormalizedTonMessage['decodedPayload'],
  { kind: 'jetton_internal_transfer' }
>;
type JettonNotificationPayload = Extract<
  NormalizedTonMessage['decodedPayload'],
  { kind: 'jetton_notification' }
>;

/** jetton_transfer (op 0x0f8a7ea5) decoded body → normalized payload. */
export function jettonTransferPayload(body: unknown): JettonTransferPayload {
  if (!isObject(body)) throw new Error('JETTON_BODY_INVALID');
  try {
    return {
      kind: 'jetton_transfer',
      amountAtomic: jettonVarUint(body.amount),
      destination: jettonAddrStd(body.destination),
      forwardReference: jettonForwardReference(body.forward_payload),
    };
  } catch {
    throw new Error('JETTON_BODY_INVALID');
  }
}

/** jetton_internal_transfer (op 0x178d4519) decoded body → normalized payload. */
export function jettonInternalTransferPayload(body: unknown): JettonInternalPayload {
  if (!isObject(body)) throw new Error('JETTON_BODY_INVALID');
  try {
    return {
      kind: 'jetton_internal_transfer',
      amountAtomic: jettonVarUint(body.amount),
      sender: jettonAddrStd(body.from),
      responseDestination: jettonAddrStd(body.response_address),
    };
  } catch {
    throw new Error('JETTON_BODY_INVALID');
  }
}

/** jetton_notify / transfer_notification (op 0x7362d09c) decoded body → normalized payload. */
export function jettonNotificationPayload(body: unknown): JettonNotificationPayload {
  if (!isObject(body)) throw new Error('JETTON_BODY_INVALID');
  try {
    return {
      kind: 'jetton_notification',
      amountAtomic: jettonVarUint(body.amount),
      sender: jettonAddrStd(body.sender),
      forwardReference: jettonForwardReference(body.forward_payload),
    };
  } catch {
    throw new Error('JETTON_BODY_INVALID');
  }
}
