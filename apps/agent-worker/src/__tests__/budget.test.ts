import { describe, it, expect } from 'vitest';
import { estimateCostCredits, finalBillableCostCredits } from '../agent-runner.js';

// D-1: the credit unit is integer US cents (1 credit = $0.01). PRICING in
// agent-runner.ts is USD per 1M tokens; estimateCostCredits returns
// Math.ceil(usd * 100) — exact integer cents, rounded UP (never undercharge).
// The expected values below replicate that math; the assertions prove
// estimateCostCredits uses it.
//
// MIN_RUN_COST is an internal constant in agent-runner.ts (the run-start gate
// floor, reused as the CHARGE-0 settle floor) = 1 credit ($0.01). Replicated
// here; the assertions prove finalBillableCostCredits uses it as the floor.
const MIN_RUN_COST = 1;

describe('estimateCostCredits', () => {
  it('known model (hermes-4-405b) = ceil((in*0.9 + out*1.5)/1M USD * 100) cents', () => {
    const tokensIn = 1_000_000;
    const tokensOut = 1_000_000;
    const expectedUsd = (tokensIn * 0.9 + tokensOut * 1.5) / 1_000_000;
    const expected = Math.ceil(expectedUsd * 100);
    expect(estimateCostCredits('nousresearch/hermes-4-405b', tokensIn, tokensOut)).toBe(expected);
  });

  it('unknown model uses the FALLBACK_PRICE (in:1.0, out:2.0)', () => {
    const tokensIn = 500_000;
    const tokensOut = 250_000;
    const expectedUsd = (tokensIn * 1.0 + tokensOut * 2.0) / 1_000_000;
    const expected = Math.ceil(expectedUsd * 100);
    expect(estimateCostCredits('some/unknown-model-xyz', tokensIn, tokensOut)).toBe(expected);
  });

  it('zero tokens cost 0 credits', () => {
    expect(estimateCostCredits('nousresearch/hermes-4-405b', 0, 0)).toBe(0);
  });

  it('a sub-cent run rounds UP to 1 credit (never free, never a fraction)', () => {
    // 1 in-token + 1 out-token of hermes ≈ $2.4e-12 → ceil to 1 cent.
    expect(estimateCostCredits('nousresearch/hermes-4-405b', 1, 1)).toBe(1);
  });
});

/**
 * CHARGE-0 regression: finalBillableCostCredits floors the BILLABLE settle amount
 * to MIN_RUN_COST so a zero-usage gateway charge or a zero-token estimate can
 * never settle a billable run at 0 credits (free). The external / BYOK path must
 * stay exactly 0 (the user pays their own provider).
 */
describe('finalBillableCostCredits — CHARGE-0 floor on the billable settle amount', () => {
  it('billable zero-usage run (raw 0) settles at MIN_RUN_COST, NOT 0', () => {
    expect(finalBillableCostCredits(0, false)).toBe(MIN_RUN_COST);
  });

  it('billable run at exactly the floor stays MIN_RUN_COST', () => {
    expect(finalBillableCostCredits(MIN_RUN_COST, false)).toBe(MIN_RUN_COST);
  });

  it('billable run above the floor is passed through unchanged (no over-charge)', () => {
    expect(finalBillableCostCredits(750, false)).toBe(750);
  });

  it('EXTERNAL / BYOK run stays exactly 0 even with a raw 0 (no floor)', () => {
    expect(finalBillableCostCredits(0, true)).toBe(0);
  });

  it('EXTERNAL / BYOK run stays 0 — the floor is never applied to it', () => {
    // Even if a nonzero raw value were somehow passed, external must not be billed.
    expect(finalBillableCostCredits(500, true)).toBe(0);
  });
});

/**
 * Daily-spend guard invariant. The atomic UPDATE in db.ts settleRun encodes:
 *   WHERE spent_today_credits + cost <= daily_budget_credits
 * i.e. the run is allowed only if the post-increment total stays within budget.
 * This pure predicate documents the exact boundary the SQL guard enforces.
 */
function dailyGuardAllows(spentToday: number, cost: number, dailyBudget: number): boolean {
  return spentToday + cost <= dailyBudget;
}

describe('daily-spend guard boundary (mirrors the settleRun atomic UPDATE WHERE clause)', () => {
  it('spent + cost < budget → allowed', () => {
    expect(dailyGuardAllows(50, 10, 100)).toBe(true);
  });

  it('spent + cost == budget (exact boundary) → allowed (<=)', () => {
    expect(dailyGuardAllows(90, 10, 100)).toBe(true);
  });

  it('spent + cost > budget → blocked', () => {
    expect(dailyGuardAllows(95, 10, 100)).toBe(false);
  });

  it('concurrency: 4 runs of cost 30 against a budget of 100 — only the first 3 cumulative passes fit', () => {
    const budget = 100;
    const cost = 30;
    let spent = 0;
    const outcomes: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      const allowed = dailyGuardAllows(spent, cost, budget);
      outcomes.push(allowed);
      if (allowed) spent += cost; // the atomic UPDATE only increments on a pass
    }
    // 30,60,90 fit (<=100); the 4th (90+30=120) is blocked → spent never exceeds budget
    expect(outcomes).toEqual([true, true, true, false]);
    expect(spent).toBeLessThanOrEqual(budget);
  });
});
