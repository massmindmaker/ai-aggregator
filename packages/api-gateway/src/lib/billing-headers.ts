/**
 * D-0 — authoritative billing headers (the money keystone).
 *
 * Per request, the :4000 gateway returns the AUTHORITATIVE charged amount and
 * the upstream cost it bore, so an internal caller can debit/accrue off the
 * gateway's real numbers instead of re-inventing a cost from a hardcoded
 * PRICING table.
 *
 * 🔴 Corrected (2026-07-17, billing-headers docblock fix): this file's own
 * header used to claim the emitted headers "carry ONLY ₽ figures" — that was
 * already false at the time of the T1 rework and stayed false after it.
 * `CHARGED_USD_MICRO`/`UPSTREAM_COST_USD_MICRO` are the ONLY pair chat.ts and
 * sse.ts actually set on a live response today (grep confirms zero call sites
 * for `formatRubHeader`/`CHARGED_RUB`/`UPSTREAM_COST_RUB` outside this file
 * and its own contract test) — read by the Agents Market worker
 * (`HDR_CHARGED_USD_MICRO`/`HDR_UPSTREAM_COST_USD_MICRO` in
 * /home/bob/Projects/agents-market/apps/worker/src/agent-runner.ts; the two repositories pin to the same
 * literal via billing-headers.contract.test.ts so a rename on either side
 * fails loudly instead of silently disabling billing — the exact 2026-06-04
 * regression this contract test exists to prevent).
 *
 *     margin_usd_micro = charged_usd_micro − upstream_cost_usd_micro
 *
 * The `CHARGED_RUB`/`UPSTREAM_COST_RUB` pair below is RESERVED, not live: no
 * route sets them on a response and no consumer (web or worker) reads them —
 * kept for the web aggregator's planned ₽-denominated integration, not yet
 * wired. Treat them as dead until a route actually calls `c.header(...)` with
 * them; don't assume they carry a real value on any current response.
 *
 * White-label: whichever pair ends up live, headers carry ONLY numeric
 * figures — never a provider/model brand. They are emitted on the gateway
 * path and are traceable to the row in `gateway_transactions` via the
 * already-echoed `X-Request-Id` (the gateway_request_id). They must be
 * stripped by any external/native edge (nginx) so they never reach an end
 * client.
 */
export const BILLING_HEADERS = {
  /** RESERVED — not currently set on any response. See module docblock. */
  CHARGED_RUB: 'X-AIAG-Charged-Rub',
  /** RESERVED — not currently set on any response. See module docblock. */
  UPSTREAM_COST_RUB: 'X-AIAG-Upstream-Cost-Rub',
  /**
   * LIVE — the actual authoritative figures, in integer micro-USD
   * ($0.000001 units, no float on the wire). Header NAMES here MUST stay
   * byte-equal to the external client's reader constants (`HDR_CHARGED_USD_MICRO` /
   * `HDR_UPSTREAM_COST_USD_MICRO` in agents-market/apps/worker/src/agent-runner.ts) —
   * the gateway↔worker contract test asserts this so it can never silently
   * drift.
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
