import { config } from '../config';

export const BATCH_QUEUE_NAME = 'batch-process';

type BatchQueue = Readonly<{
  add(name: string, data: Readonly<{ batchId: string }>, options: Readonly<Record<string, unknown>>): Promise<unknown>;
  close(): Promise<unknown>;
}>;

type BatchQueueProducerDependencies = Readonly<{
  redisUrl: string;
  openQueue: (args: Readonly<{ name: string; connection: Readonly<Record<string, unknown>> }>) => Promise<BatchQueue>;
}>;

const BATCH_ID = /^batch_[0-9a-f]{32}$/;

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
      const acknowledged = await queue.add('batch', Object.freeze({ batchId }), {
        jobId: `batch-${batchId}`,
        removeOnComplete: 1000,
        removeOnFail: 1000,
      });
      if (!acknowledged) throw new Error('Batch queue acknowledgement missing');
    } finally {
      await queue.close();
    }
  };
}

export const enqueueOwnedBatch = createBatchQueueProducer();
