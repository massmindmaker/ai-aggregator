---
phase: 14-contest-marketplace-admin
plan: 02
type: execute
wave: 2
depends_on: [14-01]
files_modified:
  - apps/worker/src/queues/close-contests-cron.ts
  - apps/worker/src/queues/finalize-earnings-cron.ts
  - apps/worker/src/index.ts
  - apps/worker/src/__tests__/close-contests-cron.test.ts
  - apps/worker/src/__tests__/finalize-earnings-cron.test.ts
autonomous: true
requirements:
  - REQ-CONTEST-001
  - REQ-CONTEST-002
  - REQ-PAYOUT-001
tags: [phase14, cron, worker, contests, earnings]
must_haves:
  truths:
    - "closeContestsCron sets final_rank on submissions and writes prize_awards rows for top-K winners"
    - "finalizeEarningsCron promotes author_earnings rows from accruing→locked after 30-day available_at window passes"
  artifacts:
    - path: apps/worker/src/queues/close-contests-cron.ts
      provides: "Hourly contest finalizer"
      contains: "final_rank"
    - path: apps/worker/src/queues/finalize-earnings-cron.ts
      provides: "Daily earnings finalizer"
      contains: "available_at"
  key_links:
    - from: apps/worker/src/index.ts
      to: close-contests-cron + finalize-earnings-cron
      via: "scheduled BullMQ repeatable jobs"
      pattern: "startCloseContestsCron|startFinalizeEarningsCron"
---

<objective>
Two scheduled jobs running in the existing apps/worker process: closeContestsCron (hourly) and finalizeEarningsCron (daily). closeContestsCron implements spec §2 Step 1; finalizeEarningsCron implements the 30-day buffer described in spec §5 Step 5.

Purpose: Without these crons, prize_awards never get written and accrued earnings never become payable. Admin payouts UI in 14-04 reads `status='locked'` rows.
Output: Two TS files in `apps/worker/src/queues/`, registered in `index.ts`, with vitest unit tests covering the SQL transformations.
</objective>

<execution_context>
@C:/Users/боб/.claude/plugins/cache/gsd-plugin/gsd/2.38.7/workflows/execute-plan.md
@C:/Users/боб/.claude/plugins/cache/gsd-plugin/gsd/2.38.7/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/phases/14-contest-marketplace-admin/14-01-SUMMARY.md
@docs/superpowers/specs/2026-05-08-phase14-contest-marketplace-workflow-design.md
@apps/worker/src/index.ts
@apps/worker/src/queues/upstream-poll.ts
@apps/worker/src/queues/contest-eval.ts

<interfaces>
Worker uses BullMQ. Existing queue file pattern (from upstream-poll.ts/contest-eval.ts):
- Each queue has a `start*Worker(connection, deps)` factory.
- Repeatable jobs added via `Queue.add(name, data, { repeat: { pattern: '0 * * * *' } })` cron syntax.
- Workers exported as `{ close(): Promise<void> }` for graceful shutdown.

DB access: workers may use `await import('@aiag/database')` (see index.ts lines 64-66 for lazy-import pattern), then `db.execute(sql\`...\`)`.

contests table columns relevant: `id, status, ends_at, total_prize_pool numeric, prizes jsonb` (see schema/contests.ts lines 22-58). prizes is `Array<{place: number, amount: number}>`.
contest_submissions: post-14-01 has `final_rank int`, `private_score numeric` (already exists).
prize_awards (post-14-01): id, contest_id, submission_id, user_id, rank, amount_rub, status, created_at.
author_earnings (post-14-01): has `gateway_request_id`, `gross_rub`, `tier_pct_decimal`, `net_rub`, `available_at`, `status`. status values: 'accruing' | 'locked' | 'paid'.
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: closeContestsCron — finalize ranks + write prize_awards</name>
  <files>apps/worker/src/queues/close-contests-cron.ts, apps/worker/src/__tests__/close-contests-cron.test.ts</files>

  <read_first>
    - Spec lines 27-37 (§2 Step 1 — exact algorithm: finalize private_score, rank by private_score DESC, distribute prize_pool per `contest.prizes` jsonb).
    - `apps/worker/src/queues/upstream-poll.ts` (queue boilerplate pattern).
    - `apps/worker/src/queues/contest-eval.ts` (DB-touching worker pattern).
    - `packages/database/src/schema/contests.ts` lines 51-58 (prizes jsonb shape: `Array<{place: number, amount: number}>`).
  </read_first>

  <behavior>
    - Test 1: Given contest with status='active' but ends_at in the past, cron sets contests.status='closed' and processes it.
    - Test 2: Given 5 submissions with private_score [9.5, 8.2, 8.8, 7.1, 9.0] and prizes [{place:1,amount:10000},{place:2,amount:5000},{place:3,amount:2500}], cron writes final_rank = 1,3,2,5,4 (sorted DESC by score) and creates 3 prize_awards rows with amounts 10000/5000/2500 to users at ranks 1/2/3.
    - Test 3: Idempotency — running cron twice on same closed contest does not duplicate prize_awards (uniqueIndex idx_prize_awards_uniq enforces).
    - Test 4: Contest with NULL prizes jsonb → cron sets final_rank but writes zero prize_awards (no error).
    - Test 5: Contest with no submissions → cron just flips status='closed', no errors.
  </behavior>

  <action>
