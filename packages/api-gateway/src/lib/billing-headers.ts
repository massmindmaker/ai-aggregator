/**
 * D-0 — authoritative billing headers (the money keystone).
 *
 * Per request, the :4000 gateway returns the AUTHORITATIVE charged amount and
 * the upstream cost it bore, in ₽, so an internal caller (the agent-worker on
 * the gateway path) can debit/accrue off the gateway's real numbers instead of
 * re-inventing a cost from a hardcoded PRICING table. Margin is then derivable:
 *
 *     margin_rub = charged_rub − upstream_cost_rub
 *
 * White-label: these headers carry ONLY ₽ figures — never a provider/model
 * brand. They are emitted on the gateway path and are traceable to the row in
 * `gateway_transactions` via the already-echoed `X-Request-Id` (the
 * gateway_request_id). They must be stripped by any external/native edge
 * (nginx) so they never reach an end client.
 */
export const BILLING_HEADERS = {
  /** Authoritative amount the org was charged for this request (₽). */
  CHARGED_RUB: 'X-AIAG-Charged-Rub',
  /** Upstream cost we bore for this request (₽, upstream_usd × rate, no markup). */
  UPSTREAM_COST_RUB: 'X-AIAG-Upstream-Cost-Rub',
  /**
   * D-1 (USD-native): the SAME authoritative figures as the ₽ pair above, but in
   * integer micro-USD ($0.000001 units) — no float on the wire. These are the
   * headers the TMA agent-worker actually reads (it bills in USD-cent credits,
   * not ₽). Derived from the ₽ figures via the same USD/₽ `rate` used for the
   * charge (so USD×rate == ₽ exactly). Header NAMES here MUST stay byte-equal to
   * the worker's reader constants (`HDR_CHARGED_USD_MICRO` /
   * `HDR_UPSTREAM_COST_USD_MICRO` in apps/agent-worker/src/agent-runner.ts) — the
   * gateway↔worker contract test asserts this so it can never silently drift.
   */
  CHARGED_USD_MICRO: 'x-aiag-charged-usd-micro',
  UPSTREAM_COST_USD_MICRO: 'x-aiag-upstream-cost-usd-micro',
} as const;

/** Format a ₽ amount for a header value (fixed 4 dp, matches NUMERIC(_,4)). */
export function formatRubHeader(rub: number): string {
  return (Number.isFinite(rub) ? rub : 0).toFixed(4);
}

/**
 * Format a USD amount as an integer micro-USD ($0.000001) header value.
 * Math.round → nearest integer micro-USD (the worker re-rounds UP to credits, so
 * a half-micro here cannot make it undercharge). Non-finite/negative → "0".
 */
export function formatUsdMicroHeader(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return '0';
  return String(Math.round(usd * 1_000_000));
}
