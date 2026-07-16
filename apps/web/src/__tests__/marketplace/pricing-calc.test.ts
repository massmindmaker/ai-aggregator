import { describe, it, expect } from 'vitest';
import {
  estimateCost,
  formatPriceLabel,
  formatCredits,
} from '@/lib/marketplace/pricing-calc';
import { CATALOG } from '@/lib/marketplace/catalog';

const gpt = CATALOG.find((m) => m.slug === 'openai/gpt-4-turbo')!;
const dalle = CATALOG.find((m) => m.slug === 'openai/dall-e-3')!;
const whisper = CATALOG.find((m) => m.slug === 'openai/whisper-large-v3')!;

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
    // 10 * 7.5 = 75 catalog price, unchanged by the calculator
    expect(r.perDayCredits).toBe(75);
  });

  it('audio modality — output equals catalog per-minute price, no markup added', () => {
    const r = estimateCost(whisper, { minutesPerDay: 100 });
    expect(r.perDayCredits).toBe(60);
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
});