Create `apps/worker/src/queues/close-contests-cron.ts`:

```ts
/**
 * closeContestsCron — Phase 14 §2 Step 1.
 * Hourly: finalize private_score, set final_rank, distribute prize_pool to prize_awards.
 */
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { logger } from '../logger.js';

export const QUEUE_NAME = 'close-contests-cron';

export interface CloseContestsDeps {
  runOnce: () => Promise<{ contestsProcessed: number; awardsCreated: number }>;
}

export function startCloseContestsCron(connection: ConnectionOptions, deps: CloseContestsDeps) {
  const queue = new Queue(QUEUE_NAME, { connection });
  // Repeatable: every hour at minute 0
  void queue.add('tick', {}, { repeat: { pattern: '0 * * * *' }, jobId: 'tick' });

  const worker = new Worker(QUEUE_NAME, async () => {
    const r = await deps.runOnce();
    logger.info(r, 'close-contests-cron tick');
    return r;
  }, { connection });

  return {
    close: async () => {
      await worker.close();
      await queue.close();
    },
  };
}

export async function runCloseContestsOnce(db: { execute: (q: unknown) => Promise<unknown> }, sql: (s: TemplateStringsArray, ...v: unknown[]) => unknown): Promise<{ contestsProcessed: number; awardsCreated: number }> {
  // 1. Find contests where ends_at < now() AND status != 'closed'
  // 2. For each contest:
  //    a. UPDATE contest_submissions SET final_rank = rk FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY private_score DESC NULLS LAST) AS rk FROM contest_submissions WHERE contest_id=$1) sub WHERE contest_submissions.id = sub.id;
  //    b. SELECT prizes jsonb from contests; for each {place, amount} entry: SELECT user_id FROM contest_submissions WHERE contest_id=$1 AND final_rank=place; INSERT INTO prize_awards(contest_id, submission_id, user_id, rank, amount_rub, status) VALUES (...) ON CONFLICT (contest_id, submission_id, rank) DO NOTHING.
  //    c. UPDATE contests SET status='closed' WHERE id=$1;
  // 3. Return counters.
  // ... full implementation reads contests one at a time, no transactions across contests (each contest's awards are atomic via single multi-statement).
}
```

Implement `runCloseContestsOnce` as a pure function taking `(db, sql)` so unit tests can inject a fake.

**W-3 concrete SQL (replace the comment-pseudocode above with these two statements per contest, both wrapped in `db.transaction(async (tx) => { ... })` for per-contest atomicity):**

```sql
-- Statement 1: assign final_rank by private_score DESC
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY contest_id ORDER BY private_score DESC NULLS LAST) AS rk
  FROM contest_submissions
  WHERE contest_id = $1
)
UPDATE contest_submissions cs SET final_rank = ranked.rk
FROM ranked WHERE cs.id = ranked.id;

-- Statement 2: distribute prize_pool per contests.prize_distribution jsonb (or contests.prizes — verify schema)
INSERT INTO prize_awards (contest_id, submission_id, user_id, rank, amount_rub, status, created_at)
SELECT cs.contest_id, cs.id, cs.user_id, cs.final_rank,
       (c.total_prize_pool::numeric * (c.prize_distribution->>(cs.final_rank::text))::numeric / 100.0),
       'pending', now()
FROM contest_submissions cs
JOIN contests c ON c.id = cs.contest_id
WHERE cs.contest_id = $1 AND cs.final_rank IS NOT NULL
  AND (c.prize_distribution ? cs.final_rank::text)
ON CONFLICT (contest_id, submission_id, rank) DO NOTHING;

-- Statement 3: flip contest status
UPDATE contests SET status='closed' WHERE id = $1;
```

