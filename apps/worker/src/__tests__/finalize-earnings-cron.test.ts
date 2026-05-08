/**
 * Tests for finalizeEarningsCron (Phase 14 §5 Step 5).
 *
 * Schema mapping: spec text says "pending → available", but migration 0014
 * uses author_earnings.status values 'accruing' | 'locked' | 'paid'. The cron
 * promotes accruing → locked when available_at < NOW().
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runFinalizeEarningsOnce } from '../queues/finalize-earnings-cron.js';

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): { sql: string; values: unknown[] } {
  let out = '';
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) out += `$${i + 1}`;
  }
  return { sql: out, values };
}

describe('runFinalizeEarningsOnce', () => {
  beforeEach(() => vi.clearAllMocks());

  it('Test 1: rows with status=accruing AND available_at < now() are promoted to locked', async () => {
    let captured: { sql: string; values: unknown[] } | undefined;
    const db = {
      execute: vi.fn(async (q: unknown) => {
        captured = q as typeof captured;
        return { rowCount: 3 };
      }),
    };
    const result = await runFinalizeEarningsOnce(db as never, fakeSql as never);
    expect(result.rowsTransitioned).toBe(3);
    expect(captured!.sql).toMatch(/UPDATE author_earnings/i);
    expect(captured!.sql).toMatch(/SET\s+status\s*=\s*'locked'/i);
    expect(captured!.sql).toMatch(/WHERE\s+status\s*=\s*'accruing'/i);
    expect(captured!.sql).toMatch(/available_at\s*<\s*NOW\(\)/i);
  });

  it('Test 2: rows still inside 30-day buffer are not touched (filter check)', async () => {
    // Verified by SQL filter: WHERE status='accruing' AND available_at < NOW().
    // We assert the SQL itself contains both predicates (the DB guarantees the rest).
    const db = { execute: vi.fn(async () => ({ rowCount: 0 })) };
    await runFinalizeEarningsOnce(db as never, fakeSql as never);
    const call = db.execute.mock.calls[0]?.[0] as { sql: string };
    expect(call.sql).toMatch(/available_at\s*IS NOT NULL/i);
    expect(call.sql).toMatch(/available_at\s*<\s*NOW\(\)/i);
  });

  it('Test 3: status=paid rows never matched (filter check)', async () => {
    const db = { execute: vi.fn(async () => ({ rowCount: 0 })) };
    await runFinalizeEarningsOnce(db as never, fakeSql as never);
    const call = db.execute.mock.calls[0]?.[0] as { sql: string };
    // The WHERE clause limits to status='accruing', so 'paid' is excluded by definition.
    expect(call.sql).toMatch(/status\s*=\s*'accruing'/i);
    expect(call.sql).not.toMatch(/status\s*=\s*'paid'/i);
  });

  it('Test 4: returns count of rows transitioned for logging', async () => {
    const db = { execute: vi.fn(async () => ({ rowCount: 7 })) };
    const r = await runFinalizeEarningsOnce(db as never, fakeSql as never);
    expect(r).toEqual({ rowsTransitioned: 7 });
  });

  it('Test 5: no eligible rows → no-op, returns 0', async () => {
    const db = { execute: vi.fn(async () => ({ rowCount: 0 })) };
    const r = await runFinalizeEarningsOnce(db as never, fakeSql as never);
    expect(r.rowsTransitioned).toBe(0);
    // Idempotent: running again still returns 0.
    const r2 = await runFinalizeEarningsOnce(db as never, fakeSql as never);
    expect(r2.rowsTransitioned).toBe(0);
  });

  it('handles missing rowCount gracefully (returns 0)', async () => {
    const db = { execute: vi.fn(async () => ({})) };
    const r = await runFinalizeEarningsOnce(db as never, fakeSql as never);
    expect(r.rowsTransitioned).toBe(0);
  });
});
