import type { TonInvoice } from '@aiag/database';
import { safeFetch, SsrfError } from '@aiag/shared/server';

import {
  normalizeCanonicalTonEvidence,
  TON_EVIDENCE_LIMITS,
  TON_EVIDENCE_MODEL,
  TON_PRESETS,
  type NormalizedTonEvidence,
  type NormalizedTonMessage,
  type NormalizedTonTransaction,
  type TonPreset,
} from './ton-payment-evidence.js';

export type TonSourceErrorCode =
  | 'origin_mismatch' | 'redirect_rejected' | 'response_too_large'
  | 'http_unauthorized' | 'rate_limited' | 'timeout' | 'upstream_5xx'
  | 'provider_schema_invalid' | 'pagination_regressed' | 'recipient_binding_changed'
  | 'unsupported_asset';

export interface TonProviderCursor {
  schemaVersion: 1;
  /** All cursor fields are present for a continuation; cycle reset uses outer null. */
  beforeLt: string;
  beforeTransactionHash: string;
  cycleUpperLt: string;
}

export type TonProviderResult =
  | { kind: 'page'; evidence: readonly NormalizedTonEvidence[]; nextCursor: TonProviderCursor | null; exhausted: boolean }
  | { kind: 'source_error'; code: TonSourceErrorCode; retryAfterMs: number | null };

export type TonRecipientBinding = {
  recipientAccount: string;
  derivation:
    | { kind: 'native'; ownerAddress: string }
    | { kind: 'jetton'; masterAddress: string; ownerAddress: string; walletAddress: string };
};

export interface TonReconciliationSource {
  sourceId: string;
  network: TonPreset['network'];
  asset: TonInvoice['asset'];
  invoiceRecipient: string;
  scanFloorTimeMs: number;
}

export interface TonEvidenceProvider {
  resolveRecipientAccount(source: TonReconciliationSource, signal: AbortSignal): Promise<
    { kind: 'resolved'; recipientAccount: string } | Extract<TonProviderResult, { kind: 'source_error' }>
  >;
  scanAccountPage(recipientAccount: string, cursor: TonProviderCursor | null, signal: AbortSignal): Promise<TonProviderResult>;
}

type FetchBoundary = typeof safeFetch;
export interface ToncenterV3ProviderConfig {
  baseUrl: string;
  /** Network preset pin; defaults to testnet so existing behaviour is unchanged. */
  preset?: TonPreset;
  /** Test seam: production defaults to the SSRF-hardened safeFetch boundary. */
  fetchImpl?: FetchBoundary;
  nowMs?: () => number;
}

const MAX_BODY_BYTES = 1_048_576;
const TIMEOUT_MS = 8_000;
const PAGE_SIZE = 8;
const RAW_ADDRESS = /^(?:0|-1):[0-9a-fA-F]{64}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const BASE64_32 = /^(?:[A-Za-z0-9+/]{43}=|[A-Za-z0-9+/]{44})$/;

class ProviderFailure extends Error {
  constructor(readonly code: TonSourceErrorCode, readonly retryAfterMs: number | null = null) { super(code); }
}

function failure(code: TonSourceErrorCode, retryAfterMs: number | null = null): Extract<TonProviderResult, { kind: 'source_error' }> {
  return { kind: 'source_error', code, retryAfterMs };
}

function object(value: unknown): Record<string, unknown> {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) throw new ProviderFailure('provider_schema_invalid');
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], code: TonSourceErrorCode): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new ProviderFailure(code);
  }
}

function string(value: unknown): string {
  if (typeof value !== 'string') throw new ProviderFailure('provider_schema_invalid');
  return value;
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new ProviderFailure('provider_schema_invalid');
  return value as number;
}

function signedInteger(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw new ProviderFailure('provider_schema_invalid');
  return value as number;
}

function decimal(value: unknown): string {
  const result = string(value);
  if (result.length > 78 || !DECIMAL.test(result)) throw new ProviderFailure('provider_schema_invalid');
  return result;
}

function isBoundedDecimal(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 78 && DECIMAL.test(value);
}

