import { describe, it, expect } from 'vitest';
import {
  estimateCost,
  formatPriceLabel,
  formatCredits,
} from '@/lib/marketplace/pricing-calc';
// 🔴 Rewrite (Opus review, 2026-07-17, MED): the previous version of this
// file imported the static `CATALOG` fixture (catalog.ts's hand-seeded
// array), which is dead in production — `getAllModels()`/every marketplace
// page reads `GENERATED_CATALOG` and only falls back to `CATALOG` if the
// generated artifact is empty (it never is, 69 models). All 3 slugs the old
// fixtures used ('openai/gpt-4-turbo', 'openai/dall-e-3',
// 'openai/whisper-large-v3') are ABSENT from the real 69-model artifact, so
// this test was tautological against data nothing ships with. Reading the
// live artifact — same pattern as pricing.test.ts's "storefront == invoice"
// blocks in the gateway package — makes this test track what the site
// actually serves.
import { GENERATED_CATALOG } from '@/lib/marketplace/catalog.generated';

const gpt = GENERATED_CATALOG.find((m) => m.slug === 'openai/gpt-4o')!;
const dalle = GENERATED_CATALOG.find((m) => m.slug === 'dalle-3-kie')!;
const whisper = GENERATED_CATALOG.find((m) => m.slug === 'whisper-large-v3')!;
const cheapEmbedding = GENERATED_CATALOG.find(
  (m) => m.slug === 'openai/text-embedding-3-small'
)!;

describe('fixtures are present in the shipped artifact', () => {
  it.each([
    ['openai/gpt-4o', gpt],
    ['dalle-3-kie', dalle],
    ['whisper-large-v3', whisper],
    ['openai/text-embedding-3-small', cheapEmbedding],
  ])('%s exists in GENERATED_CATALOG', (_slug, model) => {
    expect(model).toBeDefined();
  });
});

describe('estimateCost', () => {
  it('output price equals the catalog price — no second markup on top of an already-marked-up catalog', () => {
    // Catalog prices (catalog.generated.ts, built by scripts/gen-marketplace-catalog.ts
    // from the DB) already have the upstream markup baked in and are in CREDITS (1
    // credit = 1 US cent — see pricing-calc.ts docblock), not RUB. The calculator must
    // be a pure display of that price — it must NOT apply an additional flat markup on
    // top.
    const usage = { requestsPerDay: 1000, avgInputTokens: 1000, avgOutputTokens: 500 };
    const catalogPriceCredits =
      ((usage.avgInputTokens * usage.requestsPerDay) / 1000) * (gpt.pricing.inputPer1k ?? 0) +
      ((usage.avgOutputTokens * usage.requestsPerDay) / 1000) * (gpt.pricing.outputPer1k ?? 0);
    // catalogPriceCredits = 1000 * (1 * 0.9 + 0.5 * 2.7) = 2250
    const r = estimateCost(gpt, usage);
    expect(r.perDayCredits).toBeCloseTo(catalogPriceCredits, 6);
    expect(r.perDayCredits).toBeCloseTo(2250, 1);
  });

  it('monthly = daily × 30', () => {
    const r = estimateCost(gpt, {
      requestsPerDay: 100,
      avgInputTokens: 500,
      avgOutputTokens: 500,
    });
    expect(r.perMonthCredits).toBeCloseTo(r.perDayCredits * 30, 1);
  });

  it('image modality — output equals catalog per-image price, no markup added', () => {
    const r = estimateCost(dalle, { imagesPerDay: 10 });
    // dalle-3-kie.pricing.perImage = 7.2 (live artifact) — 10 * 7.2 = 72
    expect(dalle.pricing.perImage).toBe(7.2);
    expect(r.perDayCredits).toBe(72);
  });

  it('audio modality — output equals catalog per-minute price, no markup added', () => {
    const r = estimateCost(whisper, { minutesPerDay: 100 });
    // whisper-large-v3.pricing.perMinute = 2.7 (live artifact) — 100 * 2.7 = 270
    expect(whisper.pricing.perMinute).toBe(2.7);
    expect(r.perDayCredits).toBe(270);
  });

  it('returns zero on empty usage', () => {
    const r = estimateCost(gpt, {});
    expect(r.perDayCredits).toBe(0);
    expect(r.perMonthCredits).toBe(0);
  });
});

describe('formatPriceLabel', () => {
  it('shows input/output for llm', () => {
    const s = formatPriceLabel(gpt);
    expect(s).toMatch(/1K токенов/);
  });
  it('shows per-image for image models', () => {
    expect(formatPriceLabel(dalle)).toMatch(/изображение/);
  });
});

describe('formatCredits', () => {
  it('formats with the credits suffix, never a currency symbol', () => {
    const s = formatCredits(1500);
    expect(s).toMatch(/кр$/);
    expect(s).not.toMatch(/₽|руб|\$|USD/i);
  });

  // MED fix (Opus review, 2026-07-17): a flat 2-decimal cap rendered
  // genuinely paid sub-cent models (e.g. openai/text-embedding-3-small,
  // inputPer1k = 0.0036 credits) as "0 кр" — indistinguishable from free.
  it('never collapses a genuinely paid sub-cent price to "0 кр"', () => {
    expect(cheapEmbedding.pricing.inputPer1k).toBeCloseTo(0.0036, 6);
    const s = formatCredits(cheapEmbedding.pricing.inputPer1k!);
    expect(s).not.toBe('0 кр');
    expect(s).not.toMatch(/^0[,.]?0*\s?кр$/);
  });

  it('a real zero still renders as "0 кр" (honest, not hidden)', () => {
    expect(formatCredits(0)).toBe('0 кр');
  });
});
