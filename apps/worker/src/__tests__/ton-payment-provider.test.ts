import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { TonInvoice } from '@aiag/database';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeFetch, SsrfError } from '@aiag/shared/server';

import { createToncenterV3Provider } from '../ton-payment-provider.js';
import type { NormalizedTonEvidence } from '../ton-payment-evidence.js';
import {
  TON_FINALITY_POLICY_ID,
  TON_VERIFIER_POLICY,
  TON_VERIFIER_VERSION,
  verifyChainCredit,
} from '../ton-payment-verifier.js';
import manifest from '../__fixtures__/ton/toncenter-v3-testnet/manifest.json';
import nativeAborted from '../__fixtures__/ton/toncenter-v3-testnet/native-aborted.sanitized.json';
import nativeBounced from '../__fixtures__/ton/toncenter-v3-testnet/native-bounced.sanitized.json';
import nativeSuccess from '../__fixtures__/ton/toncenter-v3-testnet/native-success.sanitized.json';

const RECIPIENT = `0:${'1'.repeat(64)}`;
const JETTON_MASTER = `0:${'2'.repeat(64)}`;
const FIXTURE_RECIPIENT = '0:203bb83b9b6efadceb8ff8069354e6558448e0e7363208a0c5ebad10cc9a7bd4';
const SUCCESS_TRANSACTION_KEY = 'nr6KZdblc7PLJ3JQ4cjR4swdFTJSQuOxI4CMx6QOBMg=';
const ABORTED_TRANSACTION_KEY = 'r2gVUukAiEDo1c5Z6tGeYK/vJyvebagHV6jGJYgqldE=';
const BOUNCED_TRANSACTION_KEY = 'WmjF8zruTo8EP4KTeDR3sfoDcOLAAjZWx4absPw1ZuQ=';

type JsonObject = Record<string, unknown>;
type FixtureRecord = {
  evidenceClass: string;
  realProvider: boolean;
  providerId: string;
  origin: string;
  network: string;
  capturedAt: string;
  method: string;
  endpointPath: string;
  query: JsonObject;
  contentType: string;
  rawResponsePersisted: boolean;
  redactions: string[];
  body: JsonObject;
  supportingResponses: Array<{ endpointPath: string; body: JsonObject }>;
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function source(kind: 'native' | 'jetton') {
  return {
    sourceId: 'source-native-test',
    network: 'tvm:-3' as const,
    invoiceRecipient: RECIPIENT,
    scanFloorTimeMs: 1_700_000_000_000,
    asset: kind === 'native'
      ? { network: 'tvm:-3' as const, kind: 'native' as const, decimals: 9 }
      : { network: 'tvm:-3' as const, kind: 'jetton' as const, masterAddress: JETTON_MASTER, decimals: 6 },
  };
}

function provider(fetchImpl = vi.fn()): ReturnType<typeof createToncenterV3Provider> {
  return createToncenterV3Provider({
    baseUrl: 'https://testnet.toncenter.com/',
    fetchImpl,
  });
}

function nativeFixtureFetch(mutateTrace?: (trace: Record<string, unknown>) => void) {
  const trace = structuredClone(nativeSuccess.body) as Record<string, unknown>;
  const traceRecord = (trace.traces as Array<Record<string, unknown>>)[0]!;
  mutateTrace?.(traceRecord);
  const recipientTransaction = (traceRecord.transactions as Record<string, Record<string, unknown>>)[
    SUCCESS_TRANSACTION_KEY
  ]!;
  const blocks = nativeSuccess.supportingResponses.find((entry) => entry.endpointPath === '/api/v3/blocks')!.body;
  const head = nativeSuccess.supportingResponses.find((entry) => entry.endpointPath === '/api/v3/masterchainInfo')!.body;
  return vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    const body = path === '/api/v3/transactions' ? { transactions: [recipientTransaction] }
      : path === '/api/v3/traces' ? trace
        : path === '/api/v3/blocks' ? blocks
          : path === '/api/v3/masterchainInfo' ? head : null;
    if (body === null) throw new Error(`unexpected path ${path}`);
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  });
}

function fixtureHarness(
  rawFixture: unknown,
  selectedTransactionKey: string,
  mutate: Partial<Record<'scan' | 'trace' | 'blocks' | 'head', (value: JsonObject) => void>> = {},
) {
  const fixture = rawFixture as FixtureRecord;
  const trace = structuredClone(fixture.body);
  const traceRecord = (trace.traces as JsonObject[])[0]!;
  const selected = structuredClone((traceRecord.transactions as Record<string, JsonObject>)[selectedTransactionKey]!);
  const blocks = structuredClone(fixture.supportingResponses.find((entry) => entry.endpointPath === '/api/v3/blocks')!.body);
  const head = structuredClone(fixture.supportingResponses.find((entry) => entry.endpointPath === '/api/v3/masterchainInfo')!.body);
  // The checked-in fixture is an exact trace capture. Only this bounded account
  // page wrapper is synthetic test setup; it is never presented as a capture.
  const syntheticScanWrapper = { evidenceClass: 'synthetic', realProvider: false, transactions: [selected] };
  mutate.scan?.(syntheticScanWrapper);
  mutate.trace?.(trace);
  mutate.blocks?.(blocks);
  mutate.head?.(head);
  const fetchImpl = vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    const body = path === '/api/v3/transactions' ? { transactions: syntheticScanWrapper.transactions }
      : path === '/api/v3/traces' ? trace
        : path === '/api/v3/blocks' ? blocks
          : path === '/api/v3/masterchainInfo' ? head : null;
    if (body === null) throw new Error(`unexpected path ${path}`);
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  });
  return {
    fetchImpl,
    recipient: String(selected.account).toLowerCase(),
    syntheticScanWrapper,
  };
}

