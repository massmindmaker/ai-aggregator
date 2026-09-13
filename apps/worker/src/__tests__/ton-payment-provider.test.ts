import { describe, expect, it, vi } from 'vitest';

import { createToncenterV3Provider } from '../ton-payment-provider.js';

const RECIPIENT = `0:${'1'.repeat(64)}`;
const JETTON_MASTER = `0:${'2'.repeat(64)}`;

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
});
