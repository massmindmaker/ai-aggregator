/**
 * Plan 06 — Per-modality cost estimator for the marketplace pricing calculator.
 *
 * All prices in RUB. Catalog prices (`catalog.generated.ts`, built by
 * scripts/gen-marketplace-catalog.ts from the DB) already have the upstream
 * markup baked in — this calculator is a pure display of that price and must
 * NOT apply any additional markup on top (that would double-charge).
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
  perDayRub: number;
  perMonthRub: number;
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
    perDayRub: roundRub(price),
    perMonthRub: roundRub(price * 30),
    unit,
  };
}

function roundRub(n: number): number {
  return Math.round(n * 100) / 100;
}

export function formatRub(amount: number): string {
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: amount < 10 ? 2 : 0,
  }).format(amount);
}

/** For model cards — compact price label. */
export function formatPriceLabel(model: CatalogModel): string {
  const p = model.pricing;
  if (p.inputPer1k !== undefined && p.outputPer1k !== undefined) {
    return `${formatRub(p.inputPer1k)} / ${formatRub(p.outputPer1k)} за ${p.unit}`;
  }
  if (p.inputPer1k !== undefined) {
    return `${formatRub(p.inputPer1k)} за ${p.unit}`;
  }
  if (p.perImage !== undefined) return `${formatRub(p.perImage)} / ${p.unit}`;
  if (p.perMinute !== undefined) return `${formatRub(p.perMinute)} / ${p.unit}`;
  if (p.perSecond !== undefined) return `${formatRub(p.perSecond)} / ${p.unit}`;
  return '—';
}