function historicalInvoice(evidence: NormalizedTonEvidence): TonInvoice {
  if (evidence.creditPath.kind !== 'native') throw new Error('expected native evidence');
  const transaction = evidence.transactions.find((entry) => entry.hash === evidence.creditPath.recipientTransactionHash)!;
  const payload = transaction.inMessage.decodedPayload;
  if (payload.kind !== 'native_comment' || transaction.inMessage.source === null) throw new Error('expected native comment');
  const asset = { network: 'tvm:-3', kind: 'native', decimals: 9 } as const;
  return {
    schemaVersion: 1,
    product: 'aggregator',
    purpose: 'gateway_topup',
    invoiceId: '20000000-0000-4000-8000-000000000001',
    ownerId: '20000000-0000-4000-8000-000000000002',
    orgId: '20000000-0000-4000-8000-000000000003',
    orderId: '20000000-0000-4000-8000-000000000004',
    idempotencyKey: 'historical-native-structure',
    quoteId: 'historical-native-structure',
    quote: {
      schemaVersion: 1,
      quoteId: 'historical-native-structure',
      sourcePrice: { unit: 'gateway_microcredits', amountAtomic: '1' },
      asset,
      fx: {
        sourceUnit: 'gateway_microcredits', targetAsset: asset,
        numerator: transaction.inMessage.amountAtomic, denominator: '1', rounding: 'floor',
        source: 'historical-structural-test', observedAtMs: 1, expiresAtMs: evidence.source.fetchedAtMs + 1,
      },
      additionalFeeAtomic: '0', amountAtomic: transaction.inMessage.amountAtomic,
      quotedAtMs: 1, expiresAtMs: evidence.source.fetchedAtMs + 1,
    },
    grantMicrocredits: '1',
    priceRevision: 'historical-structural-test',
    network: 'tvm:-3', asset, amountAtomic: transaction.inMessage.amountAtomic,
    recipient: transaction.account, reference: payload.reference,
    expectedSender: transaction.inMessage.source,
    finalityPolicyId: TON_FINALITY_POLICY_ID,
    verifierVersion: TON_VERIFIER_VERSION,
    expiresAt: '2026-09-14T00:00:00.000Z',
    createdAt: '2026-09-13T00:00:00.000Z',
    status: 'pending', reviewReason: null,
  };
}

function mutatePath(root: JsonObject, path: readonly (string | number)[], value: unknown, remove = false): void {
  let cursor: unknown = root;
  for (const part of path.slice(0, -1)) cursor = (cursor as Record<string | number, unknown>)[part];
  const key = path[path.length - 1]!;
  if (remove) delete (cursor as Record<string | number, unknown>)[key];
  else (cursor as Record<string | number, unknown>)[key] = value;
}

function base64Hash(seed: number): string {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(seed, 28);
  return bytes.toString('base64');
}

type SyntheticCandidate = {
  row: JsonObject;
  trace: JsonObject;
  block: JsonObject;
};

function syntheticCandidate(lt: string, seed: number): SyntheticCandidate {
  const transactionHash = base64Hash(seed);
  const messageHash = base64Hash(seed + 10_000);
  const rootHash = base64Hash(20_000);
  const fileHash = base64Hash(20_001);
  const transaction: JsonObject = {
    account: RECIPIENT,
    hash: transactionHash,
    lt,
    trace_id: transactionHash,
    now: 1_700_000_000,
    mc_block_seqno: 100,
    emulated: false,
    finality: 'finalized',
    block_ref: { workchain: 0, shard: '8000000000000000', seqno: 200 },
    description: {
      aborted: false,
      compute_ph: { skipped: false, success: true, exit_code: 0, reason: null },
      action: { success: true, valid: true, result_code: 0 },
      bounce: null,
    },
    in_msg: {
      hash: messageHash,
      source: null,
      destination: RECIPIENT,
      value: null,
      opcode: '0x00000000',
      decoded_opcode: 'text_comment',
      bounce: null,
      bounced: null,
      created_lt: null,
      created_at: null,
      message_content: { decoded: { '@type': 'text_comment', type: 'text_comment', comment: `SYNTHETIC-${seed}` } },
    },
    out_msgs: [],
  };
  return {
    row: structuredClone(transaction),
    trace: {
      traces: [{
        trace_id: transactionHash,
        external_hash: base64Hash(seed + 20_000),
        is_incomplete: false,
        mc_seqno_start: '100', mc_seqno_end: '100',
        start_lt: lt, end_lt: lt,
        start_utime: 1_700_000_000, end_utime: 1_700_000_000,
        transactions_order: [transactionHash],
        transactions: { [transactionHash]: transaction },
        trace: { tx_hash: transactionHash, in_msg_hash: messageHash, children: [] },
        trace_info: { trace_state: 'complete', messages: 1, transactions: 1, pending_messages: 0 },
      }],
    },
    block: {
      workchain: 0, shard: '8000000000000000', seqno: 200,
      root_hash: rootHash, file_hash: fileHash,
      masterchain_block_ref: { workchain: -1, shard: '8000000000000000', seqno: 100 },
      start_lt: '1', end_lt: '999999999999999999', gen_utime: '1700000000', tx_count: 1,
    },
  };
}

function addSyntheticSecondChild(traceBody: JsonObject): void {
  const trace = (traceBody.traces as JsonObject[])[0]!;
  const transactions = trace.transactions as Record<string, JsonObject>;
  const rootKey = String((trace.transactions_order as string[])[0]);
  const root = transactions[rootKey]!;
  const existingChildNode = structuredClone((trace.trace as JsonObject).children as JsonObject[])[0]!;
  const existingOutput = structuredClone((root.out_msgs as JsonObject[])[0]!);
  const siblingHash = base64Hash(80_001);
  const siblingTransactionHash = base64Hash(80_002);
  const siblingAccount = `0:${'7'.repeat(64)}`;
  const siblingMessage: JsonObject = {
    ...existingOutput,
    hash: siblingHash,
    destination: siblingAccount,
    value: '1',
    opcode: null,
    decoded_opcode: null,
    message_content: null,
  };
  root.out_msgs = [siblingMessage, existingOutput];
  const siblingTransaction = structuredClone(transactions[SUCCESS_TRANSACTION_KEY]!);
  siblingTransaction.account = siblingAccount;
  siblingTransaction.hash = siblingTransactionHash;
  siblingTransaction.lt = '96307052000004';
  siblingTransaction.in_msg = structuredClone(siblingMessage);
  siblingTransaction.out_msgs = [];
  transactions[siblingTransactionHash] = siblingTransaction;
  trace.transactions_order = [rootKey, siblingTransactionHash, SUCCESS_TRANSACTION_KEY];
  (trace.trace as JsonObject).children = [
    { tx_hash: siblingTransactionHash, in_msg_hash: siblingHash, children: [] },
    existingChildNode,
  ];
  (trace.trace_info as JsonObject).transactions = 3;
  (trace.trace_info as JsonObject).messages = 3;
}

