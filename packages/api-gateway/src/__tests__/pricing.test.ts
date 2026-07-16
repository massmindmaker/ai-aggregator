import { describe, it, expect } from 'vitest';
import { calcCostCredits, calcByokFeeCredits, MICRO_PER_CREDIT } from '../lib/pricing';

// T1-fix (2026-07-16 rework): org buckets are whole MICRO-credits now
// (1 credit = 1000 micro = 1¢ USD), not ₽, not whole-credit-with-a-1-floor.
//
// 🔴 The PREVIOUS version of this file (c173a88) had two tests that were
// GREEN AND WRONG: they fed `calcCostCredits({ upstreamUsd: 0.02, ... })` —
// i.e. treated the upstream cost as USD — when `model_upstreams.price_per_1k_*`
// is actually US CENTS (= USD × 100). That mislabeling is exactly what
// produced the gateway's 100× overcharge (Opus review + finmodel-build-spec
// "поправка v2"). This file is rewritten around the CORRECT unit:
//
//   charge_cents = upstream_cents × markup × batchDiscount × cachingFactor
//   cost_micro   = round(charge_cents × 1000)
//
// No `rate`, no `× 100`, no ceil-to-1 floor (that floor was itself an
// ~1390× overcharge risk on cheap embeddings — Opus review HIGH-1).
describe('pricing.calcCostCredits — unit anchors', () => {
  // Anchor 1: model_upstreams.price_per_1k_* columns are US CENTS
  // (= usd_per_1M × 0.1), verified against known public per-1M-token prices.
  // This is the ground truth calcCostCredits' `upstreamCents` argument
  // assumes — a regression here means the whole formula below is moot.
  it.each([
    ['anthropic/claude-sonnet-4-6 input', 0.30, 3.0],
    ['anthropic/claude-sonnet-4-6 output', 1.50, 15.0],
    ['anthropic/claude-opus-4-8 input', 0.50, 5.0],
    ['anthropic/claude-opus-4-8 output', 2.50, 25.0],
    ['openai/gpt-4o-mini input', 0.015, 0.15],
    ['openai/gpt-4o-mini output', 0.06, 0.6],
  ])('%s: column (cents/1k) = usd_per_1M / 10', (_label, columnCents, usdPer1M) => {
    expect(columnCents).toBeCloseTo(usdPer1M / 10, 6);
  });
});

