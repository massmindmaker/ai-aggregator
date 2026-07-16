import { describe, it, expect } from 'vitest';
import { calcCostCredits, calcByokFeeCredits } from '../lib/pricing';

// T1 (2026-07-16): org buckets are whole USD-cent credits now (1 credit = 1¢),
// not ₽ — calcCostRub/calcByokFeeRub were retired, no `rate`/FX input anymore.
//   charge_usd   = upstream_usd × markup × batchDiscount × cachingFactor
//   cost_credits = max(1, ceil(charge_usd × 100))
describe('pricing.calcCostCredits', () => {
  it('base formula: $0.02 × 1.8 = $0.036 = 3.6¢ → ceil → 4 credits', () => {
    expect(calcCostCredits({ upstreamUsd: 0.02, markup: 1.8 })).toBe(4);
  });

  it('rounds UP, never down (never undercharges)', () => {
    // $0.01 × 1.25 = 1.25¢ → ceil → 2 credits (not 1)
    expect(calcCostCredits({ upstreamUsd: 0.01, markup: 1.25 })).toBe(2);
  });

  it('minimum 1 credit — a sub-cent charge never floors to 0', () => {
    // $0.0001 × 1.25 = 0.0125¢ → ceil → 1 (would be 0 without the floor)
    expect(calcCostCredits({ upstreamUsd: 0.0001, markup: 1.25 })).toBe(1);
  });

  it('batch discount halves cost', () => {
    const full = calcCostCredits({ upstreamUsd: 0.055, markup: 1.8 }); // 9.9¢ → 10
    const batch = calcCostCredits({
      upstreamUsd: 0.055,
      markup: 1.8,
      batchDiscount: 0.5,
    }); // 4.95¢ → 5
    expect(full).toBe(10);
    expect(batch).toBe(5);
  });

  it('prompt caching applies 0.5× only to cached fraction of input', () => {
    const uncached = calcCostCredits({ upstreamUsd: 0.055, markup: 1.8 }); // 9.9¢ → 10
    // 100% of input cached → caching factor = 0.5 → 4.95¢ → 5
    const cached = calcCostCredits({
      upstreamUsd: 0.055,
      markup: 1.8,
      cachedInputTokens: 100,
      totalInputTokens: 100,
    });
    expect(cached).toBe(5);

    // 50% cached → factor = 0.75 → 7.425¢ → ceil → 8
    const half = calcCostCredits({
      upstreamUsd: 0.055,
      markup: 1.8,
      cachedInputTokens: 50,
      totalInputTokens: 100,
    });
    expect(half).toBe(8);
    expect(uncached).toBe(10);
  });

  it('per-upstream markup used (not global fallback) — 1.08 vs 1.07', () => {
    const y = calcCostCredits({ upstreamUsd: 1, markup: 1.08 }); // 108¢ → 108
    const o = calcCostCredits({ upstreamUsd: 1, markup: 1.07 }); // 107¢ → 107
    expect(y).toBe(108);
    expect(o).toBe(107);
    expect(y).toBeGreaterThan(o);
  });

  it('calcByokFeeCredits returns a fixed whole-credit fee (bypasses markup)', () => {
    expect(calcByokFeeCredits()).toBe(1);
    expect(Number.isInteger(calcByokFeeCredits())).toBe(true);
  });
});
