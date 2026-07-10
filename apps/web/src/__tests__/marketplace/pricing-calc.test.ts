import { describe, it, expect } from 'vitest';
import {
  estimateCost,
  formatPriceLabel,
  formatRub,
} from '@/lib/marketplace/pricing-calc';
import { CATALOG } from '@/lib/marketplace/catalog';

const gpt = CATALOG.find((m) => m.slug === 'openai/gpt-4-turbo')!;
const dalle = CATALOG.find((m) => m.slug === 'openai/dall-e-3')!;
const whisper = CATALOG.find((m) => m.slug === 'openai/whisper-large-v3')!;

describe('estimateCost', () => {
  it('output price equals the catalog price — no second markup on top of an already-marked-up catalog', () => {
    // Catalog prices (catalog.generated.ts, built by scripts/gen-marketplace-catalog.ts
    // from the DB) already have the upstream markup baked in. The calculator must be a
    // pure display of that price — it must NOT apply an additional flat markup on top.
    const usage = { requestsPerDay: 1000, avgInputTokens: 1000, avgOutputTokens: 500 };
    const catalogPriceRub =
      ((usage.avgInputTokens * usage.requestsPerDay) / 1000) * (gpt.pricing.inputPer1k ?? 0) +
      ((usage.avgOutputTokens * usage.requestsPerDay) / 1000) * (gpt.pricing.outputPer1k ?? 0);
    // catalogPriceRub = 1000 * (1 * 0.9 + 0.5 * 2.7) = 2250
    const r = estimateCost(gpt, usage);
    expect(r.perDayRub).toBeCloseTo(catalogPriceRub, 6);
    expect(r.perDayRub).toBeCloseTo(2250, 1);
  });

  it('monthly = daily × 30', () => {
    const r = estimateCost(gpt, {
      requestsPerDay: 100,
      avgInputTokens: 500,
      avgOutputTokens: 500,
    });
    expect(r.perMonthRub).toBeCloseTo(r.perDayRub * 30, 1);
  });

  it('image modality — output equals catalog per-image price, no markup added', () => {
    const r = estimateCost(dalle, { imagesPerDay: 10 });
    // 10 * 7.5 = 75 catalog price, unchanged by the calculator
    expect(r.perDayRub).toBe(75);
  });

  it('audio modality — output equals catalog per-minute price, no markup added', () => {
    const r = estimateCost(whisper, { minutesPerDay: 100 });
    expect(r.perDayRub).toBe(60);
  });

  it('returns zero on empty usage', () => {
    const r = estimateCost(gpt, {});
    expect(r.perDayRub).toBe(0);
    expect(r.perMonthRub).toBe(0);
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

describe('formatRub', () => {
  it('formats with Russian locale', () => {
    const s = formatRub(1500);
    expect(s).toMatch(/₽|руб/i);
  });
});