function cursorValue(value: unknown): TonProviderCursor {
  try {
    const candidate = object(value);
    exactKeys(candidate, ['schemaVersion', 'beforeLt', 'beforeTransactionHash', 'cycleUpperLt'], 'pagination_regressed');
    if (candidate.schemaVersion !== 1
      || !isBoundedDecimal(candidate.beforeLt)
      || typeof candidate.beforeTransactionHash !== 'string'
      || !/^[0-9a-f]{64}$/.test(candidate.beforeTransactionHash)
      || !isBoundedDecimal(candidate.cycleUpperLt)
      || BigInt(candidate.beforeLt) > BigInt(candidate.cycleUpperLt)) {
      throw new ProviderFailure('pagination_regressed');
    }
    return {
      schemaVersion: 1,
      beforeLt: candidate.beforeLt,
      beforeTransactionHash: candidate.beforeTransactionHash,
      cycleUpperLt: candidate.cycleUpperLt,
    };
  } catch {
    throw new ProviderFailure('pagination_regressed');
  }
}

function address(value: unknown): string {
  const result = string(value);
  if (!RAW_ADDRESS.test(result)) throw new ProviderFailure('provider_schema_invalid');
  return result.toLowerCase();
}

function shard(value: unknown): string {
  const result = string(value);
  if (!/^[0-9a-fA-F]{16}$/.test(result)) throw new ProviderFailure('provider_schema_invalid');
  return result.toLowerCase();
}

function base64Hash(value: unknown): string {
  const result = string(value);
  if (!BASE64_32.test(result)) throw new ProviderFailure('provider_schema_invalid');
  const bytes = Buffer.from(result, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== result) throw new ProviderFailure('provider_schema_invalid');
  return bytes.toString('hex');
}

function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new ProviderFailure('provider_schema_invalid');
  return value;
}

function nullableBoolean(value: unknown): boolean | null {
  return value === null ? null : bool(value);
}

function nullableString(value: unknown): string | null {
  return value === null ? null : string(value);
}

function nullableDecimal(value: unknown): string | null {
  return value === null ? null : decimal(value);
}

function secondsToMs(value: unknown): number {
  const seconds = integer(value);
  const milliseconds = seconds * 1000;
  if (!Number.isSafeInteger(milliseconds)) throw new ProviderFailure('provider_schema_invalid');
  return milliseconds;
}

function canonicalBaseUrl(baseUrl: string, preset: TonPreset): URL {
  const expected = `${preset.origin}/`;
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { throw new ProviderFailure('origin_mismatch'); }
  if (baseUrl !== expected || parsed.username !== '' || parsed.password !== '' || parsed.href !== expected) {
    throw new ProviderFailure('origin_mismatch');
  }
  return parsed;
}

function retryAfter(value: string | null): number | null {
  if (value === null || !/^[0-9]+$/.test(value)) return null;
  const ms = Number(value) * 1000;
  return Number.isSafeInteger(ms) ? Math.min(900_000, Math.max(1_000, ms)) : 900_000;
}

function statusFailure(response: Response): ProviderFailure | null {
  if (response.status >= 300 && response.status < 400) return new ProviderFailure('redirect_rejected');
  if (response.status === 401 || response.status === 403) return new ProviderFailure('http_unauthorized');
  if (response.status === 429) return new ProviderFailure('rate_limited', retryAfter(response.headers.get('retry-after')));
  if (response.status >= 500 && response.status <= 599) return new ProviderFailure('upstream_5xx');
  if (!response.ok) return new ProviderFailure('provider_schema_invalid');
  return null;
}

async function jsonBody(response: Response): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && (!/^[0-9]+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) {
    throw new ProviderFailure('response_too_large');
  }
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
    throw new ProviderFailure('provider_schema_invalid');
  }
  if (!response.body) throw new ProviderFailure('provider_schema_invalid');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new ProviderFailure('response_too_large'); }
    chunks.push(next.value);
  }
  try { return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); } catch { throw new ProviderFailure('provider_schema_invalid'); }
}

function sameMessageFacts(first: NormalizedTonMessage, second: NormalizedTonMessage): boolean {
  return first.hash === second.hash
    && first.source === second.source
    && first.destination === second.destination
    && first.bounced === second.bounced
    && first.opcode === second.opcode
    && first.amountAtomic === second.amountAtomic
    && JSON.stringify(first.decodedPayload) === JSON.stringify(second.decodedPayload);
}

