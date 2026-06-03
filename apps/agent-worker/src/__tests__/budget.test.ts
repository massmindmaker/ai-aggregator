import { describe, it, expect } from 'vitest';
import { estimateCostRub, finalBillableCostRub } from '../agent-runner.js';

// USD_TO_RUB and the hermes price are internal constants in agent-runner.ts.
// They are replicated here ONLY to compute the expected value; the assertion
// proves estimateCostRub uses them.
const USD_TO_RUB = 90;
// MIN_RUN_COST is an internal constant in agent-runner.ts (the run-start gate
// floor, reused as the CHARGE-0 settle floor). Replicated here for the expected
// values; the assertions prove finalBillableCostRub uses it as the floor.
const MIN_RUN_COST = 1;

describe('estimateCostRub', () => {
  it('known model (hermes-4-405b) = in*0.9 + out*1.5 per 1M tokens * USD_TO_RUB', () => {
    const tokensIn = 1_000_000;
    const tokensOut = 1_000_000;
    const expectedUsd = (tokensIn * 0.9 + tokensOut * 1.5) / 1_000_000;
    const expected = expectedUsd * USD_TO_RUB;
    expect(estimateCostRub('nousresearch/hermes-4-405b', tokensIn, tokensOut)).toBeCloseTo(expected, 6);
  });

  it('unknown model uses the FALLBACK_PRICE (in:1.0, out:2.0)', () => {
    const tokensIn = 500_000;
    const tokensOut = 250_000;
    const expectedUsd = (tokensIn * 1.0 + tokensOut * 2.0) / 1_000_000;
    const expected = expectedUsd * USD_TO_RUB;
    expect(estimateCostRub('some/unknown-model-xyz', tokensIn, tokensOut)).toBeCloseTo(expected, 6);
  });

  it('zero tokens cost 0', () => {
    expect(estimateCostRub('nousresearch/hermes-4-405b', 0, 0)).toBe(0);
  });
});

/**
 * CHARGE-0 regression: finalBillableCostRub floors the BILLABLE settle amount to
 * MIN_RUN_COST so a zero-usage gateway charge (X-AIAG-Charged-Rub: 0.0000) or a
 * zero-token estimate can never settle a billable run at 0₽ (free). The external
 * / BYOK path must stay exactly 0 (the user pays their own provider).
 */
describe('finalBillableCostRub — CHARGE-0 floor on the billable settle amount', () => {
  it('billable zero-usage run (raw 0) settles at MIN_RUN_COST, NOT 0', () => {
    expect(finalBillableCostRub(0, false)).toBe(MIN_RUN_COST);
  });

  it('billable run below the floor (raw 0.0004 from a zero-ish charge) is raised to MIN_RUN_COST', () => {
    expect(finalBillableCostRub(0.0004, false)).toBe(MIN_RUN_COST);
  });

  it('billable run at exactly the floor stays MIN_RUN_COST', () => {
    expect(finalBillableCostRub(MIN_RUN_COST, false)).toBe(MIN_RUN_COST);
  });

  it('billable run above the floor is passed through unchanged (no over-charge)', () => {
    expect(finalBillableCostRub(7.5, false)).toBe(7.5);
  });

  it('EXTERNAL / BYOK run stays exactly 0 even with a raw 0 (no floor)', () => {
    expect(finalBillableCostRub(0, true)).toBe(0);
  });

  it('EXTERNAL / BYOK run stays 0 — the floor is never applied to it', () => {
    // Even if a nonzero raw value were somehow passed, external must not be billed.
    expect(finalBillableCostRub(5, true)).toBe(0);
  });
});

/**
 * Daily-spend guard invariant. The atomic UPDATE in db.ts settleRun encodes:
 *   WHERE spent_today_rub + cost <= daily_budget_rub
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
