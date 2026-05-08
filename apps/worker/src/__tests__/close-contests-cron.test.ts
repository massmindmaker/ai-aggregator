/**
 * Tests for closeContestsCron (Phase 14 §2 Step 1).
 *
 * Strategy: unit-test the pure `runCloseContestsOnce(db, sql)` function with a
 * stub `db` and a tag-template `sql` that just records the SQL strings.
 * No real Postgres, no BullMQ — those are integration concerns verified on VPS.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCloseContestsOnce } from '../queues/close-contests-cron.js';

// Tag-template that joins fragments back into a single string for assertions.
function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): { sql: string; values: unknown[] } {
  let out = '';
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) out += `$${i + 1}`;
  }
  return { sql: out, values };
}

interface ExecCall {
  sql: string;
  values: unknown[];
}

function makeDb(plan: Array<unknown>): { execute: (q: unknown) => Promise<unknown>; calls: ExecCall[]; transactionCalled: number } {
  const calls: ExecCall[] = [];
  let txCount = 0;
  const execute = vi.fn(async (q: unknown) => {
    const cast = q as ExecCall;
    calls.push({ sql: cast.sql, values: cast.values });
    const next = plan.shift();
    return next ?? { rows: [], rowCount: 0 };
  });
  // db.transaction(async (tx) => ...) — pass tx with the same execute function.
  const db = {
    execute,
    transaction: async <T>(cb: (tx: { execute: typeof execute }) => Promise<T>) => {
      txCount++;
      return cb({ execute });
    },
    get calls() { return calls; },
    get transactionCalled() { return txCount; },
  };
  // expose
  return db as unknown as ReturnType<typeof makeDb>;
}

describe('runCloseContestsOnce', () => {
  beforeEach(() => vi.clearAllMocks());

  it('Test 1: finds active contests with ends_at in past and processes them', async () => {
    const db = makeDb([
      // SELECT contests step → one due contest
      { rows: [{ id: 'c1', prizes: [{ place: 1, amount: 10000 }] }] },
      // per-contest: UPDATE final_rank
      { rowCount: 5 },
      // INSERT prize_awards
      { rowCount: 1 },
      // UPDATE contests SET status='closed'
      { rowCount: 1 },
    ]);
    const result = await runCloseContestsOnce(db as never, fakeSql as never);
    expect(result.contestsProcessed).toBe(1);
    // First call must be the SELECT for due contests
    expect(db.calls[0].sql).toMatch(/SELECT.*FROM contests/i);
    expect(db.calls[0].sql).toMatch(/ends_at\s*<\s*NOW\(\)/i);
    expect(db.calls[0].sql).toMatch(/status\s*<>\s*'closed'/i);
  });

  it('Test 2: assigns final_rank by private_score DESC and writes prize_awards', async () => {
    const db = makeDb([
      { rows: [{ id: 'c1', prizes: [{ place: 1, amount: 10000 }, { place: 2, amount: 5000 }, { place: 3, amount: 2500 }] }] },
      { rowCount: 5 },
      { rowCount: 3 },
      { rowCount: 1 },
    ]);
    const result = await runCloseContestsOnce(db as never, fakeSql as never);
    expect(result.contestsProcessed).toBe(1);
    expect(result.awardsCreated).toBe(3);
    // Statement: ROW_NUMBER OVER ORDER BY private_score DESC for ranking
    const rankStmt = db.calls.find((c) => /UPDATE contest_submissions/i.test(c.sql));
    expect(rankStmt).toBeTruthy();
    expect(rankStmt!.sql).toMatch(/ROW_NUMBER\(\)\s+OVER/i);
    expect(rankStmt!.sql).toMatch(/private_score\s+DESC/i);
    expect(rankStmt!.sql).toMatch(/final_rank/);
    // Statement: INSERT INTO prize_awards with ON CONFLICT DO NOTHING
    const insertStmt = db.calls.find((c) => /INSERT INTO prize_awards/i.test(c.sql));
    expect(insertStmt).toBeTruthy();
    expect(insertStmt!.sql).toMatch(/ON CONFLICT.*DO NOTHING/i);
  });

  it('Test 3: idempotency — running twice does not duplicate (relies on ON CONFLICT)', async () => {
    const db = makeDb([
      { rows: [{ id: 'c1', prizes: [{ place: 1, amount: 10000 }] }] },
      { rowCount: 5 },
      { rowCount: 1 },
      { rowCount: 1 },
      // second run — same contest no longer due (status='closed')
      { rows: [] },
    ]);
    const r1 = await runCloseContestsOnce(db as never, fakeSql as never);
    const r2 = await runCloseContestsOnce(db as never, fakeSql as never);
    expect(r1.contestsProcessed).toBe(1);
    expect(r2.contestsProcessed).toBe(0);
    // The INSERT must use ON CONFLICT DO NOTHING (verified by SQL inspection)
    const insertStmt = db.calls.find((c) => /INSERT INTO prize_awards/i.test(c.sql));
    expect(insertStmt!.sql).toMatch(/ON CONFLICT.*DO NOTHING/i);
  });

  it('Test 4: contest with NULL prizes → ranks but writes zero prize_awards', async () => {
    const db = makeDb([
      { rows: [{ id: 'c1', prizes: null }] },
      { rowCount: 5 },
      // INSERT still runs but ranges over an empty unnest → rowCount 0
      { rowCount: 0 },
      { rowCount: 1 },
    ]);
    const result = await runCloseContestsOnce(db as never, fakeSql as never);
    expect(result.contestsProcessed).toBe(1);
    expect(result.awardsCreated).toBe(0);
  });

  it('Test 5: contest with no submissions → just flips status, no error', async () => {
    const db = makeDb([
      { rows: [{ id: 'c1', prizes: [{ place: 1, amount: 10000 }] }] },
      { rowCount: 0 }, // no submissions to rank
      { rowCount: 0 }, // no awards
      { rowCount: 1 }, // status flip
    ]);
    const result = await runCloseContestsOnce(db as never, fakeSql as never);
    expect(result.contestsProcessed).toBe(1);
    expect(result.awardsCreated).toBe(0);
  });

  it('flips contest status to closed', async () => {
    const db = makeDb([
      { rows: [{ id: 'c1', prizes: [] }] },
      { rowCount: 0 },
      { rowCount: 0 },
      { rowCount: 1 },
    ]);
    await runCloseContestsOnce(db as never, fakeSql as never);
    const flip = db.calls.find((c) => /UPDATE contests/i.test(c.sql) && /status\s*=\s*'closed'/i.test(c.sql));
    expect(flip).toBeTruthy();
  });

  it('uses transaction per contest for atomicity', async () => {
    const db = makeDb([
      { rows: [{ id: 'c1', prizes: [] }, { id: 'c2', prizes: [] }] },
      { rowCount: 0 }, { rowCount: 0 }, { rowCount: 1 },
      { rowCount: 0 }, { rowCount: 0 }, { rowCount: 1 },
    ]);
    await runCloseContestsOnce(db as never, fakeSql as never);
    expect(db.transactionCalled).toBe(2);
  });
});
