import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTonFxCache, getTonUsdRate } from '../ton-fx-oracle';

const COINGECKO_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd';

/** JSON response body builder — tests never touch the real network. */
const respond = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'application/json' } });
const okRate = (usd: unknown) => respond(JSON.stringify({ 'the-open-network': { usd } }));

describe('ton fx oracle', () => {
  beforeEach(() => clearTonFxCache());
  afterEach(() => vi.useRealTimers());

  it('returns the CoinGecko USD rate and caches it', async () => {
    const fetchFn = vi.fn(async () => okRate(5.23));
    await expect(getTonUsdRate({ fetchFn })).resolves.toBe(5.23);
  });

  it('serves a fresh cache hit without touching the network', async () => {
    const fetchFn = vi.fn(async () => okRate(5.23));
    await getTonUsdRate({ fetchFn });
    await expect(getTonUsdRate({ fetchFn })).resolves.toBe(5.23);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(COINGECKO_URL, expect.objectContaining({ method: 'GET' }));
  });

  it.each([500, 429, 503])('serves a stale cached rate after TTL on HTTP %i', async (status) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    await expect(getTonUsdRate({ fetchFn: vi.fn(async () => okRate(4.2)) })).resolves.toBe(4.2);
    vi.setSystemTime(1_000_000 + 60_001); // TTL expired → cache is stale but usable
    const failing = vi.fn(async () => respond('upstream unavailable', status));
    await expect(getTonUsdRate({ fetchFn: failing })).resolves.toBe(4.2);
  });

  it.each([
    'definitely not json',
    '{"the-open-network":{"usd":"5.23"}}',
    '{"the-open-network":{"usd":null}}',
    '{"the-open-network":{"usd":-1}}',
    '{"the-open-network":{"usd":0}}',
    '{"the-open-network":{}}',
    '{"unexpected":{}}',
  ])('throws TON_FX_UNAVAILABLE on bad payload %j without a cache', async (body) => {
    const fetchFn = vi.fn(async () => respond(body));
    await expect(getTonUsdRate({ fetchFn })).rejects.toThrow('TON_FX_UNAVAILABLE');
  });

  it('serves a stale cached rate when a once-good feed turns into garbage', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    await expect(getTonUsdRate({ fetchFn: vi.fn(async () => okRate(7.77)) })).resolves.toBe(7.77);
    vi.setSystemTime(2_000_000 + 60_001);
    const truncated = vi.fn(async () => respond('{"the-open-network":{"usd":'));
    await expect(getTonUsdRate({ fetchFn: truncated })).resolves.toBe(7.77);
  });

  it('throws TON_FX_UNAVAILABLE when the network fails before any cache exists', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('EAI_AGAIN');
    });
    await expect(getTonUsdRate({ fetchFn })).rejects.toThrow('TON_FX_UNAVAILABLE');
  });
});
