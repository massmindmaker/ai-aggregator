import type IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { ensureOwnedBatchJob, type OwnedBatchQueue } from '@aiag/api-gateway/batch-runtime';
import { logger } from '../logger.js';

export type BatchRecoveryStore = Readonly<{
  listRecoverableStoredBatches(now: string, limit?: number): Promise<readonly string[]>;
  reconcileStaleProcessing?(now: string, graceSeconds: number, limit: number): Promise<readonly string[]>;
  recoverEvidence?(now: string, limit: number): Promise<Readonly<{ selected: number; recovered: number; unconfirmed: number }>>;
}>;

export type BatchRecoveryEnqueue = (batchId: string) => Promise<void>;

export type BatchRecoveryResult = Readonly<{
  selected: number;
  enqueued: number;
  failed: number;
}>;

const DEFAULT_LIMIT = 100;
const DEFAULT_INTERVAL_MS = 30_000;

async function defaultStore(now: string, limit?: number): Promise<readonly string[]> {
  const module = await import('@aiag/api-gateway/batch-runtime') as unknown as {
    listRecoverableStoredBatches?: (at: string, page?: number) => Promise<readonly string[]>;
  };
  if (!module.listRecoverableStoredBatches) throw new Error('BATCH_RECOVERY_SELECTOR_UNAVAILABLE');
  return module.listRecoverableStoredBatches(now, limit);
}

async function defaultStaleProcessing(now: string, graceSeconds: number, limit: number): Promise<readonly string[]> {
  const { reconcileStaleStoredBatchProcessing } = await import('@aiag/api-gateway/batch-runtime');
  return reconcileStaleStoredBatchProcessing(now, graceSeconds, limit);
}

async function defaultEvidenceRecovery(now: string, limit: number) {
  const { recoverStoredBatchEvidenceOnce } = await import('@aiag/api-gateway/batch-runtime');
  return recoverStoredBatchEvidenceOnce(now, limit);
}

const defaultRecoveryStore: BatchRecoveryStore = {
  listRecoverableStoredBatches: defaultStore,
  reconcileStaleProcessing: defaultStaleProcessing,
  recoverEvidence: defaultEvidenceRecovery,
};

async function enqueueOwnedBatchWithConnection(connection: IORedis, batchId: string): Promise<void> {
  const queue = new Queue('batch-process', { connection });
  try {
    await ensureOwnedBatchJob(queue as unknown as OwnedBatchQueue, batchId);
  } finally {
    await queue.close();
  }
}

/** One bounded, side-effect-free selection pass. Queue ownership is the
 * deterministic producer's job; this function carries only the batch id. */
export async function recoverOwnedBatchesOnce(
  store: BatchRecoveryStore,
  enqueue: BatchRecoveryEnqueue,
  limit = DEFAULT_LIMIT,
  now = new Date().toISOString(),
): Promise<BatchRecoveryResult> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new RangeError('Invalid recovery limit');
  }
  const ids = await store.listRecoverableStoredBatches(now, limit);
  let enqueued = 0;
  let failed = 0;
  for (const batchId of ids) {
    try {
      await enqueue(batchId);
      enqueued += 1;
    } catch {
      // Keep scanning the bounded page. The next tick retries this durable id.
      failed += 1;
    }
  }
  return Object.freeze({ selected: ids.length, enqueued, failed });
}

export function startBatchProcessRecovery(
  _connection: IORedis,
  store: BatchRecoveryStore = defaultRecoveryStore,
  options: Readonly<{ intervalMs?: number; limit?: number; enqueue?: BatchRecoveryEnqueue }> = {},
): Readonly<{ close(): Promise<void> }> {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new RangeError('Invalid recovery interval');
  let stopped = false;
  let running: Promise<void> | null = null;
  const tick = () => {
    if (stopped || running) return;
    const now = new Date().toISOString();
    const limit = options.limit ?? DEFAULT_LIMIT;
    running = Promise.resolve()
      .then(async () => {
        const stale = await store.reconcileStaleProcessing?.(now, 3600, limit);
        const evidence = await store.recoverEvidence?.(now, limit);
        const result = await recoverOwnedBatchesOnce(
          store, options.enqueue ?? ((batchId) => enqueueOwnedBatchWithConnection(_connection, batchId)), limit, now,
        );
        return { ...result, stale: stale?.length ?? 0, evidenceRecovered: evidence?.recovered ?? 0, evidenceUnconfirmed: evidence?.unconfirmed ?? 0 };
      })
      .then((result) => {
        if (result.failed > 0 || result.evidenceUnconfirmed > 0)
          logger.warn(result, 'batch recovery unconfirmed');
        else if (result.enqueued > 0 || result.stale > 0 || result.evidenceRecovered > 0)
          logger.info(result, 'batch recovery progressed');
      })
      .catch((error) => logger.error({ error: error instanceof Error ? error.message : String(error) }, 'batch recovery failed'))
      .finally(() => { running = null; });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return Object.freeze({
    async close() {
      stopped = true;
      clearInterval(timer);
      if (running) await running;
    },
  });
}
