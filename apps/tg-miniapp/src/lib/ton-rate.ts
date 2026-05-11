/**
 * TON → RUB rate fetcher with 60s in-memory cache.
 * Source: CoinGecko (free, public).
 */

let cache: { ts: number; rub: number } | null = null;
const TTL_MS = 60_000;

export async function getTonRubRate(): Promise<number> {
  if (cache && Date.now() - cache.ts < TTL_MS) return cache.rub;

  const r = await fetch(
    'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=rub',
    { cache: 'no-store' },
  );
  if (!r.ok) {
    if (cache) return cache.rub; // stale-ok
    throw new Error(`coingecko_${r.status}`);
  }
  const j = (await r.json()) as { 'the-open-network'?: { rub?: number } };
  const rub = j['the-open-network']?.rub;
  if (typeof rub !== 'number' || !Number.isFinite(rub) || rub <= 0) {
    if (cache) return cache.rub;
    throw new Error('coingecko_bad_payload');
  }
  cache = { ts: Date.now(), rub };
  return rub;
}