NOTE: Read `packages/database/src/schema/contests.ts` to confirm whether prize-distribution column is named `prizes` (jsonb array of `{place, amount}`) or `prize_distribution` (jsonb object `{"1": 50, "2": 30, ...}` — percentages). The SQL above ASSUMES the latter shape (percentage map keyed by rank-as-string); if the schema uses the array shape, the executor MUST adapt the JOIN: e.g. `jsonb_array_elements(c.prizes) WITH ORDINALITY` and match `(elem->>'place')::int = cs.final_rank`, then read `(elem->>'amount')::numeric`. Either way, the final INSERT SHAPE (columns, ON CONFLICT) is unchanged.

Wrap each contest's pair (UPDATE + INSERT + flip-status) in a single `await db.transaction(async (tx) => { await tx.execute(sql\); ... })` block — atomicity per contest, NOT across contests. If one contest fails, others still process (catch + log per iteration).

Create test file `apps/worker/src/__tests__/close-contests-cron.test.ts` mirroring the pattern in `apps/web/src/__tests__/admin-routing.test.ts`:
- Mock `db.execute` with `vi.fn()` returning ordered rows for each step.
- Assert SQL strings (loose match: `.toMatch(/UPDATE contest_submissions/)` etc.) for each step.
- Assert returned counters.
  </action>

  <verify>
    <automated>test -f apps/worker/src/queues/close-contests-cron.ts &amp;&amp; test -f apps/worker/src/__tests__/close-contests-cron.test.ts &amp;&amp; grep -c "final_rank" apps/worker/src/queues/close-contests-cron.ts | grep -q "[1-9]" &amp;&amp; grep -c "INSERT INTO prize_awards" apps/worker/src/queues/close-contests-cron.ts | grep -q "^1$" &amp;&amp; grep -c "ON CONFLICT" apps/worker/src/queues/close-contests-cron.ts | grep -q "^1$" &amp;&amp; grep -c "ROW_NUMBER() OVER" apps/worker/src/queues/close-contests-cron.ts | grep -q "[1-9]" &amp;&amp; grep -c "INSERT INTO prize_awards" apps/worker/src/queues/close-contests-cron.ts | grep -q "[1-9]" &amp;&amp; grep -c "db.transaction\|tx.execute" apps/worker/src/queues/close-contests-cron.ts | grep -q "[1-9]" &amp;&amp; npx tsc --noEmit -p apps/worker/tsconfig.json</automated>
  </verify>

  <done>
    File exists, exports `startCloseContestsCron` and `runCloseContestsOnce`, tests cover the 5 behaviors, tsc passes, idempotent INSERT in place.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: finalizeEarningsCron — accruing → locked after 30-day buffer</name>
  <files>apps/worker/src/queues/finalize-earnings-cron.ts, apps/worker/src/__tests__/finalize-earnings-cron.test.ts, apps/worker/src/index.ts</files>

  <read_first>
    - Spec lines 99-105 (§5 Step 5 — 30-day pending → available transition).
    - `apps/worker/src/index.ts` lines 33-56 (where queues are wired into bootstrap + workers array + graceful shutdown).
    - Existing migration 0014: author_earnings status values are 'accruing' | 'locked' | 'paid'. Spec text says "pending" → "available"; we map to existing schema as 'accruing' → 'locked'.
  </read_first>

  <behavior>
    - Test 1: Row with status='accruing' AND available_at < now() → updated to status='locked'.
    - Test 2: Row with status='accruing' AND available_at > now() (still in 30-day buffer) → unchanged.
    - Test 3: Row with status='paid' → never touched.
    - Test 4: Cron returns count of rows transitioned for logging.
    - Test 5: Cron is idempotent — running twice with no eligible rows is a no-op (UPDATE ... WHERE status='accruing' AND available_at < now()).
  </behavior>

  <action>
Create `apps/worker/src/queues/finalize-earnings-cron.ts`:

```ts
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { logger } from '../logger.js';

export const QUEUE_NAME = 'finalize-earnings-cron';

export interface FinalizeEarningsDeps {
  runOnce: () => Promise<{ rowsTransitioned: number }>;
}

export function startFinalizeEarningsCron(connection: ConnectionOptions, deps: FinalizeEarningsDeps) {
  const queue = new Queue(QUEUE_NAME, { connection });
  // Daily at 04:00 UTC
  void queue.add('tick', {}, { repeat: { pattern: '0 4 * * *' }, jobId: 'tick' });

  const worker = new Worker(QUEUE_NAME, async () => {
    const r = await deps.runOnce();
    logger.info(r, 'finalize-earnings-cron tick');
    return r;
  }, { connection });

  return {
    close: async () => { await worker.close(); await queue.close(); },
  };
}

export async function runFinalizeEarningsOnce(
  db: { execute: (q: unknown) => Promise<{ rowCount?: number }> },
  sql: (s: TemplateStringsArray, ...v: unknown[]) => unknown
): Promise<{ rowsTransitioned: number }> {
  const r = await db.execute(sql`
    UPDATE author_earnings
       SET status = 'locked'
     WHERE status = 'accruing'
       AND available_at IS NOT NULL
       AND available_at < NOW()
  `);
  return { rowsTransitioned: r.rowCount ?? 0 };
}
```

Wire into `apps/worker/src/index.ts`:
1. Add imports near other `startXxxWorker` imports.
2. Inside `main()`, after existing workers are started, add:
   ```ts
   const closeContests = startCloseContestsCron(connection, {
     runOnce: async () => {
       if (!process.env.DATABASE_URL) return { contestsProcessed: 0, awardsCreated: 0 };
       const { createDb, sql } = await import('@aiag/database');
       const db = createDb(process.env.DATABASE_URL);
       const { runCloseContestsOnce } = await import('./queues/close-contests-cron.js');
       return runCloseContestsOnce(db, sql);
     },
   });
   const finalizeEarnings = startFinalizeEarningsCron(connection, {
     runOnce: async () => {
       if (!process.env.DATABASE_URL) return { rowsTransitioned: 0 };
       const { createDb, sql } = await import('@aiag/database');
       const db = createDb(process.env.DATABASE_URL);
       const { runFinalizeEarningsOnce } = await import('./queues/finalize-earnings-cron.js');
       return runFinalizeEarningsOnce(db, sql);
     },
   });
   ```
3. Append `closeContests, finalizeEarnings` to the `workers` array (line 56) so SIGTERM closes them.

Create `apps/worker/src/__tests__/finalize-earnings-cron.test.ts` testing `runFinalizeEarningsOnce` with mocked db.execute returning `{ rowCount: N }` for the 5 behaviors above. Assert the SQL contains `status = 'locked'`, `WHERE status = 'accruing'`, and `available_at < NOW()`.
  </action>

  <verify>
    <automated>test -f apps/worker/src/queues/finalize-earnings-cron.ts &amp;&amp; test -f apps/worker/src/__tests__/finalize-earnings-cron.test.ts &amp;&amp; grep -c "startFinalizeEarningsCron" apps/worker/src/index.ts | grep -q "[1-9]" &amp;&amp; grep -c "startCloseContestsCron" apps/worker/src/index.ts | grep -q "[1-9]" &amp;&amp; grep -c "status = 'locked'" apps/worker/src/queues/finalize-earnings-cron.ts | grep -q "^1$" &amp;&amp; npx tsc --noEmit -p apps/worker/tsconfig.json</automated>
  </verify>

  <done>
    Both cron files exist + are registered in `index.ts` + appended to `workers[]` array; tests cover the 5 behaviors; tsc passes; SQL UPDATE matches the spec semantics.
  </done>
</task>

</tasks>

<verification>
- Both cron source files exist and export start* + runOnce functions.
- index.ts registers both crons.
- Test files mirror admin-routing.test.ts structure (vi.mock + db.execute fake).
- `npx tsc --noEmit -p apps/worker/tsconfig.json` exits 0.
- Crons NOT actually running here — they start when worker process restarts on VPS (handled by deploy in plan 14-07).
</verification>

<success_criteria>
1. closeContestsCron sets final_rank by ROW_NUMBER() OVER private_score DESC and writes prize_awards via ON CONFLICT DO NOTHING idempotent insert.
2. finalizeEarningsCron flips eligible rows accruing→locked exactly once per row.
3. Both wired into worker bootstrap with graceful shutdown.
4. Unit tests for both pure runOnce functions.
</success_criteria>

<output>
After completion, create `.planning/phases/14-contest-marketplace-admin/14-02-SUMMARY.md`.
</output>