function providerMessageFingerprint(raw: unknown): string {
  const item = object(raw);
  const content = item.message_content === null || item.message_content === undefined ? null : object(item.message_content);
  const decoded = content?.decoded === undefined || content?.decoded === null ? null : object(content.decoded);
  return JSON.stringify({
    hash: base64Hash(item.hash),
    source: item.source === null ? null : address(item.source),
    destination: address(item.destination),
    value: nullableDecimal(item.value),
    opcode: item.opcode === null ? null : string(item.opcode).toLowerCase(),
    decodedOpcode: nullableString(item.decoded_opcode),
    bounce: nullableBoolean(item.bounce),
    bounced: nullableBoolean(item.bounced),
    createdLt: nullableDecimal(item.created_lt),
    createdAt: nullableDecimal(item.created_at),
    decodedNativeComment: decoded === null ? null : {
      '@type': decoded['@type'], type: decoded.type, comment: decoded.comment,
    },
  });
}

function message(raw: unknown, index: number, externalAllowed: boolean): NormalizedTonMessage {
  const item = object(raw);
  const source = item.source;
  const createdLt = nullableDecimal(item.created_lt);
  const createdAt = nullableDecimal(item.created_at);
  const value = nullableDecimal(item.value);
  const bounced = nullableBoolean(item.bounced);
  nullableBoolean(item.bounce);
  const decodedOpcode = nullableString(item.decoded_opcode);
  const isExternal = source === null && createdLt === null && createdAt === null;
  if (isExternal && !externalAllowed) throw new ProviderFailure('provider_schema_invalid');
  if (isExternal) {
    if (value !== null || bounced !== null) throw new ProviderFailure('provider_schema_invalid');
  } else if (source === null || createdLt === null || createdAt === null || value === null || bounced === null) {
    throw new ProviderFailure('provider_schema_invalid');
  }
  const content = item.message_content === null || item.message_content === undefined ? null : object(item.message_content);
  const decoded = content?.decoded === undefined || content?.decoded === null ? null : object(content.decoded);
  let decodedPayload: Record<string, unknown> = { kind: 'other' };
  const opcode = item.opcode === null ? null : string(item.opcode).toLowerCase();
  if (opcode !== null && !/^0x[0-9a-f]{8}$/.test(opcode)) throw new ProviderFailure('provider_schema_invalid');
  // Sanitized negative captures may omit the optional message_content subtree.
  // Once a decoded subtree is present, the native-comment discriminator is an
  // all-or-nothing tuple and never falls back to a partial interpretation.
  const hasNativeCommentDiscriminator = opcode === '0x00000000'
    || decodedOpcode === 'text_comment'
    || decoded?.['@type'] === 'text_comment'
    || decoded?.type === 'text_comment';
  if (decoded !== null && hasNativeCommentDiscriminator) {
    if (opcode !== '0x00000000' || decodedOpcode !== 'text_comment'
      || decoded['@type'] !== 'text_comment' || decoded.type !== 'text_comment') {
      throw new ProviderFailure('provider_schema_invalid');
    }
    const reference = string(decoded.comment);
    if (reference.length < 1 || reference.length > 96 || reference.trim() !== reference || /[\u0000-\u001f\u007f]/.test(reference)) throw new ProviderFailure('provider_schema_invalid');
    decodedPayload = { kind: 'native_comment', reference };
  }
  return {
    hash: base64Hash(item.hash), index, source: source === null ? null : address(source), destination: address(item.destination),
    bounced: isExternal ? false : bounced!, opcode, amountAtomic: isExternal ? '0' : value!,
    decodedPayload: decodedPayload as NormalizedTonMessage['decodedPayload'],
  };
}

type TraceRange = {
  traceId: string;
  startMc: bigint;
  endMc: bigint;
  startLt: bigint;
  endLt: bigint;
  startTimeMs: number;
  endTimeMs: number;
};

type ScanFacts = {
  account: string;
  hash: string;
  lt: string;
  traceId: string;
  inMessage: NormalizedTonMessage;
  inMessageFingerprint: string;
};

function validateBlockRef(value: unknown): { workchain: number; shard: string; seqno: number } {
  const block = object(value);
  return { workchain: signedInteger(block.workchain), shard: shard(block.shard), seqno: integer(block.seqno) };
}

