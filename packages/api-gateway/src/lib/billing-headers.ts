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
} as const;

/** Format a ₽ amount for a header value (fixed 4 dp, matches NUMERIC(_,4)). */
export function formatRubHeader(rub: number): string {
  return (Number.isFinite(rub) ? rub : 0).toFixed(4);
}