function paginatedFetch(rawPages: JsonObject[][], candidates: SyntheticCandidate[]) {
  let pageIndex = 0;
  const byHash = new Map(candidates.map((candidate) => [String(candidate.row.hash), candidate]));
  return vi.fn(async (url: string) => {
    const parsed = new URL(url);
    let body: unknown;
    if (parsed.pathname === '/api/v3/transactions') {
      body = { transactions: rawPages[pageIndex++] ?? [] };
    } else if (parsed.pathname === '/api/v3/traces') {
      body = byHash.get(parsed.searchParams.get('tx_hash') ?? '')?.trace;
    } else if (parsed.pathname === '/api/v3/blocks') {
      body = { blocks: [candidates[0]!.block] };
    } else if (parsed.pathname === '/api/v3/masterchainInfo') {
      body = {
        first: { workchain: -1, shard: '8000000000000000', seqno: 1, root_hash: base64Hash(30_000), file_hash: base64Hash(30_001) },
        last: { workchain: -1, shard: '8000000000000000', seqno: 102, root_hash: base64Hash(30_002), file_hash: base64Hash(30_003) },
      };
    }
    if (body === undefined) throw new Error(`unexpected synthetic request ${url}`);
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  });
}

async function scanFixture(
  fixture: unknown,
  selectedTransactionKey: string,
  mutate: Parameters<typeof fixtureHarness>[2] = {},
) {
  const harness = fixtureHarness(fixture, selectedTransactionKey, mutate);
  return provider(harness.fetchImpl).scanAccountPage(harness.recipient, null, new AbortController().signal);
}