describe('pricing.calcCostCredits', () => {
  it('base formula: 0.30¢/1k in + 1.50¢/1k out, markup 1.8 → round(cents × 1.8 × 1000)', () => {
    // upstream_cents = 0.30 (1000/1000 tokens) → charge = 0.30 × 1.8 = 0.54¢
    // → round(0.54 × 1000) = 540 micro.
    expect(calcCostCredits({ upstreamCents: 0.3, markup: 1.8 })).toBe(540);
  });

  it('rounds to the NEAREST micro-credit, not up (no ceil floor)', () => {
    // 0.01¢ × 1.25 = 0.0125¢ → round(12.5) = 13 micro (banker's-neutral: JS
    // Math.round rounds .5 away from zero → 13, not floored/ceiled to a whole credit).
    expect(calcCostCredits({ upstreamCents: 0.01, markup: 1.25 })).toBe(13);
  });

  it('a sub-cent call can legitimately round to a tiny non-zero micro amount, never floored up to a full credit', () => {
    // 0.0001¢ × 1.25 = 0.000125¢ → round(0.125) = 0 micro. Under the OLD
    // whole-credit scheme this would have been forced to 1 credit (1000
    // micro) — a 1390×-class overcharge on traffic this cheap (Opus HIGH-1).
    // The route call-sites guard `costCredits > 0` before settling, so a
    // 0-micro result means "don't charge", not "charge for free forever".
    expect(calcCostCredits({ upstreamCents: 0.0001, markup: 1.25 })).toBe(0);
  });

  it('batch discount halves cost', () => {
    const full = calcCostCredits({ upstreamCents: 0.55, markup: 1.8 }); // 0.55×1.8=0.99¢ → 990 micro
    const batch = calcCostCredits({
      upstreamCents: 0.55,
      markup: 1.8,
      batchDiscount: 0.5,
    }); // 0.495¢ → 495 micro
    expect(full).toBe(990);
    expect(batch).toBe(495);
  });

  it('prompt caching applies 0.5× only to cached fraction of input', () => {
    const uncached = calcCostCredits({ upstreamCents: 0.55, markup: 1.8 }); // 0.99¢ → 990 micro
    // 100% of input cached → caching factor = 0.5 → 0.495¢ → 495 micro
    const cached = calcCostCredits({
      upstreamCents: 0.55,
      markup: 1.8,
      cachedInputTokens: 100,
      totalInputTokens: 100,
    });
    expect(cached).toBe(495);

    // 50% cached → factor = 0.75 → 0.7425¢ → round(742.5) = 743 micro
    // (JS Math.round rounds .5 away from zero toward +Infinity).
    const half = calcCostCredits({
      upstreamCents: 0.55,
      markup: 1.8,
      cachedInputTokens: 50,
      totalInputTokens: 100,
    });
    expect(half).toBe(743);
    expect(uncached).toBe(990);
  });

  it('per-upstream markup used (not global fallback) — 1.08 vs 1.07', () => {
    const y = calcCostCredits({ upstreamCents: 100, markup: 1.08 }); // 108¢ → 108_000 micro
    const o = calcCostCredits({ upstreamCents: 100, markup: 1.07 }); // 107¢ → 107_000 micro
    expect(y).toBe(108_000);
    expect(o).toBe(107_000);
    expect(y).toBeGreaterThan(o);
  });

  it('calcByokFeeCredits returns a fixed whole-micro-credit fee (bypasses markup)', () => {
    // config.BYOK_FEE_CREDITS default = 1 whole credit = 1000 micro.
    expect(calcByokFeeCredits()).toBe(1000);
    expect(Number.isInteger(calcByokFeeCredits())).toBe(true);
  });

  // Storefront == invoice: the price a user sees in the catalog
  // (gen-marketplace-catalog.ts:373, `inputRaw × markup`, in CENTS) must
  // agree with what the gateway actually settles for the same call, once
  // converted back to the same cents unit (micro / MICRO_PER_CREDIT).
  it('storefront price (cents) matches gateway charge (micro / 1000), within rounding', () => {
    const col = 0.3; // anthropic/claude-sonnet-4-6 input, cents/1k
    const markup = 1.8;
    const storefrontCentsPer1k = col * markup; // gen-marketplace-catalog.ts:373 (no /100, no rate)
    const chargedMicro = calcCostCredits({ upstreamCents: col, markup });
    const chargedCents = chargedMicro / MICRO_PER_CREDIT;
    // Rounding to the nearest micro-credit is within 1/1000 of a cent —
    // negligible next to the storefront's own 6-decimal rounding.
    expect(chargedCents).toBeCloseTo(storefrontCentsPer1k, 3);
  });

  // HIGH-1 anchor (Opus review, embeddings): a 1k-token embedding call at
  // column price 0.002¢/1k, markup 1.8 → 0.002 × 1.8 × 1000 = 3.6 → round → 4
  // micro-credits (= $0.00004). Under the OLD whole-credit floor this would
  // have been forced up to 1 whole credit (1000 micro, $0.01) — a ~278×
  // overcharge on this exact call shape (the review's own worked example was
  // even cheaper and measured ~1390×).
  it('HIGH-1 anchor — cheap 1k embedding: 4 micro-credits, not 1000', () => {
    expect(calcCostCredits({ upstreamCents: 0.002, markup: 1.8 })).toBe(4);
  });

  // Regression anchor: the 100× bug (c173a88) must never come back. Sonnet,
  // 1000 input + 500 output tokens, markup 1.8:
  //   upstream_cents = 0.30×(1000/1000) + 1.50×(500/1000) = 0.30 + 0.75 = 1.05
  //   cost_micro = round(1.05 × 1.8 × 1000) = 1890  (= 1.89 credits = $0.0189)
  // The buggy `upstreamUsd`-as-cents formula would have produced 189_000
  // micro (189 whole credits, $1.89 — a 100× overcharge). Assert BOTH: the
  // correct value, and that it is nowhere near the buggy one.
  it('no 100x regression — Sonnet 1k in + 0.5k out = 1890 micro-credits, NOT 189000', () => {
    const upstreamCents = (1000 / 1000) * 0.3 + (500 / 1000) * 1.5;
    expect(upstreamCents).toBeCloseTo(1.05, 6);
    const micro = calcCostCredits({ upstreamCents, markup: 1.8 });
    expect(micro).toBe(1890);
    expect(micro).not.toBe(189_000);
    expect(micro / MICRO_PER_CREDIT).toBeCloseTo(1.89, 6);
  });
});
