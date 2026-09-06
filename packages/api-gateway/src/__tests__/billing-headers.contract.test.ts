import { describe, it, expect } from 'vitest';
import {
  BILLING_HEADERS,
  formatUsdMicroHeader,
  formatRubHeader,
} from '../lib/billing-headers';

/**
 * D-0 gateway↔worker header CONTRACT (gateway side).
 *
 * The Agents Market worker reads `x-aiag-charged-usd-micro` /
 * `x-aiag-upstream-cost-usd-micro` (`/home/bob/Projects/agents-market/apps/worker/src/agent-runner.ts`,
 * exported HDR_CHARGED_USD_MICRO / HDR_UPSTREAM_COST_USD_MICRO). The worker
 * package can't import this gateway package, so both sides pin to ONE literal
 * source of truth. Here we assert the gateway's emitted constants equal those
 * EXACT literals; the worker-side test (billing-header-contract.test.ts) asserts
 * its reader constants equal the same literals. If either side renames a header,
 * one of these two tests fails — instead of silently disabling billing (the
 * exact 2026-06-04 readiness regression: gateway emitted ₽ names, worker read
 * USD-micro names, they never overlapped → billedByGateway always false).
 */
describe('D-0 gateway billing-header contract', () => {
  it('emits the EXACT USD-micro names the worker reads', () => {
    expect(BILLING_HEADERS.CHARGED_USD_MICRO).toBe('x-aiag-charged-usd-micro');
    expect(BILLING_HEADERS.UPSTREAM_COST_USD_MICRO).toBe(
      'x-aiag-upstream-cost-usd-micro',
    );
  });

  it('keeps the legacy ₽ pair for the web aggregator (additive, not replaced)', () => {
    expect(BILLING_HEADERS.CHARGED_RUB).toBe('X-AIAG-Charged-Rub');
    expect(BILLING_HEADERS.UPSTREAM_COST_RUB).toBe('X-AIAG-Upstream-Cost-Rub');
  });

  it('formatUsdMicroHeader: USD → integer micro-USD ($0.000001 units)', () => {
    // $0.1234 → 123_400 µ$ ; worker re-rounds UP to ceil(123400/10000)=13 credits.
    expect(formatUsdMicroHeader(0.1234)).toBe('123400');
    expect(formatUsdMicroHeader(0.09)).toBe('90000');
    expect(formatUsdMicroHeader(0)).toBe('0');
    // non-finite / negative → "0" (never a NaN/garbage header)
    expect(formatUsdMicroHeader(NaN)).toBe('0');
    expect(formatUsdMicroHeader(-1)).toBe('0');
  });

  it('USD figure derived from ₽ via the same rate round-trips: chargedUsd × rate ≈ totalRub', () => {
    // T1 (2026-07-16): chat.ts no longer computes chargedUsd this way (no ₽/FX
    // in the hot path anymore) — this test now only exercises formatRubHeader/
    // formatUsdMicroHeader as standalone functions, not a live chat.ts mirror.
    const totalRub = 1.15;
    const rate = 92;
    const chargedUsd = totalRub / rate;
    expect(chargedUsd * rate).toBeCloseTo(Number(formatRubHeader(totalRub)), 6);
    expect(formatUsdMicroHeader(chargedUsd)).toBe('12500'); // $0.0125 → 12_500 µ$
  });
});
