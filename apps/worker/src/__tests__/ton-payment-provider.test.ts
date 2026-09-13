import { describe, expect, it, vi } from 'vitest';
import { SsrfError } from '@aiag/shared/server';

import { createToncenterV3Provider } from '../ton-payment-provider.js';
import nativeSuccess from '../__fixtures__/ton/toncenter-v3-testnet/native-success.sanitized.json';

const RECIPIENT = `0:${'1'.repeat(64)}`;
const JETTON_MASTER = `0:${'2'.repeat(64)}`;
const FIXTURE_RECIPIENT = '0:203bb83b9b6efadceb8ff8069354e6558448e0e7363208a0c5ebad10cc9a7bd4';

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
    'nr6KZdblc7PLJ3JQ4cjR4swdFTJSQuOxI4CMx6QOBMg='
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
  ])('rejects a non-canonical continuation cursor before fetching', async (cursor) => {
    const fetchImpl = vi.fn();
    const result = await provider(fetchImpl).scanAccountPage(RECIPIENT, cursor as never, new AbortController().signal);
    expect(result).toEqual({ kind: 'source_error', code: 'pagination_regressed', retryAfterMs: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