function validateScanRow(value: unknown, recipient: string): ScanFacts {
  const row = object(value);
  const account = address(row.account);
  if (account !== recipient) throw new ProviderFailure('provider_schema_invalid');
  const hash = base64Hash(row.hash);
  const lt = decimal(row.lt);
  secondsToMs(row.now);
  integer(row.mc_block_seqno);
  const traceId = base64Hash(row.trace_id);
  bool(row.emulated);
  string(row.finality);
  validateBlockRef(row.block_ref);
  const inMessage = message(row.in_msg, 0, true);
  if (!Array.isArray(row.out_msgs)) throw new ProviderFailure('provider_schema_invalid');
  row.out_msgs.forEach((entry, index) => message(entry, index, false));
  return { account, hash, lt, traceId, inMessage, inMessageFingerprint: providerMessageFingerprint(row.in_msg) };
}

function executionFacts(value: unknown): Pick<NormalizedTonTransaction, 'aborted' | 'computeSuccess' | 'actionSuccess'> {
  const description = object(value);
  const aborted = bool(description.aborted);
  const compute = description.compute_ph === null ? null : object(description.compute_ph);
  let computeSuccess = false;
  if (compute !== null) {
    const skipped = bool(compute.skipped);
    if (skipped) {
      if (compute.success !== null || compute.exit_code !== null || typeof compute.reason !== 'string') {
        throw new ProviderFailure('provider_schema_invalid');
      }
    } else {
      bool(compute.success);
      signedInteger(compute.exit_code);
      if (compute.reason !== null && typeof compute.reason !== 'string') throw new ProviderFailure('provider_schema_invalid');
    }
    computeSuccess = !skipped && compute.success === true;
  }
  const action = description.action === null ? null : object(description.action);
  let actionSuccess = false;
  if (action !== null) {
    const success = bool(action.success);
    const valid = bool(action.valid);
    signedInteger(action.result_code);
    actionSuccess = success && valid;
  }
  if (description.bounce !== null) string(object(description.bounce).type);
  return { aborted, computeSuccess, actionSuccess };
}

function validateBlockAnchor(value: unknown): Record<string, unknown> {
  const anchor = object(value);
  signedInteger(anchor.workchain);
  shard(anchor.shard);
  integer(anchor.seqno);
  base64Hash(anchor.root_hash);
  base64Hash(anchor.file_hash);
  const masterchain = object(anchor.masterchain_block_ref);
  if (signedInteger(masterchain.workchain) !== -1) throw new ProviderFailure('provider_schema_invalid');
  shard(masterchain.shard);
  integer(masterchain.seqno);
  const startLt = decimal(anchor.start_lt);
  const endLt = decimal(anchor.end_lt);
  if (BigInt(startLt) > BigInt(endLt)) throw new ProviderFailure('provider_schema_invalid');
  decimal(anchor.gen_utime);
  integer(anchor.tx_count);
  return anchor;
}

function validateHeadBlock(value: unknown): { seqno: number; rootHash: string; fileHash: string } {
  const block = object(value);
  if (signedInteger(block.workchain) !== -1) throw new ProviderFailure('provider_schema_invalid');
  shard(block.shard);
  return { seqno: integer(block.seqno), rootHash: base64Hash(block.root_hash), fileHash: base64Hash(block.file_hash) };
}

function validateTraceTree(
  value: unknown,
  transactions: Map<string, NormalizedTonTransaction>,
  expectedOrder: readonly string[],
): void {
  const visited = new Set<string>();
  const traversal: string[] = [];
  const visit = (rawNode: unknown, parent: NormalizedTonTransaction | null): void => {
    const node = object(rawNode);
    const transactionHash = base64Hash(node.tx_hash);
    const inMessageHash = base64Hash(node.in_msg_hash);
    const transaction = transactions.get(transactionHash);
    if (!transaction || visited.has(transactionHash) || transaction.inMessage.hash !== inMessageHash) {
      throw new ProviderFailure('provider_schema_invalid');
    }
    if (parent !== null) {
      const links = parent.outMessages.filter((outgoing) => outgoing.hash === inMessageHash);
      if (links.length !== 1 || !sameMessageFacts(links[0]!, transaction.inMessage)) {
        throw new ProviderFailure('provider_schema_invalid');
      }
    }
    visited.add(transactionHash);
    traversal.push(transactionHash);
    if (!Array.isArray(node.children)) throw new ProviderFailure('provider_schema_invalid');
    const childHashes = node.children.map((child) => base64Hash(object(child).in_msg_hash));
    if (childHashes.length !== parentOutputHashes(transaction).length
      || childHashes.some((hash, index) => hash !== parentOutputHashes(transaction)[index])) {
      throw new ProviderFailure('provider_schema_invalid');
    }
    for (const child of node.children) visit(child, transaction);
  };
  visit(value, null);
  if (visited.size !== transactions.size
    || traversal.length !== expectedOrder.length
    || traversal.some((hash, index) => hash !== expectedOrder[index])) {
    throw new ProviderFailure('provider_schema_invalid');
  }
}

