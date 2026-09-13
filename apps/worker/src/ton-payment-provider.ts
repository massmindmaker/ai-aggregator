import type { TonInvoice } from '@aiag/database';
import { safeFetch } from '@aiag/shared/server';

import {
  normalizeCanonicalTonEvidence,
  TON_EVIDENCE_LIMITS,
  TON_EVIDENCE_MODEL,
  TON_PROVIDER_ID,
  TON_PROVIDER_ORIGIN,
  type NormalizedTonEvidence,
} from './ton-payment-evidence.js';

export type TonSourceErrorCode =
  | 'origin_mismatch' | 'redirect_rejected' | 'response_too_large'
  | 'http_unauthorized' | 'rate_limited' | 'timeout' | 'upstream_5xx'
  | 'provider_schema_invalid' | 'pagination_regressed' | 'recipient_binding_changed'
  | 'unsupported_asset';

export interface TonProviderCursor {
  schemaVersion: 1;
  beforeLt: string | null;
  cycleUpperLt: string | null;
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
  network: 'tvm:-3';
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
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ProviderFailure('provider_schema_invalid');
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== 'string') throw new ProviderFailure('provider_schema_invalid');
  return value;
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new ProviderFailure('provider_schema_invalid');
  return value as number;
}

function decimal(value: unknown): string {
  const result = string(value);
  if (result.length > 78 || !DECIMAL.test(result)) throw new ProviderFailure('provider_schema_invalid');
  return result;
}

