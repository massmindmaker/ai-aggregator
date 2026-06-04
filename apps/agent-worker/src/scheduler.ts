import type { Queue } from 'bullmq';
import { claimDueSchedules, insertScheduledRun } from './db.js';

// How often the scheduler polls for due schedules. 60s is the finest granularity
// the product exposes (min interval is 15m), so a 1-minute tick is plenty.
const TICK_MS = 60_000;

/**
 * One scheduler tick: atomically claim every due schedule and, for each, enqueue
 * a NORMAL agent run on the same 'agent-run' queue the TMA /run route uses. The
 * run then flows through runAgent() unchanged — daily/monthly budget guard,
 * settleRun, and the BYOK-zero rule all apply. We do NOT bill or guard here.
 *
 * Double-fire safety is in claimDueSchedules (atomic UPDATE … RETURNING). If an
 * agent was deleted, the FK row is gone: insertScheduledRun returns null (or the
 * worker's loadAgent later returns null → markFailed 'agent_not_found'); either
 * way we skip and never crash the tick.
 *
 * Exported (not just the interval) so a single tick is unit-testable.
 */
export async function runScheduleTick(queue: Queue): Promise<void> {
  let due;
  try {
    due = await claimDueSchedules();
  } catch (e) {
    console.error(`[scheduler] claim failed: ${(e as Error).message}`);
    return;
  }
  if (due.length === 0) return;

  for (const s of due) {
    try {
      const runId = await insertScheduledRun(s.agent_id, s.tg_user_id, s.prompt);
      if (!runId) {
        // Agent gone (FK) or insert produced no row — skip this schedule's fire.
        console.warn(`[scheduler] schedule=${s.id} produced no run (agent missing?) — skipped`);
        continue;
      }
      await queue.add('run', { runId }, { removeOnComplete: 100, removeOnFail: 100 });
      console.log(`[scheduler] enqueued scheduled run=${runId} schedule=${s.id} agent=${s.agent_id}`);
    } catch (e) {
      // A single failed fire must not abort the rest of this tick.
      console.error(`[scheduler] failed to enqueue schedule=${s.id}: ${(e as Error).message}`);
    }
  }
}

/**
 * Start the resident scheduler loop. Returns a stop() to clear the interval on
 * shutdown. Reuses the caller's BullMQ Queue (same Redis connection as the
 * Worker) — no second queue, no second connection.
 */
export function startScheduler(queue: Queue): { stop: () => void } {
  const timer = setInterval(() => {
    void runScheduleTick(queue);
  }, TICK_MS);
  // Don't let the scheduler interval keep the process alive on its own.
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[scheduler] schedule-tick every ${TICK_MS / 1000}s`);
  return {
    stop: () => clearInterval(timer),
  };
}
