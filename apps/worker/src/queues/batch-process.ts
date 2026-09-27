import { Worker, type Job } from 'bullmq';
import type IORedis from 'ioredis';
import {
  claimNextStoredBatchItem,
  completeStoredBatchItemFromPendingEvidence,
  executeStoredBatchFinancial,
  hasQueuedStoredBatchItems,
  markStoredBatchItemTerminal,
  preparePinnedStoredBatchRuntime,
  releaseStoredBatchItemClaimForRetry,
  refreshStoredBatchAggregate,
  type StoredBatchRuntimePreparation,
  type StoredBatchWorkerItem,
} from '@aiag/api-gateway/batch-runtime';
import { QUEUE_NAMES } from './names.js';

const BATCH_ID = /^batch_[0-9a-f]{32}$/;
const MAX_BATCH_ITEMS = 100;

export type BatchProcessJob = Readonly<{ batchId: string }>;
export type BatchProcessResult = Readonly<{ kind: 'requeue' | 'idle' | 'terminal' | 'deferred' }>;
export type BatchProcessDependencies = Readonly<{
  claim: (batchId: string) => Promise<StoredBatchWorkerItem | null>;
  prepare: (item: StoredBatchWorkerItem) => StoredBatchRuntimePreparation | null;
  executeFinancial: typeof executeStoredBatchFinancial;
  terminal: typeof markStoredBatchItemTerminal;
  completeFromEvidence: typeof completeStoredBatchItemFromPendingEvidence;
  releaseForRetry: typeof releaseStoredBatchItemClaimForRetry;
  refresh: typeof refreshStoredBatchAggregate;
  hasQueued: (batchId: string) => Promise<boolean>;
}>;

const defaults: BatchProcessDependencies = {
  claim: claimNextStoredBatchItem,
  prepare: preparePinnedStoredBatchRuntime,
  executeFinancial: executeStoredBatchFinancial,
  terminal: markStoredBatchItemTerminal,
  completeFromEvidence: completeStoredBatchItemFromPendingEvidence,
  releaseForRetry: releaseStoredBatchItemClaimForRetry,
  refresh: refreshStoredBatchAggregate,
  hasQueued: hasQueuedStoredBatchItems,
};

export function parseBatchProcessJob(value: unknown): BatchProcessJob {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Invalid batch job');
  const fields = Object.keys(value);
  if (fields.length !== 1 || fields[0] !== 'batchId')
    throw new TypeError('Invalid batch job');
  const batchId = (value as Record<string, unknown>).batchId;
  if (typeof batchId !== 'string' || !BATCH_ID.test(batchId))
    throw new TypeError('Invalid batch job');
  return Object.freeze({ batchId });
}

/** One durable item per step. The financial core owns dispatch and settlement. */
export async function runStoredBatchWorkerStep(
  batchId: string,
  partial: Partial<BatchProcessDependencies> = {},
): Promise<BatchProcessResult> {
  if (!BATCH_ID.test(batchId)) throw new TypeError('Invalid batch id');
  const deps = { ...defaults, ...partial };
  const item = await deps.claim(batchId);
  if (!item) return Object.freeze({ kind: 'idle' });
  if (item.batchId !== batchId || item.status !== 'processing')
    throw new Error('Unconfirmed batch item claim');

  let outcome: Awaited<ReturnType<typeof executeStoredBatchFinancial>>;
  try {
    outcome = await deps.executeFinancial(item, deps.prepare(item));
  } catch {
    // A thrown financial step has an unknown dispatch boundary. Keep the hold.
    outcome = Object.freeze({ kind: 'reconciliation_required', errorCode: 'BATCH_EXECUTION_UNCONFIRMED' });
  }

  if (outcome.kind === 'retry_later') {
    await deps.releaseForRetry(item.id, outcome.retryAt);
    await deps.refresh(item.parentId);
    // The durable due marker, rather than this active deterministic job,
    // grants the next retry after the pre-dispatch backoff.
    return Object.freeze({ kind: 'deferred' });
  }
  if (outcome.kind === 'settled_success') {
    // The DB copies exact persisted evidence only after confirming settlement.
    await deps.completeFromEvidence(item.id, outcome.settledAt);
  } else if (outcome.kind === 'cancelled_no_charge') {
    await deps.terminal({ itemId: item.id, status: 'failed', errorCode: outcome.errorCode });
  } else {
    await deps.terminal({ itemId: item.id, status: 'reconciliation_required', errorCode: outcome.errorCode });
  }
  await deps.refresh(item.parentId);
  return Object.freeze({ kind: (await deps.hasQueued(batchId)) ? 'requeue' : 'terminal' });
}

/** One deterministic BullMQ job drains at most the contract's 100 items. */
export async function processBatchJob(
  value: unknown,
  partial: Partial<BatchProcessDependencies> = {},
): Promise<BatchProcessResult> {
  const { batchId } = parseBatchProcessJob(value);
  for (let index = 0; index < MAX_BATCH_ITEMS; index += 1) {
    const result = await runStoredBatchWorkerStep(batchId, partial);
    if (result.kind !== 'requeue') return result;
  }
  throw new Error('Batch item limit exceeded');
}

export function startBatchProcessWorker(
  connection: IORedis,
  partial: Partial<BatchProcessDependencies> = {},
): Worker<BatchProcessJob, BatchProcessResult> {
  return new Worker<BatchProcessJob, BatchProcessResult>(
    QUEUE_NAMES.batchProcess,
    async (job: Job<BatchProcessJob>) => processBatchJob(job.data, partial),
    { connection, concurrency: 1 },
  );
}
