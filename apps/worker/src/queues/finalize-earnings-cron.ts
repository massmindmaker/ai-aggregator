/**
 * finalizeEarningsCron — Phase 14 §5 Step 5.
 *
 * Daily cron that promotes per-request author_earnings rows from
 * `status='accruing'` to `status='locked'` once their 30-day buffer
 * (`available_at`) has elapsed. After this transition the admin payouts UI
 * (plan 14-04) reads them as payable.
 *
 * Schema mapping note: spec §5 text says "pending → available", but migration
 * 0014 standardised on three statuses: 'accruing' | 'locked' | 'paid'. We map
 * spec terminology onto the existing schema:
 *   - "pending" (spec)   → 'accruing' (schema, hooked by aiag_settle_charge)
 *   - "available" (spec) → 'locked'    (schema, payable by admin)
 *   - "paid" (both)      → 'paid'
 *
 * The pure `runFinalizeEarningsOnce(db, sql)` is a single SQL UPDATE — fully
 * idempotent: rows already locked/paid are filtered out by `status='accruing'`,
 * rows still inside the buffer are filtered by `available_at < NOW()`.
 */
import { Queue, Worker } from 'bullmq';
import type IORedis from 'ioredis';
import { logger } from '../logger.js';

export const QUEUE_NAME = 'finalize-earnings-cron';

export interface FinalizeEarningsResult {
  rowsTransitioned: number;
}

export interface FinalizeEarningsDeps {
  runOnce: () => Promise<FinalizeEarningsResult>;
}

interface CronDb {
  execute: (q: unknown) => Promise<{ rowCount?: number } | unknown>;
}

type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => unknown;

export async function runFinalizeEarningsOnce(
  db: CronDb,
  sql: SqlTag
): Promise<FinalizeEarningsResult> {
  const r = (await db.execute(sql`
    UPDATE author_earnings
       SET status = 'locked'
     WHERE status = 'accruing'
       AND available_at IS NOT NULL
       AND available_at < NOW()
  `)) as { rowCount?: number };
  return { rowsTransitioned: r.rowCount ?? 0 };
}

/**
 * BullMQ wrapper. Repeatable at 04:00 UTC daily — late enough that any
 * settle_charge hooks from the previous day's traffic have committed.
 */
export function startFinalizeEarningsCron(connection: IORedis, deps: FinalizeEarningsDeps) {
  const queue = new Queue(QUEUE_NAME, { connection });
  void queue.add(
    'tick',
    {},
    { repeat: { pattern: '0 4 * * *' }, jobId: 'tick' }
  );

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      const r = await deps.runOnce();
      logger.info(r, 'finalize-earnings-cron tick');
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