describe('createToncenterV3Provider', () => {
  it('returns the canonical native recipient without a provider request', async () => {
    const fetchImpl = vi.fn();
    await expect(provider(fetchImpl).resolveRecipientAccount(source('native'), new AbortController().signal))
      .resolves.toEqual({ kind: 'resolved', recipientAccount: RECIPIENT });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects jetton before a provider request', async () => {
    const fetchImpl = vi.fn();
    await expect(provider(fetchImpl).resolveRecipientAccount(source('jetton'), new AbortController().signal))
      .resolves.toEqual({ kind: 'source_error', code: 'unsupported_asset', retryAfterMs: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    'http://testnet.toncenter.com/',
    'https://testnet.toncenter.com:443/',
    'https://testnet.toncenter.com/api/v3/',
    'https://testnet.toncenter.com/?next=https://localhost/',
    'https://user:pass@testnet.toncenter.com/',
    'https://127.0.0.1/',
    'https://[::1]/',
    'https://localhost/',
    'https://10.0.0.1/',
    'https://[fe80::1]/',
    'https://169.254.169.254/',
  ])('rejects a non-exact base URL: %s', (baseUrl) => {
    expect(() => createToncenterV3Provider({ baseUrl, fetchImpl: vi.fn() })).toThrow('origin_mismatch');
  });

  it('maps the checked-in native provider fixture with zero-based outgoing indexes', async () => {
    const result = await provider(nativeFixtureFetch()).scanAccountPage(FIXTURE_RECIPIENT, null, new AbortController().signal);
    expect(result).toMatchObject({ kind: 'page', exhausted: false });
    if (result.kind !== 'page') throw new Error('expected fixture page');
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]!.transactions.map((transaction) => ({
      inIndex: transaction.inMessage.index,
      outIndexes: transaction.outMessages.map((message) => message.index),
    }))).toEqual([{ inIndex: 0, outIndexes: [0] }, { inIndex: 0, outIndexes: [] }]);
    expect(result.nextCursor).toMatchObject({ schemaVersion: 1, beforeLt: '96307052000005', cycleUpperLt: '96307052000005' });
    expect(result.nextCursor?.beforeTransactionHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails closed when a required trace completeness fact is removed', async () => {
    const result = await provider(nativeFixtureFetch((trace) => { delete trace.trace; }))
      .scanAccountPage(RECIPIENT, null, new AbortController().signal);
    expect(result).toEqual({ kind: 'source_error', code: 'provider_schema_invalid', retryAfterMs: null });
  });

  it('uses the hardened fetch boundary with a fixed path, bounded timeout and no redirects', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ transactions: [] }), {
      headers: { 'content-type': 'application/json' },
    }));
    const result = await provider(fetchImpl).scanAccountPage(RECIPIENT, null, new AbortController().signal);

    expect(result).toEqual({ kind: 'page', evidence: [], nextCursor: null, exhausted: true });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, options] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`https://testnet.toncenter.com/api/v3/transactions?account=${encodeURIComponent(RECIPIENT)}&limit=8&offset=0&sort=desc`);
    expect(options).toMatchObject({ method: 'GET', maxRedirects: 0 });
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    [new Response('', { status: 302, headers: { location: 'https://example.test/' } }), 'redirect_rejected'],
    [new Response('', { status: 401 }), 'http_unauthorized'],
    [new Response('', { status: 503 }), 'upstream_5xx'],
    [new Response('not json', { headers: { 'content-type': 'text/plain' } }), 'provider_schema_invalid'],
    [new Response(JSON.stringify({ transactions: [] }), { headers: { 'content-type': 'application/json', 'content-length': '1048577' } }), 'response_too_large'],
  ])('fails closed for bounded transport response', async (response, code) => {
    const result = await provider(vi.fn().mockResolvedValue(response))
      .scanAccountPage(RECIPIENT, null, new AbortController().signal);
    expect(result).toEqual({ kind: 'source_error', code, retryAfterMs: null });
  });

  it('bounds Retry-After for rate limits', async () => {
    const response = new Response('', { status: 429, headers: { 'retry-after': '9999999' } });
    const result = await provider(vi.fn().mockResolvedValue(response))
      .scanAccountPage(RECIPIENT, null, new AbortController().signal);
    expect(result).toEqual({ kind: 'source_error', code: 'rate_limited', retryAfterMs: 900_000 });
  });

  it('maps only safeFetch redirect-limit rejection to redirect_rejected', async () => {
    const redirectLimit = new SsrfError('too many redirects (>0)', 'redirect_limit');
    const result = await provider(vi.fn().mockRejectedValue(redirectLimit))
      .scanAccountPage(RECIPIENT, null, new AbortController().signal);
    expect(result).toEqual({ kind: 'source_error', code: 'redirect_rejected', retryAfterMs: null });
  });

  it('does not fetch when the caller signal was already aborted', async () => {
    const controller = new AbortController(); controller.abort();
    const fetchImpl = vi.fn();
    const result = await provider(fetchImpl).scanAccountPage(RECIPIENT, null, controller.signal);
    expect(result).toEqual({ kind: 'source_error', code: 'timeout', retryAfterMs: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an inclusive overlap row with a different transaction hash', async () => {
    const trace = nativeSuccess.body.traces[0]!;
    const overlap = trace.transactions['nr6KZdblc7PLJ3JQ4cjR4swdFTJSQuOxI4CMx6QOBMg=']!;
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ transactions: [overlap] }), {
      headers: { 'content-type': 'application/json' },
    }));
    const result = await provider(fetchImpl).scanAccountPage(FIXTURE_RECIPIENT, {
      schemaVersion: 1,
      beforeLt: '96307052000005',
      beforeTransactionHash: '0'.repeat(64),
      cycleUpperLt: '96307052000005',
    }, new AbortController().signal);
    expect(result).toEqual({ kind: 'source_error', code: 'pagination_regressed', retryAfterMs: null });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    { schemaVersion: 1, beforeLt: '2', cycleUpperLt: '2' },
    { schemaVersion: 1, beforeLt: '2', beforeTransactionHash: 'A'.repeat(64), cycleUpperLt: '2' },
    { schemaVersion: 1, beforeLt: '9'.repeat(79), beforeTransactionHash: 'a'.repeat(64), cycleUpperLt: '9'.repeat(79) },
    { schemaVersion: 1, beforeLt: '3', beforeTransactionHash: 'a'.repeat(64), cycleUpperLt: '2' },
    { schemaVersion: 1, beforeLt: '2', beforeTransactionHash: 'a'.repeat(64), cycleUpperLt: '2', extra: true },
  ])('rejects a non-canonical continuation cursor before fetching', async (cursor) => {
    const fetchImpl = vi.fn();
    const result = await provider(fetchImpl).scanAccountPage(RECIPIENT, cursor as never, new AbortController().signal);
    expect(result).toEqual({ kind: 'source_error', code: 'pagination_regressed', retryAfterMs: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('TON Center real-fixture boundary', () => {
  const fixtureEntries = [
    ['nativeSuccess', 'native-success.sanitized.json', nativeSuccess],
    ['nativeAborted', 'native-aborted.sanitized.json', nativeAborted],
    ['nativeBounced', 'native-bounced.sanitized.json', nativeBounced],
  ] as const;

  function requireRealFixture(value: unknown): FixtureRecord {
    const candidate = value as FixtureRecord;
    if (candidate.evidenceClass !== 'sanitized_real_provider_response' || candidate.realProvider !== true) {
      throw new Error('synthetic fixture is forbidden in the real provider suite');
    }
    return candidate;
  }

  it.each(fixtureEntries)('pins metadata, size, and manifest SHA for %s', async (manifestKey, filename, rawFixture) => {
    const fixture = requireRealFixture(rawFixture);
    expect(fixture).toMatchObject({
      evidenceClass: 'sanitized_real_provider_response', realProvider: true,
      providerId: 'toncenter-v3-testnet', origin: 'https://testnet.toncenter.com',
      network: 'tvm:-3', method: 'GET', endpointPath: '/api/v3/traces',
      contentType: 'application/json', rawResponsePersisted: false,
    });
    expect(Number.isNaN(Date.parse(fixture.capturedAt))).toBe(false);
    expect(fixture.redactions.length).toBeGreaterThan(0);
    expect(fixture.body).toHaveProperty('traces');
    const path = fileURLToPath(new URL(`../__fixtures__/ton/toncenter-v3-testnet/${filename}`, import.meta.url));
    const bytes = await readFile(path);
    const pinned = manifest.fixtures[manifestKey];
    expect(bytes.byteLength).toBe(pinned.bytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(pinned.sha256);
    expect(pinned.status).toBe('captured');
  });

  it('rejects a synthetic label before admitting a fixture to the real suite', () => {
    expect(() => requireRealFixture({ ...nativeSuccess, evidenceClass: 'synthetic', realProvider: false }))
      .toThrow('synthetic fixture is forbidden');
  });

  it('maps the real native success fixture through provider and pure verifier', async () => {
    const result = await scanFixture(nativeSuccess, SUCCESS_TRANSACTION_KEY);
    expect(result).toMatchObject({ kind: 'page', exhausted: false });
    if (result.kind !== 'page') throw new Error('expected page');
    const evidence = result.evidence[0]!;
    expect(verifyChainCredit(historicalInvoice(evidence), evidence, TON_VERIFIER_POLICY))
      .toMatchObject({ kind: 'verified' });
  });

  it('maps an explicitly synthetic multi-child derivative with output slots 0 and 1', async () => {
    const syntheticTraceDerivative = {
      evidenceClass: 'synthetic', realProvider: false,
      apply: addSyntheticSecondChild,
    };
    const result = await scanFixture(nativeSuccess, SUCCESS_TRANSACTION_KEY, {
      trace: syntheticTraceDerivative.apply,
    });
    expect(syntheticTraceDerivative).toMatchObject({ evidenceClass: 'synthetic', realProvider: false });
    expect(result).toMatchObject({ kind: 'page' });
    if (result.kind !== 'page') throw new Error('expected page');
    expect(result.evidence[0]!.transactions[0]!.outMessages.map((message) => message.index)).toEqual([0, 1]);
    expect(verifyChainCredit(historicalInvoice(result.evidence[0]!), result.evidence[0]!, TON_VERIFIER_POLICY))
      .toMatchObject({ kind: 'verified' });
  });

  it.each([
    ['native-aborted', nativeAborted, ABORTED_TRANSACTION_KEY],
    ['native-bounced sharing the same provider trace', nativeBounced, BOUNCED_TRANSACTION_KEY],
  ] as const)('maps %s structurally and preserves trace_aborted precedence', async (_label, fixture, selectedKey) => {
    const result = await scanFixture(fixture, selectedKey);
    expect(result).toMatchObject({ kind: 'page' });
    if (result.kind !== 'page') throw new Error('expected page');
    const success = await scanFixture(nativeSuccess, SUCCESS_TRANSACTION_KEY);
    if (success.kind !== 'page') throw new Error('expected success page');
    expect(verifyChainCredit(historicalInvoice(success.evidence[0]!), result.evidence[0]!, TON_VERIFIER_POLICY))
      .toMatchObject({ kind: 'review_required', reason: 'trace_aborted' });
  });

  it('accepts only the manifest optional-null omissions present in the real negative capture', async () => {
    const trace = nativeAborted.body.traces[0]!;
    expect('external_hash' in trace).toBe(false);
    expect('message_content' in trace.transactions[ABORTED_TRANSACTION_KEY]!.in_msg).toBe(false);
    const result = await scanFixture(nativeAborted, ABORTED_TRANSACTION_KEY);
    expect(result).toMatchObject({ kind: 'page', evidence: [{ trace: { complete: true } }] });
  });

  it('uses an explicitly synthetic derivative to isolate trace_bounced', async () => {
    const mapped = await scanFixture(nativeBounced, BOUNCED_TRANSACTION_KEY);
    const success = await scanFixture(nativeSuccess, SUCCESS_TRANSACTION_KEY);
    if (mapped.kind !== 'page' || success.kind !== 'page') throw new Error('expected pages');
    const syntheticDerivative = {
      evidenceClass: 'synthetic', realProvider: false,
      evidence: structuredClone(mapped.evidence[0]!),
    };
    for (const transaction of syntheticDerivative.evidence.transactions) {
      transaction.aborted = false;
      transaction.computeSuccess = true;
      transaction.actionSuccess = true;
    }
    expect(syntheticDerivative).toMatchObject({ evidenceClass: 'synthetic', realProvider: false });
    expect(verifyChainCredit(historicalInvoice(success.evidence[0]!), syntheticDerivative.evidence, TON_VERIFIER_POLICY))
      .toMatchObject({ kind: 'review_required', reason: 'trace_bounced' });
  });
});

describe('bounded transport contract', () => {
  it('rejects a streamed body once it crosses one MiB', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_048_576));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const result = await provider(vi.fn().mockResolvedValue(new Response(stream, {
      headers: { 'content-type': 'application/json' },
    }))).scanAccountPage(RECIPIENT, null, new AbortController().signal);
    expect(result).toEqual({ kind: 'source_error', code: 'response_too_large', retryAfterMs: null });
  });

  it('accepts a bounded JSON stream when Content-Length is absent', async () => {
    const result = await provider(vi.fn().mockResolvedValue(new Response(JSON.stringify({ transactions: [] }), {
      headers: { 'content-type': 'application/json' },
    }))).scanAccountPage(RECIPIENT, null, new AbortController().signal);
    expect(result).toEqual({ kind: 'page', evidence: [], nextCursor: null, exhausted: true });
  });

  it('rejects invalid JSON even with the correct content type', async () => {
    const result = await provider(vi.fn().mockResolvedValue(new Response('{', {
      headers: { 'content-type': 'application/json' },
    }))).scanAccountPage(RECIPIENT, null, new AbortController().signal);
    expect(result).toEqual({ kind: 'source_error', code: 'provider_schema_invalid', retryAfterMs: null });
  });

  it('classifies 403 as unauthorized', async () => {
    const result = await provider(vi.fn().mockResolvedValue(new Response('', { status: 403 })))
      .scanAccountPage(RECIPIENT, null, new AbortController().signal);
    expect(result).toEqual({ kind: 'source_error', code: 'http_unauthorized', retryAfterMs: null });
  });

  it('maps the internal eight-second timeout to the operational timeout code', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    const pending = provider(fetchImpl as never).scanAccountPage(RECIPIENT, null, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(pending).resolves.toEqual({ kind: 'source_error', code: 'timeout', retryAfterMs: null });
  });

  it('propagates a later caller abort to the internal request signal', async () => {
    const caller = new AbortController();
    let internalSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      internalSignal = options.signal ?? undefined;
      options.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    const pending = provider(fetchImpl as never).scanAccountPage(RECIPIENT, null, caller.signal);
    caller.abort();
    await expect(pending).resolves.toEqual({ kind: 'source_error', code: 'timeout', retryAfterMs: null });
    expect(internalSignal?.aborted).toBe(true);
  });

  it('runs a mocked redirect through actual safeFetch and the adapter seam', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', {
      status: 302, headers: { location: 'https://testnet.toncenter.com/next' },
    })));
    const throughSafeFetch = (url: string | URL, options: Parameters<typeof safeFetch>[1]) => safeFetch(url, {
      ...options,
      allowlist: ['testnet.toncenter.com'],
    });
    const result = await provider(throughSafeFetch).scanAccountPage(RECIPIENT, null, new AbortController().signal);
    expect(result).toEqual({ kind: 'source_error', code: 'redirect_rejected', retryAfterMs: null });
  });
});

