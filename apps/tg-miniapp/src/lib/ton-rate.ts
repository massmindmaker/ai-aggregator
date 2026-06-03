/**
 * TON → USD rate fetcher with 60s in-memory cache.
 * Source: CoinGecko (free, public).
 *
 * D-1: TMA is denominated in a USD-pegged credit unit (1 credit = 1 US cent).
 * The crypto→USD conversion happens ONCE here at top-up time; from then on the
 * balance/cost/budgets are all credits. The old TON→RUB fetch is gone — there is
 * no ₽ leg anywhere in the TMA path.
 */

let cache: { ts: number; usd: number } | null = null;
const TTL_MS = 60_000;

export async function getTonUsdRate(): Promise<number> {
  if (cache && Date.now() - cache.ts < TTL_MS) return cache.usd;

  const r = await fetch(
    'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd',
    { cache: 'no-store' },
  );
  if (!r.ok) {
    if (cache) return cache.usd; // stale-ok
    throw new Error(`coingecko_${r.status}`);
  }
  const j = (await r.json()) as { 'the-open-network'?: { usd?: number } };
  const usd = j['the-open-network']?.usd;
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) {
    if (cache) return cache.usd;
    throw new Error('coingecko_bad_payload');
  }
  cache = { ts: Date.now(), usd };
  return usd;
}