function parentOutputHashes(transaction: NormalizedTonTransaction): string[] {
  return transaction.outMessages.map((entry) => entry.hash);
}

function mapTrace(traceBody: unknown, scan: Record<string, unknown>, blocks: Map<string, Record<string, unknown>>, headBody: unknown, recipient: string, fetchedAtMs: number, preset: TonPreset): NormalizedTonEvidence {
  const traces = object(traceBody).traces;
  if (!Array.isArray(traces) || traces.length !== 1) throw new ProviderFailure('provider_schema_invalid');
  const trace = object(traces[0]);
  const traceId = base64Hash(trace.trace_id);
  if (trace.external_hash !== undefined && trace.external_hash !== null) base64Hash(trace.external_hash);
  const scanFacts = validateScanRow(scan, recipient);
  if (traceId !== scanFacts.traceId || bool(trace.is_incomplete)) throw new ProviderFailure('provider_schema_invalid');
  const startMc = decimal(trace.mc_seqno_start); const endMc = decimal(trace.mc_seqno_end);
  if (BigInt(startMc) > BigInt(endMc) || BigInt(endMc) > BigInt(Number.MAX_SAFE_INTEGER)) throw new ProviderFailure('provider_schema_invalid');
  const startLt = decimal(trace.start_lt); const endLt = decimal(trace.end_lt);
  const startUtime = secondsToMs(trace.start_utime); const endUtime = secondsToMs(trace.end_utime);
  if (BigInt(startLt) > BigInt(endLt) || startUtime > endUtime) throw new ProviderFailure('provider_schema_invalid');
  const range: TraceRange = { traceId, startMc: BigInt(startMc), endMc: BigInt(endMc), startLt: BigInt(startLt), endLt: BigInt(endLt), startTimeMs: startUtime, endTimeMs: endUtime };
  const info = object(trace.trace_info);
  if (info.trace_state !== 'complete' || integer(info.pending_messages) !== 0) throw new ProviderFailure('provider_schema_invalid');
  const order = trace.transactions_order;
  const transactions = object(trace.transactions);
  if (!Array.isArray(order) || order.length === 0 || order.length > TON_EVIDENCE_LIMITS.maxTraceTransactions || Object.keys(transactions).length !== order.length || integer(info.transactions) !== order.length) throw new ProviderFailure('provider_schema_invalid');
  const canonicalOrder = order.map((hash) => base64Hash(hash));
  if (new Set(canonicalOrder).size !== canonicalOrder.length) throw new ProviderFailure('provider_schema_invalid');
  const traceInputFingerprints = new Map<string, string>();
  const mapped = order.map((rawHash, index): NormalizedTonTransaction => {
    const rawHashText = string(rawHash); const tx = object(transactions[rawHashText]);
    const txHash = base64Hash(tx.hash);
    if (txHash !== base64Hash(rawHashText) || base64Hash(tx.trace_id) !== traceId) throw new ProviderFailure('provider_schema_invalid');
    const block = validateBlockRef(tx.block_ref); const key = `${block.workchain}:${block.shard}:${block.seqno}`; const anchor = blocks.get(key);
    if (!anchor || signedInteger(anchor.workchain) !== block.workchain || shard(anchor.shard) !== block.shard || integer(anchor.seqno) !== block.seqno) throw new ProviderFailure('provider_schema_invalid');
    const mcRef = object(anchor.masterchain_block_ref);
    const mcSeqno = integer(tx.mc_block_seqno);
    if (BigInt(mcSeqno) < range.startMc || BigInt(mcSeqno) > range.endMc || integer(mcRef.seqno) !== mcSeqno) throw new ProviderFailure('provider_schema_invalid');
    const lt = decimal(tx.lt); const chainTimeMs = secondsToMs(tx.now);
    if (BigInt(lt) < range.startLt || BigInt(lt) > range.endLt || chainTimeMs < range.startTimeMs || chainTimeMs > range.endTimeMs) throw new ProviderFailure('provider_schema_invalid');
    const execution = executionFacts(tx.description);
    const inMessage = message(tx.in_msg, 0, index === 0); const outs = tx.out_msgs;
    traceInputFingerprints.set(txHash, providerMessageFingerprint(tx.in_msg));
    if (!Array.isArray(outs) || outs.length + 1 > TON_EVIDENCE_LIMITS.maxMessagesPerTransaction) throw new ProviderFailure('provider_schema_invalid');
    string(tx.finality);
    return { account: address(tx.account), hash: txHash, lt, chainTimeMs, emulated: bool(tx.emulated), ...execution, blockRef: { workchain: block.workchain, shard: block.shard, seqno: block.seqno, rootHash: base64Hash(anchor.root_hash), fileHash: base64Hash(anchor.file_hash), masterchainSeqno: integer(mcRef.seqno) }, inMessage, outMessages: outs.map((entry, outIndex) => message(entry, outIndex, false)) };
  });
  const transactionMap = new Map(mapped.map((transaction) => [transaction.hash, transaction]));
  const traceMessageHashes = new Set(mapped.flatMap((transaction) => [transaction.inMessage.hash, ...transaction.outMessages.map((entry) => entry.hash)]));
  if (integer(info.messages) !== traceMessageHashes.size) throw new ProviderFailure('provider_schema_invalid');
  validateTraceTree(trace.trace, transactionMap, canonicalOrder);
  const selected = mapped.filter((tx) => tx.account === scanFacts.account && tx.hash === scanFacts.hash
    && tx.lt === scanFacts.lt && sameMessageFacts(tx.inMessage, scanFacts.inMessage)
    && traceInputFingerprints.get(tx.hash) === scanFacts.inMessageFingerprint);
  const selectedTransaction = selected[0];
  if (!selectedTransaction || selected.length !== 1) throw new ProviderFailure('provider_schema_invalid');
  const head = object(headBody);
  const firstHead = validateHeadBlock(head.first);
  const last = validateHeadBlock(head.last);
  if (firstHead.seqno > last.seqno) throw new ProviderFailure('provider_schema_invalid');
  const canonical = { schemaVersion: 1 as const, source: { providerId: preset.providerId, origin: preset.origin, evidenceModel: TON_EVIDENCE_MODEL, fetchedAtMs }, network: preset.network, asset: { network: preset.network, kind: 'native' as const, decimals: 9 }, trace: { id: traceId, complete: true, masterchainSeqno: Number(endMc), orderedTransactionHashes: mapped.map((tx) => tx.hash) }, latestIndexedMasterchain: last, transactions: mapped, creditPath: { kind: 'native' as const, recipientTransactionHash: scanFacts.hash, creditMessageHash: scanFacts.inMessage.hash } };
  const normalized = normalizeCanonicalTonEvidence(canonical, TON_EVIDENCE_LIMITS, preset);
  if ('kind' in normalized) throw new ProviderFailure(normalized.code);
  return normalized;
}

