import { config } from '../config';

/** 1 credit = 1 US cent = 1000 micro-credits. See COMMENT ON COLUMN on
 *  organizations.subscription_credits/payg_credits and gateway_transactions.delta
 *  (migration 0059_pricing_unit_comments.sql). */
export const MICRO_PER_CREDIT = 1000;
/** 1 credit = 1¢ → 1 USD = 100 credits = 100_000 micro-credits. */
export const MICRO_PER_USD = MICRO_PER_CREDIT * 100;

export type PricingArgs = {
  /**
   * Upstream cost in US CENTS for this call — NOT USD. model_upstreams'
   * price_per_1k_input/output/price_per_image/price_per_audio_sec columns are
   * ALREADY US cents (= USD × 100; see 0059's COMMENT ON COLUMN and the 0006/0024
   * migration headers, corrected 2026-07-16). This field must be the
   * already-weighted per-call cost, e.g. (tokens/1000) × price_per_1k_input, in
   * that same cents unit — a raw catalog rate is NOT a valid value here.
   *
   * 🔴 Renamed from `upstreamUsd` (T1-fix, 2026-07-16 rework): the old name
   * asserted a USD unit the column never had — that mislabeling is exactly
   * what produced the original 100× overcharge (Opus review + finmodel-spec
   * v2 poправка). The new name is the unit, so a future misuse fails
   * type-review by inspection, not by incident.
   */
  upstreamCents: number;
  /** Per-upstream markup (model_upstreams.markup). Pass upstream.markup — do
   *  NOT fallback to config.DEFAULT_MARKUP here (FIX C8). */
  markup: number;
  /** Applied in /v1/batches route (Task 14). Default 1 (no discount). */
  batchDiscount?: number;
  cachedInputTokens?: number;
  totalInputTokens?: number;
};

/**
 * Calculate cost in whole MICRO-credits (1 credit = 1 US cent = 1000 micro).
 *
 *     charge_cents = upstream_cents × markup × batchDiscount × cachingFactor
 *     cost_micro   = round(charge_cents × 1000)
 *
 * T1-fix (2026-07-16 rework): micro-credit unit REPLACES both the original
 * ₽/rate formula AND the intermediate `max(1, ceil(chargeUsd × 100))`
 * whole-credit scheme (c173a88). Two defects fixed at once:
 *   1. The intermediate scheme read `upstream_cents` as if it were USD and
 *      multiplied by 100 again → a 100× overcharge (Sonnet 1k in + 0.5k out
 *      would have cost 189 credits instead of ~1.9).
 *   2. Even with the unit fixed, a whole-credit floor (`max(1, ceil(...))`)
 *      rounds every sub-cent call UP to a full cent — up to ~1390× overcharge
 *      on cheap embeddings (Opus review HIGH-1). Micro-credits are
 *      fine-grained enough (1/1000¢) that plain rounding is correct; no
 *      artificial floor is needed, and none is applied.
 *
 * No `rate` (FX left the hot path entirely — see settle.ts), no `× 100`
 * (the input is already cents, not USD), no `ceil`-to-1 floor.
 *
 * Caching factor applies a per-token discount CACHING_DISCOUNT
 * (default 0.5) on the cached fraction of input tokens.
 */
export function calcCostCredits(args: PricingArgs): number {
  const { upstreamCents, markup, batchDiscount = 1 } = args;
  let caching = 1;
  if (
    args.cachedInputTokens &&
    args.totalInputTokens &&
    args.totalInputTokens > 0
  ) {
    const cachedFrac = args.cachedInputTokens / args.totalInputTokens;
    caching = 1 - cachedFrac + cachedFrac * config.CACHING_DISCOUNT;
  }
  const chargeCents = upstreamCents * markup * batchDiscount * caching;
  return Math.round(chargeCents * MICRO_PER_CREDIT);
}

/**
 * BYOK — fixed fee in whole MICRO-credits, bypasses markup.
 * `config.BYOK_FEE_CREDITS` is admin-facing in WHOLE credits (founder open
 * question, finmodel-spec §10 Q3); converted to micro-credits here so the
 * value composes with calcCostCredits' unit at every call site.
 */
export function calcByokFeeCredits(): number {
  return Math.round(config.BYOK_FEE_CREDITS * MICRO_PER_CREDIT);
}
