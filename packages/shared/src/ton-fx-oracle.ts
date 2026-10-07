/**
 * TON→USD FX oracle (CoinGecko simple/price) with a 60s in-memory cache.
 * Ported from agents-market apps/tma/src/lib/ton-rate.ts and hardened to the
 * shared SSRF-safe boundary: requests go through safeFetch, never the ambient
 * global fetch. Stale-ok: on any network or payload failure the last cached
 * rate is served; with no cache the caller gets Error('TON_FX_UNAVAILABLE').
 */
import { safeFetch } from './safe-fetch';

const COINGECKO_PRICE_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd';
const TTL_MS = 60_000;

type FetchBoundary = typeof safeFetch;

export interface TonFxOracleDeps {
  /** Test seam: production defaults to the SSRF-hardened safeFetch boundary. */
  fetchFn?: FetchBoundary;
}

let cache: { ts: number; usd: number } | null = null;

/** Drops the module-level rate cache (test isolation only). */
export function clearTonFxCache(): void {
  cache = null;
}

/**
 * Returns the last cached observation INCLUDING its real observation time —
 * a stale-ok serve keeps the original ts so downstream policy refreshers can
 * refuse to stamp an old rate as fresh (plan AG-TON-L task 3.4).
 */
export function readTonFxObservation(): { usd: number; observedAtMs: number } | null {
  return cache ? { usd: cache.usd, observedAtMs: cache.ts } : null;
}

function positiveRate(payload: unknown): number {
  if (!payload || typeof payload !== 'object') throw new Error('coingecko_bad_payload');
  const entry = (payload as Record<string, unknown>)['the-open-network'];
  const rate = entry && typeof entry === 'object' ? (entry as Record<string, unknown>)['usd'] : undefined;
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    throw new Error('coingecko_bad_payload');
  }
  return rate;
}

export async function getTonUsdRate(deps?: TonFxOracleDeps): Promise<number> {
  const fetchFn = deps?.fetchFn ?? safeFetch;
  if (cache && Date.now() - cache.ts < TTL_MS) return cache.usd;
  try {
    const response = await fetchFn(COINGECKO_PRICE_URL, { method: 'GET' });
    if (!response.ok) throw new Error(`coingecko_http_${response.status}`);
    const usd = positiveRate(await response.json());
    cache = { ts: Date.now(), usd };
    return usd;
  } catch {
    // Stale-ok: a flaky upstream must not break checkout pricing.
    if (cache) return cache.usd;
    throw new Error('TON_FX_UNAVAILABLE');
  }
}