function address(value: unknown): string {
  const result = string(value);
  if (!RAW_ADDRESS.test(result)) throw new ProviderFailure('provider_schema_invalid');
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

function secondsToMs(value: unknown): number {
  const seconds = integer(value);
  const milliseconds = seconds * 1000;
  if (!Number.isSafeInteger(milliseconds)) throw new ProviderFailure('provider_schema_invalid');
  return milliseconds;
}

function canonicalBaseUrl(baseUrl: string): URL {
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { throw new ProviderFailure('origin_mismatch'); }
  if (baseUrl !== 'https://testnet.toncenter.com/' || parsed.username !== '' || parsed.password !== '' || parsed.href !== 'https://testnet.toncenter.com/') {
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

function message(raw: unknown, index: number, externalAllowed: boolean): Record<string, unknown> {
  const item = object(raw);
  const source = item.source;
  const isExternal = source === null && item.created_lt === null && item.created_at === null;
  if (isExternal && !externalAllowed) throw new ProviderFailure('provider_schema_invalid');
  if (!isExternal && source === null) throw new ProviderFailure('provider_schema_invalid');
  const content = item.message_content === null || item.message_content === undefined ? null : object(item.message_content);
  const decoded = content?.decoded === undefined || content?.decoded === null ? null : object(content.decoded);
  let decodedPayload: Record<string, unknown> = { kind: 'other' };
  if (item.opcode === '0x00000000' && item.decoded_opcode === 'text_comment') {
    if (!decoded || decoded['@type'] !== 'text_comment' || decoded.type !== 'text_comment') throw new ProviderFailure('provider_schema_invalid');
    const reference = string(decoded.comment);
    if (reference.length < 1 || reference.length > 96 || reference.trim() !== reference || /[\u0000-\u001f\u007f]/.test(reference)) throw new ProviderFailure('provider_schema_invalid');
    decodedPayload = { kind: 'native_comment', reference };
  }
  const opcode = item.opcode === null ? null : string(item.opcode).toLowerCase();
  if (opcode !== null && !/^0x[0-9a-f]{8}$/.test(opcode)) throw new ProviderFailure('provider_schema_invalid');
  return {
    hash: base64Hash(item.hash), index, source: source === null ? null : address(source), destination: address(item.destination),
    bounced: isExternal ? false : bool(item.bounced), opcode, amountAtomic: item.value === null ? (isExternal ? '0' : (() => { throw new ProviderFailure('provider_schema_invalid'); })()) : decimal(item.value), decodedPayload,
  };
}

function mapTrace(traceBody: unknown, scan: Record<string, unknown>, blocks: Map<string, Record<string, unknown>>, headBody: unknown, recipient: string, fetchedAtMs: number): NormalizedTonEvidence {
  const traces = object(traceBody).traces;
  if (!Array.isArray(traces) || traces.length !== 1) throw new ProviderFailure('provider_schema_invalid');
  const trace = object(traces[0]);
  const traceId = base64Hash(trace.trace_id);
  if (traceId !== base64Hash(scan.trace_id) || bool(trace.is_incomplete)) throw new ProviderFailure('provider_schema_invalid');
  const startMc = decimal(trace.mc_seqno_start); const endMc = decimal(trace.mc_seqno_end);
  if (BigInt(startMc) > BigInt(endMc) || BigInt(endMc) > BigInt(Number.MAX_SAFE_INTEGER)) throw new ProviderFailure('provider_schema_invalid');
  const info = object(trace.trace_info);
  if (info.trace_state !== 'complete' || integer(info.pending_messages) !== 0) throw new ProviderFailure('provider_schema_invalid');
  const order = trace.transactions_order;
  const transactions = object(trace.transactions);
  if (!Array.isArray(order) || order.length === 0 || order.length > TON_EVIDENCE_LIMITS.maxTraceTransactions || Object.keys(transactions).length !== order.length) throw new ProviderFailure('provider_schema_invalid');
  const mapped = order.map((rawHash, index) => {
    const rawHashText = string(rawHash); const tx = object(transactions[rawHashText]);
    const txHash = base64Hash(tx.hash);
    if (txHash !== base64Hash(rawHashText) || base64Hash(tx.trace_id) !== traceId) throw new ProviderFailure('provider_schema_invalid');
    const block = object(tx.block_ref); const key = `${block.workchain}:${block.shard}:${block.seqno}`; const anchor = blocks.get(key);
    if (!anchor || integer(anchor.workchain) !== block.workchain || string(anchor.shard) !== block.shard || integer(anchor.seqno) !== block.seqno) throw new ProviderFailure('provider_schema_invalid');
    const mcRef = object(anchor.masterchain_block_ref);
    if (mcRef.workchain !== -1 || BigInt(String(tx.mc_block_seqno)) < BigInt(startMc) || BigInt(String(tx.mc_block_seqno)) > BigInt(endMc) || integer(mcRef.seqno) !== integer(tx.mc_block_seqno)) throw new ProviderFailure('provider_schema_invalid');
    const description = object(tx.description); const compute = description.compute_ph === null ? null : object(description.compute_ph); const action = description.action === null ? null : object(description.action);
    const inMessage = message(tx.in_msg, 0, true); const outs = tx.out_msgs;
    if (!Array.isArray(outs) || outs.length + 1 > TON_EVIDENCE_LIMITS.maxMessagesPerTransaction) throw new ProviderFailure('provider_schema_invalid');
    return { account: address(tx.account), hash: txHash, lt: decimal(tx.lt), chainTimeMs: secondsToMs(tx.now), emulated: bool(tx.emulated), aborted: bool(description.aborted), computeSuccess: compute !== null && compute.skipped === false && compute.success === true, actionSuccess: action !== null && action.success === true && action.valid === true, blockRef: { workchain: integer(block.workchain), shard: string(block.shard).toLowerCase(), seqno: integer(block.seqno), rootHash: base64Hash(anchor.root_hash), fileHash: base64Hash(anchor.file_hash), masterchainSeqno: integer(mcRef.seqno) }, inMessage, outMessages: outs.map((entry, outIndex) => message(entry, outIndex + 1, false)) };
  });
  const scanHash = base64Hash(scan.hash); const scanMessageHash = base64Hash(object(scan.in_msg).hash);
  const selected = mapped.filter((tx) => tx.account === recipient && tx.hash === scanHash && tx.lt === decimal(scan.lt) && tx.inMessage.hash === scanMessageHash);
  const selectedTransaction = selected[0];
  if (!selectedTransaction || selected.length !== 1 || object(selectedTransaction.inMessage.decodedPayload).kind !== 'native_comment') throw new ProviderFailure('provider_schema_invalid');
  const last = object(object(headBody).last);
  if (last.workchain !== -1) throw new ProviderFailure('provider_schema_invalid');
  const canonical = { schemaVersion: 1 as const, source: { providerId: TON_PROVIDER_ID, origin: TON_PROVIDER_ORIGIN, evidenceModel: TON_EVIDENCE_MODEL, fetchedAtMs }, network: 'tvm:-3', asset: { network: 'tvm:-3' as const, kind: 'native' as const, decimals: 9 }, trace: { id: traceId, complete: true, masterchainSeqno: Number(endMc), orderedTransactionHashes: mapped.map((tx) => tx.hash) }, latestIndexedMasterchain: { seqno: integer(last.seqno), rootHash: base64Hash(last.root_hash), fileHash: base64Hash(last.file_hash) }, transactions: mapped, creditPath: { kind: 'native' as const, recipientTransactionHash: scanHash, creditMessageHash: scanMessageHash } };
  const normalized = normalizeCanonicalTonEvidence(canonical, TON_EVIDENCE_LIMITS);
  if ('kind' in normalized) throw new ProviderFailure(normalized.code);
  return normalized;
}

export function createToncenterV3Provider(config: ToncenterV3ProviderConfig): TonEvidenceProvider {
  canonicalBaseUrl(config.baseUrl);
  const fetchImpl = config.fetchImpl ?? safeFetch;
  const nowMs = config.nowMs ?? Date.now;
  const request = async (path: string, query: URLSearchParams, signal: AbortSignal): Promise<unknown> => {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
    try {
      const response = await fetchImpl(`https://testnet.toncenter.com${path}?${query.toString()}`, { method: 'GET', signal: controller.signal, maxRedirects: 0 });
      const problem = statusFailure(response); if (problem) throw problem;
      return await jsonBody(response);
    } catch (error) {
      if (error instanceof ProviderFailure) throw error;
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
        const account = address(recipientAccount); if (cursor && (cursor.schemaVersion !== 1 || cursor.beforeLt === null || !DECIMAL.test(cursor.beforeLt) || (cursor.cycleUpperLt !== null && !DECIMAL.test(cursor.cycleUpperLt)))) throw new ProviderFailure('pagination_regressed');
        const beforeLt = cursor?.beforeLt;
        if (cursor && beforeLt === null) throw new ProviderFailure('pagination_regressed');
        const query = new URLSearchParams({ account, limit: String(PAGE_SIZE), offset: '0', sort: 'desc' }); if (beforeLt !== null && beforeLt !== undefined) query.set('end_lt', beforeLt);
        const page = object(await request('/api/v3/transactions', query, signal)); const rows = page.transactions;
        if (!Array.isArray(rows) || rows.length > PAGE_SIZE) throw new ProviderFailure('provider_schema_invalid');
        if (rows.length === 0) return { kind: 'page', evidence: [], nextCursor: null, exhausted: true };
        const first = object(rows[0]); let retained = rows.map(object);
        if (cursor) {
          const overlap = object(rows[0]);
          if (address(overlap.account) !== account || decimal(overlap.lt) !== cursor.beforeLt) throw new ProviderFailure('pagination_regressed');
          retained = retained.slice(1); if (retained.length === 0) return { kind: 'page', evidence: [], nextCursor: null, exhausted: true };
        }
        let previous: bigint | null = null;
        for (const row of retained) { const lt = BigInt(decimal(row.lt)); if ((beforeLt !== null && beforeLt !== undefined && lt >= BigInt(beforeLt)) || (previous !== null && lt >= previous)) throw new ProviderFailure('pagination_regressed'); previous = lt; }
        const blocks = new Map<string, Record<string, unknown>>();
        const traced: Array<{ row: Record<string, unknown>; trace: unknown }> = [];
        for (const row of retained) {
          const trace = await request('/api/v3/traces', new URLSearchParams({ tx_hash: string(row.hash), include_actions: 'true', limit: '1', offset: '0' }), signal);
          const traceRows = object(trace).traces; if (!Array.isArray(traceRows) || traceRows.length !== 1) throw new ProviderFailure('provider_schema_invalid');
          for (const tx of Object.values(object(object(traceRows[0]).transactions))) { const block = object(object(tx).block_ref); const key = `${block.workchain}:${block.shard}:${block.seqno}`; if (!blocks.has(key)) { const response = object(await request('/api/v3/blocks', new URLSearchParams({ workchain: String(block.workchain), shard: string(block.shard), seqno: String(block.seqno), limit: '2' }), signal)); const matches = (response.blocks as unknown[] | undefined)?.filter((candidate) => { const item = object(candidate); return item.workchain === block.workchain && item.shard === block.shard && item.seqno === block.seqno; }); if (!matches || matches.length !== 1) throw new ProviderFailure('provider_schema_invalid'); blocks.set(key, object(matches[0])); } }
          traced.push({ row, trace });
        }
        const head = await request('/api/v3/masterchainInfo', new URLSearchParams(), signal);
        const evidence = traced.map(({ row, trace }) => mapTrace(trace, row, blocks, head, account, nowMs()));
        const finalLt = decimal(retained[retained.length - 1]!.lt); const cycleUpperLt = cursor?.cycleUpperLt ?? decimal(first.lt);
        return { kind: 'page', evidence, nextCursor: { schemaVersion: 1, beforeLt: finalLt, cycleUpperLt }, exhausted: false };
      } catch (error) { return failure(error instanceof ProviderFailure ? error.code : 'provider_schema_invalid', error instanceof ProviderFailure ? error.retryAfterMs : null); }
    },
  };
}
