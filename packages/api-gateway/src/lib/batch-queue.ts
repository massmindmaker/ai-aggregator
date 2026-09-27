import { config } from '../config';

export const BATCH_QUEUE_NAME = 'batch-process';

export type OwnedBatchQueue = Readonly<{
  add(name: string, data: Readonly<{ batchId: string }>, options: Readonly<Record<string, unknown>>): Promise<unknown>;
}>;

type BatchQueue = OwnedBatchQueue & Readonly<{
  close(): Promise<unknown>;
}>;

type BatchQueueJob = Readonly<{
  id: string | undefined;
  data: unknown;
  getState(): Promise<string>;
  retry(state: 'failed' | 'completed'): Promise<void>;
}>;

type BatchQueueProducerDependencies = Readonly<{
  redisUrl: string;
  openQueue: (args: Readonly<{ name: string; connection: Readonly<Record<string, unknown>> }>) => Promise<BatchQueue>;
}>;

const BATCH_ID = /^batch_[0-9a-f]{32}$/;
const LIVE_JOB_STATES = new Set(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children']);

function acknowledgedOwnedJob(value: unknown, jobId: string, batchId: string): BatchQueueJob {
  if (value === null || typeof value !== 'object')
    throw new Error('Batch queue acknowledgement missing');
  const job = value as Partial<BatchQueueJob>;
  const data = job.data;
  if (
    job.id !== jobId ||
    data === null ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    Object.keys(data).length !== 1 ||
    (data as Record<string, unknown>).batchId !== batchId ||
    typeof job.getState !== 'function' ||
    typeof job.retry !== 'function'
  ) throw new Error('Batch queue acknowledgement invalid');
  return job as BatchQueueJob;
}

export async function ensureOwnedBatchJob(queue: OwnedBatchQueue, batchId: string): Promise<void> {
  if (!BATCH_ID.test(batchId)) throw new TypeError('Invalid batch id');
  const jobId = `batch-${batchId}`;
  const acknowledged = acknowledgedOwnedJob(await queue.add('batch', Object.freeze({ batchId }), {
    jobId,
    removeOnComplete: 1000,
    removeOnFail: 1000,
  }), jobId, batchId);
  const state = await acknowledged.getState();
  if (LIVE_JOB_STATES.has(state)) return;
  if (state === 'failed' || state === 'completed') {
    try {
      // BullMQ's reprocessJob Lua command atomically moves the job only
      // from this exact terminal set into wait. This avoids stale removers
      // deleting a replacement created by a concurrent recovery scanner.
      await acknowledged.retry(state);
      return;
    } catch {
      // Another producer may have won the same atomic retry. Accept only
      // after observing that the deterministic job is now live.
      if (LIVE_JOB_STATES.has(await acknowledged.getState())) return;
      throw new Error('Batch queue ownership unavailable');
    }
  }
  throw new Error('Batch queue ownership unavailable');
}

function connectionFromUrl(value: string): Readonly<Record<string, unknown>> {
  const url = new URL(value);
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:')
    throw new TypeError('Invalid Redis URL');
  return Object.freeze({
    host: url.hostname,
    port: Number(url.port) || 6379,
    password: url.password || undefined,
    tls: url.protocol === 'rediss:' ? {} : undefined,
  });
}

async function defaultOpenQueue(args: Readonly<{ name: string; connection: Readonly<Record<string, unknown>> }>): Promise<BatchQueue> {
  const { Queue } = await import('bullmq');
  return new Queue(args.name, { connection: args.connection }) as unknown as BatchQueue;
}

export function createBatchQueueProducer(partial: Partial<BatchQueueProducerDependencies> = {}) {
  const deps: BatchQueueProducerDependencies = {
    redisUrl: config.REDIS_URL,
    openQueue: defaultOpenQueue,
    ...partial,
  };
  return async (batchId: string): Promise<void> => {
    if (!BATCH_ID.test(batchId)) throw new TypeError('Invalid batch id');
    const queue = await deps.openQueue({ name: BATCH_QUEUE_NAME, connection: connectionFromUrl(deps.redisUrl) });
    try {
      await ensureOwnedBatchJob(queue, batchId);
    } finally {
      await queue.close();
    }
  };
}

export const enqueueOwnedBatch = createBatchQueueProducer();
