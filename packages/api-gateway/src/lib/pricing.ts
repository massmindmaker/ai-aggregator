import { config } from '../config';

export type PricingArgs = {
  upstreamUsd: number;
  /** Per-upstream markup (model_upstreams.markup). Pass upstream.markup — do
   *  NOT fallback to config.DEFAULT_MARKUP here (FIX C8). */
  markup: number;
  /** Applied in /v1/batches route (Task 14). Default 1 (no discount). */
  batchDiscount?: number;
  cachedInputTokens?: number;
  totalInputTokens?: number;
};

/**
 * Calculate cost in whole CREDITS (1 credit = 1 US cent) for an upstream call.
 *
 *     charge_usd   = upstream_usd × markup × batchDiscount × cachingFactor
 *     cost_credits = max(1, ceil(charge_usd × 100))
 *
 * T1 (2026-07-16): org buckets are USD-cent credits now, not ₽ — there is no
 * `rate` parameter anymore. FX is no longer part of the charging hot path
 * (it used to be `upstream_usd × rate × markup`, rate = live CBR fetch with a
 * `.catch(() => 92)` silent-fallback mine — removed, not just relocated).
 *
 * Round UP, minimum 1 credit — mirrors the TMA agent-worker's
 * `Math.ceil(usd * 100)` (apps/agent-worker/src/agent-runner.ts:433) so a
 * sub-cent call is never undercharged or free.
 *
 * Caching factor applies a per-token discount CACHING_DISCOUNT
 * (default 0.5) on the cached fraction of input tokens.
 */
export function calcCostCredits(args: PricingArgs): number {
  const { upstreamUsd, markup, batchDiscount = 1 } = args;
  let caching = 1;
  if (
    args.cachedInputTokens &&
    args.totalInputTokens &&
    args.totalInputTokens > 0
  ) {
    const cachedFrac = args.cachedInputTokens / args.totalInputTokens;
    caching = 1 - cachedFrac + cachedFrac * config.CACHING_DISCOUNT;
  }
  const chargeUsd = upstreamUsd * markup * batchDiscount * caching;
  return Math.max(1, Math.ceil(chargeUsd * 100));
}

/** FIX C8: BYOK — fixed fee in whole credits, bypasses markup. */
export function calcByokFeeCredits(): number {
  return config.BYOK_FEE_CREDITS;
}