export function createToncenterV3Provider(config: ToncenterV3ProviderConfig): TonEvidenceProvider {
  const preset = config.preset ?? TON_PRESETS.testnet;
  canonicalBaseUrl(config.baseUrl, preset);
  const fetchImpl = config.fetchImpl ?? safeFetch;
  const nowMs = config.nowMs ?? Date.now;
  const request = async (path: string, query: URLSearchParams, signal: AbortSignal): Promise<unknown> => {
    // A cancellation already observed by the runner is a terminal operational
    // boundary for this request: do not start a new provider call.
    if (signal.aborted) throw new ProviderFailure('timeout');
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    signal.addEventListener('abort', abort, { once: true });
    try {
      const response = await fetchImpl(`${preset.origin}${path}?${query.toString()}`, { method: 'GET', signal: controller.signal, maxRedirects: 0 });
      const problem = statusFailure(response); if (problem) throw problem;
      return await jsonBody(response);
    } catch (error) {
      if (error instanceof ProviderFailure) throw error;
      if (error instanceof SsrfError && (error as SsrfError & { reason?: string }).reason === 'redirect_limit') throw new ProviderFailure('redirect_rejected');
      if (controller.signal.aborted) throw new ProviderFailure('timeout');
      throw new ProviderFailure('provider_schema_invalid');
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  };
  return {
    async resolveRecipientAccount(source) {
      if (source.asset.kind === 'jetton') return failure('unsupported_asset');
      try { return { kind: 'resolved', recipientAccount: address(source.invoiceRecipient) }; } catch (error) { return failure(error instanceof ProviderFailure ? error.code : 'provider_schema_invalid'); }
    },
    async scanAccountPage(recipientAccount, cursor, signal) {
      try {
        const account = address(recipientAccount);
        const continuation = cursor === null ? null : cursorValue(cursor);
        const beforeLt = continuation?.beforeLt;
        const query = new URLSearchParams({ account, limit: String(PAGE_SIZE), offset: '0', sort: 'desc' }); if (beforeLt !== null && beforeLt !== undefined) query.set('end_lt', beforeLt);
        const page = object(await request('/api/v3/transactions', query, signal)); const rows = page.transactions;
        if (!Array.isArray(rows) || rows.length > PAGE_SIZE) throw new ProviderFailure('provider_schema_invalid');
        if (rows.length === 0) return { kind: 'page', evidence: [], nextCursor: null, exhausted: true };
        const validatedRows = rows.map((row) => ({ row: object(row), facts: validateScanRow(row, account) }));
        const first = validatedRows[0]!;
        let retained = validatedRows;
        if (continuation !== null) {
          const overlap = first.facts;
          if (overlap.account !== account || overlap.lt !== continuation.beforeLt || overlap.hash !== continuation.beforeTransactionHash) throw new ProviderFailure('pagination_regressed');
          retained = retained.slice(1); if (retained.length === 0) return { kind: 'page', evidence: [], nextCursor: null, exhausted: true };
        }
        let previous: bigint | null = null;
        for (const entry of retained) {
          const lt = BigInt(entry.facts.lt);
          if ((beforeLt !== null && beforeLt !== undefined && lt >= BigInt(beforeLt))
            || (continuation !== null && lt > BigInt(continuation.cycleUpperLt))
            || (previous !== null && lt >= previous)) throw new ProviderFailure('pagination_regressed');
          previous = lt;
        }
        const blocks = new Map<string, Record<string, unknown>>();
        const traced: Array<{ row: Record<string, unknown>; trace: unknown }> = [];
        for (const { row } of retained) {
          const trace = await request('/api/v3/traces', new URLSearchParams({ tx_hash: string(row.hash), include_actions: 'true', limit: '1', offset: '0' }), signal);
          const traceRows = object(trace).traces; if (!Array.isArray(traceRows) || traceRows.length !== 1) throw new ProviderFailure('provider_schema_invalid');
          for (const tx of Object.values(object(object(traceRows[0]).transactions))) {
            const block = validateBlockRef(object(tx).block_ref);
            const key = `${block.workchain}:${block.shard}:${block.seqno}`;
            if (!blocks.has(key)) {
              const response = object(await request('/api/v3/blocks', new URLSearchParams({ workchain: String(block.workchain), shard: block.shard, seqno: String(block.seqno), limit: '2' }), signal));
              if (!Array.isArray(response.blocks)) throw new ProviderFailure('provider_schema_invalid');
              const candidates = response.blocks.map(validateBlockAnchor);
              const matches = candidates.filter((candidate) => signedInteger(candidate.workchain) === block.workchain
                && shard(candidate.shard) === block.shard && integer(candidate.seqno) === block.seqno);
              if (matches.length !== 1) throw new ProviderFailure('provider_schema_invalid');
              blocks.set(key, matches[0]!);
            }
          }
          traced.push({ row, trace });
        }
        const head = await request('/api/v3/masterchainInfo', new URLSearchParams(), signal);
        const evidence = traced.map(({ row, trace }) => mapTrace(trace, row, blocks, head, account, nowMs(), preset));
        const finalRow = retained[retained.length - 1]!.facts;
        const cycleUpperLt = continuation?.cycleUpperLt ?? first.facts.lt;
        return { kind: 'page', evidence, nextCursor: { schemaVersion: 1, beforeLt: finalRow.lt, beforeTransactionHash: finalRow.hash, cycleUpperLt }, exhausted: false };
      } catch (error) { return failure(error instanceof ProviderFailure ? error.code : 'provider_schema_invalid', error instanceof ProviderFailure ? error.retryAfterMs : null); }
    },
  };
}
