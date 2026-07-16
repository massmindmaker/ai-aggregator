/**
 * Plan 06 — Per-modality cost estimator for the marketplace pricing calculator.
 *
 * 🔴 Currency fix (HIGH-C, Opus review 2026-07-17): this file used to format
 * every catalog price with `Intl.NumberFormat({ currency: 'RUB' })`. That was
 * wrong at the unit level, not just cosmetically: catalog prices
 * (`catalog.generated.ts`, built by gen-marketplace-catalog.ts:373 as
 * `rawCents × markup`) are in CREDITS (1 credit = 1 US cent — see
 * packages/api-gateway/src/lib/pricing.ts, migration 0059's COMMENT ON
 * COLUMN), not rubles, and no FX rate ever enters that number. Rendering it
 * as "₽" showed the customer a currency they will never actually be charged
 * in. It also happened to match the founder's 2026-07-15 web-finmodel reversal
 * (`project_web_finmodel_decision_2026_07_15`): the web aggregator now bills
 * in CREDITS too (like the TMA), not rubles — so displaying credits directly
 * is not just a bug fix, it is the currently-correct product decision, and it
 * needs no exchange rate at all (the credit unit already equals what
 * settlement charges 1:1).
 *
 * Catalog prices already have the upstream markup baked in — this calculator
 * is a pure display of that price and must NOT apply any additional markup on
 * top (that would double-charge).
 */

import type { CatalogModel } from './catalog';

export interface UsageEstimate {
  /** chat/embedding: requests per day */
  requestsPerDay?: number;
  /** chat/embedding: avg input tokens per request */
  avgInputTokens?: number;
  /** chat: avg output tokens per request */
  avgOutputTokens?: number;
  /** image: images per day */
  imagesPerDay?: number;
  /** audio: minutes per day */
  minutesPerDay?: number;
  /** video: seconds per day */
  secondsPerDay?: number;
}

export interface CostBreakdown {
  /** Credits (1 credit = 1 US cent), NOT rubles. */
  perDayCredits: number;
  /** Credits (1 credit = 1 US cent), NOT rubles. */
  perMonthCredits: number;
  unit: string;
}

export function estimateCost(
  model: CatalogModel,
  usage: UsageEstimate
): CostBreakdown {
  const p = model.pricing;
  let price = 0;
  const unit = p.unit ?? 'unit';

  if (p.inputPer1k !== undefined || p.outputPer1k !== undefined) {
    const requests = usage.requestsPerDay ?? 0;
    const inputTok = (usage.avgInputTokens ?? 0) * requests;
    const outputTok = (usage.avgOutputTokens ?? 0) * requests;
    price =
      (inputTok / 1000) * (p.inputPer1k ?? 0) +
      (outputTok / 1000) * (p.outputPer1k ?? 0);
  } else if (p.perImage !== undefined) {
    price = (usage.imagesPerDay ?? 0) * p.perImage;
  } else if (p.perMinute !== undefined) {
    price = (usage.minutesPerDay ?? 0) * p.perMinute;
  } else if (p.perSecond !== undefined) {
    price = (usage.secondsPerDay ?? 0) * p.perSecond;
  }

  return {
    perDayCredits: roundCredits(price),
    perMonthCredits: roundCredits(price * 30),
    unit,
  };
}

function roundCredits(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Format a credit amount for display — NOT a currency, no FX. */
export function formatCredits(amount: number): string {
  const formatted = new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: amount < 10 ? 2 : 0,
  }).format(amount);
  return `${formatted} кр`;
}

/** For model cards — compact price label. */
export function formatPriceLabel(model: CatalogModel): string {
  const p = model.pricing;
  if (p.inputPer1k !== undefined && p.outputPer1k !== undefined) {
    return `${formatCredits(p.inputPer1k)} / ${formatCredits(p.outputPer1k)} за ${p.unit}`;
  }
  if (p.inputPer1k !== undefined) {
    return `${formatCredits(p.inputPer1k)} за ${p.unit}`;
  }
  if (p.perImage !== undefined) return `${formatCredits(p.perImage)} / ${p.unit}`;
  if (p.perMinute !== undefined) return `${formatCredits(p.perMinute)} / ${p.unit}`;
  if (p.perSecond !== undefined) return `${formatCredits(p.perSecond)} / ${p.unit}`;
  return '—';
}
