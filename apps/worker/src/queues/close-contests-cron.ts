/**
 * closeContestsCron — Phase 14 §2 Step 1.
 *
 * Hourly cron that:
 *   1. Finds contests whose `ends_at` has passed and `status <> 'closed'`.
 *   2. For each such contest, atomically (per-contest transaction):
 *      a. Assigns `final_rank` to every submission, ordered by `private_score DESC NULLS LAST`.
 *      b. Inserts `prize_awards` rows for ranks present in `contests.prizes` jsonb
 *         (Array<{place, amount}>), `ON CONFLICT (contest_id, submission_id, rank) DO NOTHING`
 *         — idempotent so re-runs are safe.
 *      c. Flips `contests.status = 'closed'`.
 *
 * Atomicity is per-contest: if one contest fails, the others still process.
 *
 * The pure `runCloseContestsOnce(db, sql)` function is exported separately so
 * unit tests can inject a fake db without spinning up Postgres or BullMQ.
 *
 * Wired into apps/worker/src/index.ts; runs as a BullMQ repeatable job.
 */
import { Queue, Worker } from 'bullmq';
import type IORedis from 'ioredis';
import { logger } from '../logger.js';

export const QUEUE_NAME = 'close-contests-cron';

export interface CloseContestsResult {
  contestsProcessed: number;
  awardsCreated: number;
}

export interface CloseContestsDeps {
  runOnce: () => Promise<CloseContestsResult>;
}

/**
 * Minimal db shape needed by `runCloseContestsOnce`. Matches drizzle's
 * `NodePgDatabase` (which exposes both `.execute` and `.transaction`) but is
 * narrowed so tests can supply a stub.
 */
interface CronDb {
  execute: (q: unknown) => Promise<{ rows?: unknown[]; rowCount?: number } | unknown>;
  transaction: <T>(cb: (tx: { execute: CronDb['execute'] }) => Promise<T>) => Promise<T>;
}

type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => unknown;

/**
 * Pure runOnce: reads ALL due contests in one query, then loops with a
 * per-contest transaction. Errors inside a single contest's tx are caught and
 * logged so the cron makes progress on the rest.
 */
export async function runCloseContestsOnce(
  db: CronDb,
  sql: SqlTag
): Promise<CloseContestsResult> {
  const dueRes = (await db.execute(sql`
    SELECT id, prizes FROM contests
    WHERE ends_at IS NOT NULL
      AND ends_at < NOW()
      AND status <> 'closed'
    ORDER BY ends_at ASC
  `)) as { rows?: Array<{ id: string; prizes: Array<{ place: number; amount: number }> | null }> };

  const due = dueRes.rows ?? [];

  let contestsProcessed = 0;
  let awardsCreated = 0;

  for (const c of due) {
    try {
      await db.transaction(async (tx) => {
        // Step a: assign final_rank by ROW_NUMBER() OVER ORDER BY private_score DESC NULLS LAST
        await tx.execute(sql`
          WITH ranked AS (
            SELECT id,
                   ROW_NUMBER() OVER (
                     PARTITION BY contest_id
                     ORDER BY private_score DESC NULLS LAST, created_at ASC
                   ) AS rk
            FROM contest_submissions
            WHERE contest_id = ${c.id}
          )
          UPDATE contest_submissions cs
             SET final_rank = ranked.rk
            FROM ranked
           WHERE cs.id = ranked.id
        `);

        // Step b: write prize_awards. contests.prizes is jsonb Array<{place, amount}>.
        // Use jsonb_to_recordset to expand the array, JOIN against ranked submissions
        // on final_rank = place. ON CONFLICT keeps the cron idempotent — the
        // unique index `idx_prize_awards_uniq(contest_id, submission_id, rank)`
        // (migration 0014) blocks duplicates on re-run.
        const insertRes = (await tx.execute(sql`
          INSERT INTO prize_awards (contest_id, submission_id, user_id, rank, amount_rub, status, created_at)
          SELECT cs.contest_id,
                 cs.id,
                 cs.user_id,
                 cs.final_rank,
                 (p.amount)::numeric,
                 'pending',
                 NOW()
            FROM contest_submissions cs
            JOIN jsonb_to_recordset(
                   COALESCE(
                     (SELECT prizes FROM contests WHERE id = ${c.id}),
                     '[]'::jsonb
                   )
                 ) AS p(place int, amount numeric)
              ON p.place = cs.final_rank
           WHERE cs.contest_id = ${c.id}
             AND cs.final_rank IS NOT NULL
          ON CONFLICT (contest_id, submission_id, rank) DO NOTHING
        `)) as { rowCount?: number };
        awardsCreated += insertRes.rowCount ?? 0;

        // Step c: flip status
        await tx.execute(sql`
          UPDATE contests SET status = 'closed' WHERE id = ${c.id}
        `);
      });
      contestsProcessed++;
    } catch (err) {
      // Per-contest isolation — keep going.
      logger.error({ err, contestId: c.id }, 'close-contests-cron: contest failed');
    }
  }

  return { contestsProcessed, awardsCreated };
}

/**
 * Wire the cron into BullMQ: enqueues a `tick` job every hour at minute 0,
 * and runs `deps.runOnce()` on each tick. Returns `{close}` for graceful
 * shutdown.
 */
export function startCloseContestsCron(connection: IORedis, deps: CloseContestsDeps) {
  const queue = new Queue(QUEUE_NAME, { connection });
  // Repeatable: every hour at minute 0. jobId 'tick' makes it idempotent on
  // worker restart (BullMQ dedups by jobId for repeatable definitions).
  void queue.add(
    'tick',
    {},
    { repeat: { pattern: '0 * * * *' }, jobId: 'tick' }
  );

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      const r = await deps.runOnce();
      logger.info(r, 'close-contests-cron tick');
      return r;
    },
    { connection }
  );

  return {
    close: async (): Promise<void> => {
      await worker.close();
      await queue.close();
    },
  };
}