describe('exact continuation pagination', () => {
  it('preserves the first-page upper LT across a complete continuation with inclusive overlap', async () => {
    const newest = syntheticCandidate('300', 1);
    const overlap = syntheticCandidate('200', 2);
    const older = syntheticCandidate('100', 3);
    const fetchImpl = paginatedFetch([
      [newest.row, overlap.row],
      [overlap.row, older.row],
    ], [newest, overlap, older]);
    const adapter = provider(fetchImpl);
    const first = await adapter.scanAccountPage(RECIPIENT, null, new AbortController().signal);
    expect(first).toMatchObject({ kind: 'page', exhausted: false, nextCursor: { beforeLt: '200', cycleUpperLt: '300' } });
    if (first.kind !== 'page') throw new Error('expected first page');
    const continuation = await adapter.scanAccountPage(RECIPIENT, first.nextCursor, new AbortController().signal);
    expect(continuation).toMatchObject({ kind: 'page', exhausted: false, nextCursor: { beforeLt: '100', cycleUpperLt: '300' } });
    if (continuation.kind !== 'page') throw new Error('expected continuation');
    expect(continuation.evidence).toHaveLength(1);
    const transactionCalls = fetchImpl.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/api/v3/transactions');
    expect(new URL(String(transactionCalls[1]![0])).searchParams.get('end_lt')).toBe('200');
  });

  it('does not admit a row inserted above the pinned cycle upper bound', async () => {
    const overlap = syntheticCandidate('200', 4);
    const inserted = syntheticCandidate('400', 5);
    const fetchImpl = paginatedFetch([[overlap.row, inserted.row]], [overlap, inserted]);
    const result = await provider(fetchImpl).scanAccountPage(RECIPIENT, {
      schemaVersion: 1, beforeLt: '200', beforeTransactionHash: Buffer.from(String(overlap.row.hash), 'base64').toString('hex'), cycleUpperLt: '300',
    }, new AbortController().signal);
    expect(result).toEqual({ kind: 'source_error', code: 'pagination_regressed', retryAfterMs: null });
    expect(fetchImpl.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/api/v3/traces')).toHaveLength(0);
  });

  it('treats an exact overlap-only page as terminal', async () => {
    const overlap = syntheticCandidate('200', 6);
    const fetchImpl = paginatedFetch([[overlap.row]], [overlap]);
    const result = await provider(fetchImpl).scanAccountPage(RECIPIENT, {
      schemaVersion: 1, beforeLt: '200', beforeTransactionHash: Buffer.from(String(overlap.row.hash), 'base64').toString('hex'), cycleUpperLt: '300',
    }, new AbortController().signal);
    expect(result).toEqual({ kind: 'page', evidence: [], nextCursor: null, exhausted: true });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing overlap', ['100']],
    ['repeated overlap after overlap removal', ['200', '200']],
    ['ascending retained LTs', ['200', '100', '150']],
  ] as const)('rejects %s before any trace lookup', async (_label, lts) => {
    const candidates = lts.map((lt, index) => syntheticCandidate(lt, 100 + index));
    const expectedOverlap = syntheticCandidate('200', 100);
    const fetchImpl = paginatedFetch([candidates.map((entry) => entry.row)], candidates);
    const result = await provider(fetchImpl).scanAccountPage(RECIPIENT, {
      schemaVersion: 1, beforeLt: '200', beforeTransactionHash: Buffer.from(String(expectedOverlap.row.hash), 'base64').toString('hex'), cycleUpperLt: '300',
    }, new AbortController().signal);
    expect(result).toEqual({ kind: 'source_error', code: 'pagination_regressed', retryAfterMs: null });
    expect(fetchImpl.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/api/v3/traces')).toHaveLength(0);
  });

  it.each([
    false, 0, '', undefined, [], new Date(0), Object.create({ inherited: true }),
  ])('rejects every falsy or non-plain non-null cursor before the network: %j', async (cursor) => {
    const fetchImpl = vi.fn();
    const result = await provider(fetchImpl).scanAccountPage(RECIPIENT, cursor as never, new AbortController().signal);
    expect(result).toEqual({ kind: 'source_error', code: 'pagination_regressed', retryAfterMs: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('required endpoint fact mutation matrix', () => {
  type MutationCase = {
    label: string;
    target: 'scan' | 'trace' | 'blocks' | 'head';
    path: readonly (string | number)[];
    wrong: unknown;
  };
  const scan = (...path: (string | number)[]) => ['transactions', 0, ...path] as const;
  const trace = (...path: (string | number)[]) => ['traces', 0, ...path] as const;
  const transaction = (...path: (string | number)[]) => trace('transactions', SUCCESS_TRANSACTION_KEY, ...path);
  const incoming = (...path: (string | number)[]) => transaction('in_msg', ...path);
  const cases: MutationCase[] = [
    { label: 'transactions response array', target: 'scan', path: ['transactions'], wrong: {} },
    { label: 'scan account', target: 'scan', path: scan('account'), wrong: 1 },
    { label: 'scan hash', target: 'scan', path: scan('hash'), wrong: 1 },
    { label: 'scan LT', target: 'scan', path: scan('lt'), wrong: 1 },
    { label: 'scan time', target: 'scan', path: scan('now'), wrong: '1' },
    { label: 'scan masterchain seqno', target: 'scan', path: scan('mc_block_seqno'), wrong: '1' },
    { label: 'scan trace id', target: 'scan', path: scan('trace_id'), wrong: 1 },
    { label: 'scan emulated', target: 'scan', path: scan('emulated'), wrong: 'false' },
    { label: 'scan finality', target: 'scan', path: scan('finality'), wrong: null },
    { label: 'scan block ref', target: 'scan', path: scan('block_ref'), wrong: null },
    { label: 'scan block workchain', target: 'scan', path: scan('block_ref', 'workchain'), wrong: '0' },
    { label: 'scan block shard', target: 'scan', path: scan('block_ref', 'shard'), wrong: 1 },
    { label: 'scan block seqno', target: 'scan', path: scan('block_ref', 'seqno'), wrong: '1' },
    { label: 'scan inbound message', target: 'scan', path: scan('in_msg'), wrong: null },
    { label: 'scan inbound hash', target: 'scan', path: scan('in_msg', 'hash'), wrong: 1 },
    { label: 'scan inbound source nullable type', target: 'scan', path: scan('in_msg', 'source'), wrong: 1 },
    { label: 'scan inbound destination', target: 'scan', path: scan('in_msg', 'destination'), wrong: 1 },
    { label: 'scan inbound value nullable type', target: 'scan', path: scan('in_msg', 'value'), wrong: 1 },
    { label: 'scan inbound opcode nullable type', target: 'scan', path: scan('in_msg', 'opcode'), wrong: 1 },
    { label: 'scan inbound decoded opcode nullable type', target: 'scan', path: scan('in_msg', 'decoded_opcode'), wrong: 1 },
    { label: 'scan inbound bounce nullable type', target: 'scan', path: scan('in_msg', 'bounce'), wrong: 'true' },
    { label: 'scan inbound bounced nullable type', target: 'scan', path: scan('in_msg', 'bounced'), wrong: 'false' },
    { label: 'scan inbound created LT nullable type', target: 'scan', path: scan('in_msg', 'created_lt'), wrong: 1 },
    { label: 'scan inbound created at nullable type', target: 'scan', path: scan('in_msg', 'created_at'), wrong: 1 },
    { label: 'scan outgoing messages', target: 'scan', path: scan('out_msgs'), wrong: null },

    { label: 'traces response array', target: 'trace', path: ['traces'], wrong: {} },
    { label: 'trace id', target: 'trace', path: trace('trace_id'), wrong: 1 },
    { label: 'trace incomplete flag', target: 'trace', path: trace('is_incomplete'), wrong: 'false' },
    { label: 'trace masterchain start', target: 'trace', path: trace('mc_seqno_start'), wrong: 1 },
    { label: 'trace masterchain end', target: 'trace', path: trace('mc_seqno_end'), wrong: 1 },
    { label: 'trace LT start', target: 'trace', path: trace('start_lt'), wrong: 1 },
    { label: 'trace LT end', target: 'trace', path: trace('end_lt'), wrong: 1 },
    { label: 'trace time start', target: 'trace', path: trace('start_utime'), wrong: '1' },
    { label: 'trace time end', target: 'trace', path: trace('end_utime'), wrong: '1' },
    { label: 'trace transaction order', target: 'trace', path: trace('transactions_order'), wrong: {} },
    { label: 'trace transaction map', target: 'trace', path: trace('transactions'), wrong: [] },
    { label: 'trace tree', target: 'trace', path: trace('trace'), wrong: null },
    { label: 'trace tree tx hash', target: 'trace', path: trace('trace', 'tx_hash'), wrong: 1 },
    { label: 'trace tree inbound hash', target: 'trace', path: trace('trace', 'in_msg_hash'), wrong: 1 },
    { label: 'trace tree children', target: 'trace', path: trace('trace', 'children'), wrong: null },
    { label: 'trace info', target: 'trace', path: trace('trace_info'), wrong: null },
    { label: 'trace state', target: 'trace', path: trace('trace_info', 'trace_state'), wrong: null },
    { label: 'trace message count', target: 'trace', path: trace('trace_info', 'messages'), wrong: '2' },
    { label: 'trace transaction count', target: 'trace', path: trace('trace_info', 'transactions'), wrong: '2' },
    { label: 'trace pending count', target: 'trace', path: trace('trace_info', 'pending_messages'), wrong: '0' },
    { label: 'trace transaction account', target: 'trace', path: transaction('account'), wrong: 1 },
    { label: 'trace transaction hash', target: 'trace', path: transaction('hash'), wrong: 1 },
    { label: 'trace transaction LT', target: 'trace', path: transaction('lt'), wrong: 1 },
    { label: 'trace transaction time', target: 'trace', path: transaction('now'), wrong: '1' },
    { label: 'trace transaction masterchain seqno', target: 'trace', path: transaction('mc_block_seqno'), wrong: '1' },
    { label: 'trace transaction trace id', target: 'trace', path: transaction('trace_id'), wrong: 1 },
    { label: 'trace transaction emulated', target: 'trace', path: transaction('emulated'), wrong: 'false' },
    { label: 'trace transaction finality', target: 'trace', path: transaction('finality'), wrong: null },
    { label: 'trace transaction block ref', target: 'trace', path: transaction('block_ref'), wrong: null },
    { label: 'trace transaction block workchain', target: 'trace', path: transaction('block_ref', 'workchain'), wrong: '0' },
    { label: 'trace transaction block shard', target: 'trace', path: transaction('block_ref', 'shard'), wrong: 1 },
    { label: 'trace transaction block seqno', target: 'trace', path: transaction('block_ref', 'seqno'), wrong: '1' },
    { label: 'trace execution description', target: 'trace', path: transaction('description'), wrong: null },
    { label: 'trace aborted flag', target: 'trace', path: transaction('description', 'aborted'), wrong: 'false' },
    { label: 'trace compute phase', target: 'trace', path: transaction('description', 'compute_ph'), wrong: false },
    { label: 'trace compute skipped', target: 'trace', path: transaction('description', 'compute_ph', 'skipped'), wrong: 'false' },
    { label: 'trace compute success', target: 'trace', path: transaction('description', 'compute_ph', 'success'), wrong: 'true' },
    { label: 'trace compute exit code', target: 'trace', path: transaction('description', 'compute_ph', 'exit_code'), wrong: '0' },
    { label: 'trace compute reason nullable type', target: 'trace', path: transaction('description', 'compute_ph', 'reason'), wrong: 1 },
    { label: 'trace action phase', target: 'trace', path: transaction('description', 'action'), wrong: false },
    { label: 'trace action success', target: 'trace', path: transaction('description', 'action', 'success'), wrong: 'true' },
    { label: 'trace action valid', target: 'trace', path: transaction('description', 'action', 'valid'), wrong: 'true' },
    { label: 'trace action result code', target: 'trace', path: transaction('description', 'action', 'result_code'), wrong: '0' },
    { label: 'trace bounce phase nullable type', target: 'trace', path: transaction('description', 'bounce'), wrong: false },
    { label: 'trace inbound message', target: 'trace', path: transaction('in_msg'), wrong: null },
    { label: 'trace inbound hash', target: 'trace', path: incoming('hash'), wrong: 1 },
    { label: 'trace inbound source nullable type', target: 'trace', path: incoming('source'), wrong: 1 },
    { label: 'trace inbound destination', target: 'trace', path: incoming('destination'), wrong: 1 },
    { label: 'trace inbound value nullable type', target: 'trace', path: incoming('value'), wrong: 1 },
    { label: 'trace inbound opcode nullable type', target: 'trace', path: incoming('opcode'), wrong: 1 },
    { label: 'trace inbound decoded opcode nullable type', target: 'trace', path: incoming('decoded_opcode'), wrong: 1 },
    { label: 'trace inbound bounce nullable type', target: 'trace', path: incoming('bounce'), wrong: 'true' },
    { label: 'trace inbound bounced nullable type', target: 'trace', path: incoming('bounced'), wrong: 'false' },
    { label: 'trace inbound created LT nullable type', target: 'trace', path: incoming('created_lt'), wrong: 1 },
    { label: 'trace inbound created at nullable type', target: 'trace', path: incoming('created_at'), wrong: 1 },
    { label: 'trace outgoing messages', target: 'trace', path: transaction('out_msgs'), wrong: null },
    { label: 'native decoded @type', target: 'trace', path: incoming('message_content', 'decoded', '@type'), wrong: null },
    { label: 'native decoded type', target: 'trace', path: incoming('message_content', 'decoded', 'type'), wrong: null },
    { label: 'native decoded comment', target: 'trace', path: incoming('message_content', 'decoded', 'comment'), wrong: null },

    { label: 'blocks response array', target: 'blocks', path: ['blocks'], wrong: {} },
    { label: 'block workchain', target: 'blocks', path: ['blocks', 0, 'workchain'], wrong: '0' },
    { label: 'block shard', target: 'blocks', path: ['blocks', 0, 'shard'], wrong: 1 },
    { label: 'block seqno', target: 'blocks', path: ['blocks', 0, 'seqno'], wrong: '1' },
    { label: 'block root hash', target: 'blocks', path: ['blocks', 0, 'root_hash'], wrong: 1 },
    { label: 'block file hash', target: 'blocks', path: ['blocks', 0, 'file_hash'], wrong: 1 },
    { label: 'block masterchain ref', target: 'blocks', path: ['blocks', 0, 'masterchain_block_ref'], wrong: null },
    { label: 'block masterchain workchain', target: 'blocks', path: ['blocks', 0, 'masterchain_block_ref', 'workchain'], wrong: '-1' },
    { label: 'block masterchain shard', target: 'blocks', path: ['blocks', 0, 'masterchain_block_ref', 'shard'], wrong: 1 },
    { label: 'block masterchain seqno', target: 'blocks', path: ['blocks', 0, 'masterchain_block_ref', 'seqno'], wrong: '1' },
    { label: 'block start LT', target: 'blocks', path: ['blocks', 0, 'start_lt'], wrong: 1 },
    { label: 'block end LT', target: 'blocks', path: ['blocks', 0, 'end_lt'], wrong: 1 },
    { label: 'block generated time', target: 'blocks', path: ['blocks', 0, 'gen_utime'], wrong: 1 },
    { label: 'block transaction count', target: 'blocks', path: ['blocks', 0, 'tx_count'], wrong: '1' },

    { label: 'head first block', target: 'head', path: ['first'], wrong: null },
    { label: 'head last block', target: 'head', path: ['last'], wrong: null },
    ...(['first', 'last'] as const).flatMap((which): MutationCase[] => [
      { label: `head ${which} workchain`, target: 'head', path: [which, 'workchain'], wrong: '-1' },
      { label: `head ${which} shard`, target: 'head', path: [which, 'shard'], wrong: 1 },
      { label: `head ${which} seqno`, target: 'head', path: [which, 'seqno'], wrong: '1' },
      { label: `head ${which} root hash`, target: 'head', path: [which, 'root_hash'], wrong: 1 },
      { label: `head ${which} file hash`, target: 'head', path: [which, 'file_hash'], wrong: 1 },
    ]),
  ];

  it.each(cases)('rejects deletion and wrong type for $label', async ({ target, path, wrong }) => {
    for (const remove of [true, false]) {
      const result = await scanFixture(nativeSuccess, SUCCESS_TRANSACTION_KEY, {
        [target]: (root) => mutatePath(root, path, wrong, remove),
      });
      expect(result).toEqual({ kind: 'source_error', code: 'provider_schema_invalid', retryAfterMs: null });
    }
  });

  it('validates non-null bounce internals in the real negative fixture', async () => {
    const result = await scanFixture(nativeAborted, ABORTED_TRANSACTION_KEY, {
      trace: (body) => mutatePath(body, ['traces', 0, 'transactions', ABORTED_TRANSACTION_KEY, 'description', 'bounce', 'type'], 1),
    });
    expect(result).toEqual({ kind: 'source_error', code: 'provider_schema_invalid', retryAfterMs: null });
  });

  it.each([
    ['scan account conflict', 'scan', ['transactions', 0, 'account'], `0:${'9'.repeat(64)}`],
    ['scan hash conflict', 'scan', ['transactions', 0, 'hash'], base64Hash(90_000)],
    ['scan LT conflict', 'scan', ['transactions', 0, 'lt'], '96307052000004'],
    ['scan trace conflict', 'scan', ['transactions', 0, 'trace_id'], base64Hash(90_001)],
    ['scan inbound conflict', 'scan', ['transactions', 0, 'in_msg', 'hash'], base64Hash(90_002)],
    ['scan inbound bounce fact conflict', 'scan', ['transactions', 0, 'in_msg', 'bounce'], false],
    ['scan inbound created-LT conflict', 'scan', ['transactions', 0, 'in_msg', 'created_lt'], '1'],
    ['parent-child message content conflict', 'trace', ['traces', 0, 'transactions', SUCCESS_TRANSACTION_KEY, 'in_msg', 'value'], '1'],
    ['tree node points at another known inbound', 'trace', ['traces', 0, 'trace', 'children', 0, 'in_msg_hash'], nativeSuccess.body.traces[0]!.trace.in_msg_hash],
  ] as const)('rejects exact cross-link conflict: %s', async (_label, target, path, wrong) => {
    const result = await scanFixture(nativeSuccess, SUCCESS_TRANSACTION_KEY, {
      [target]: (root) => mutatePath(root, path, wrong),
    });
    expect(result).toEqual({ kind: 'source_error', code: 'provider_schema_invalid', retryAfterMs: null });
  });

  it('rejects a reordered trace tree before complete evidence is emitted', async () => {
    const result = await scanFixture(nativeSuccess, SUCCESS_TRANSACTION_KEY, {
      trace: (body) => {
        addSyntheticSecondChild(body);
        const tree = ((body.traces as JsonObject[])[0]!.trace as JsonObject);
        (tree.children as unknown[]).reverse();
      },
    });
    expect(result).toEqual({ kind: 'source_error', code: 'provider_schema_invalid', retryAfterMs: null });
  });
});
