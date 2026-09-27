import { describe, expect, it, vi } from 'vitest';
import { recoverOwnedBatchesOnce, startBatchProcessRecovery, type BatchRecoveryStore } from '../batch-process-recovery';

const queueRetry = vi.fn(async () => undefined);
const queueAdd = vi.fn(async (_name: string, data: { batchId: string }, options: { jobId: string }) => ({
  id: options.jobId, data, getState: async () => 'waiting', retry: queueRetry,
}));
const queueClose = vi.fn(async () => undefined);
vi.mock('bullmq', () => ({
  Queue: vi.fn(() => ({ add: queueAdd, close: queueClose })),
}));

const NOW = '2026-09-27T12:00:00.000Z';
const ids = ['batch_00000000000000000000000000000001', 'batch_00000000000000000000000000000002'] as const;

function store(values: readonly string[] = ids): BatchRecoveryStore {
  return { listRecoverableStoredBatches: vi.fn(async (_now, _limit) => values) };
}

describe('durable batch recovery scanner', () => {
  it('uses a bounded selector and enqueues only owned batch ids', async () => {
    const db = store();
    const enqueue = vi.fn(async (_batchId: string) => undefined);
    const result = await recoverOwnedBatchesOnce(db, enqueue, 7, NOW);
    expect(result).toEqual({ selected: 2, enqueued: 2, failed: 0 });
    expect(db.listRecoverableStoredBatches).toHaveBeenCalledWith(NOW, 7);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls.flat()).toEqual([...ids]);
  });

  it('does not inspect item data and keeps scanning when one enqueue fails', async () => {
    const db = store();
    const enqueue = vi.fn(async (batchId: string) => {
      if (batchId === ids[0]) throw new Error('redis unavailable');
    });
    await expect(recoverOwnedBatchesOnce(db, enqueue, 100, NOW)).resolves.toEqual({ selected: 2, enqueued: 1, failed: 1 });
    expect(enqueue.mock.calls.flat()).toEqual([...ids]);
  });

  it('rejects unbounded or invalid scans', async () => {
    const db = store();
    await expect(recoverOwnedBatchesOnce(db, vi.fn(), 0, NOW)).rejects.toThrow('Invalid recovery limit');
    await expect(recoverOwnedBatchesOnce(db, vi.fn(), 1001, NOW)).rejects.toThrow('Invalid recovery limit');
  });

  it('runs one bounded pass at a time and waits for the in-flight pass on close', async () => {
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    const enqueue = vi.fn(async () => first);
    const db = store([ids[0]]);
    const handle = startBatchProcessRecovery({} as never, db, { intervalMs: 10, enqueue });
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    const closing = handle.close();
    let closed = false;
    void closing.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await closing;
    expect(closed).toBe(true);
  });

  it('uses the supplied Redis connection and deterministic ID-only BullMQ job', async () => {
    queueAdd.mockClear();
    queueClose.mockClear();
    const db = store([ids[0]]);
    const handle = startBatchProcessRecovery({} as never, db, { intervalMs: 60_000 });
    await vi.waitFor(() => expect(queueAdd).toHaveBeenCalledTimes(1));
    expect(queueAdd).toHaveBeenCalledWith('batch', { batchId: ids[0] }, expect.objectContaining({ jobId: `batch-${ids[0]}` }));
    expect(queueAdd.mock.calls[0]?.[1]).toEqual({ batchId: ids[0] });
    await handle.close();
    expect(queueClose).toHaveBeenCalledTimes(1);
  });

  it('reclaims a retained failed job instead of counting a duplicate ACK as recovered', async () => {
    queueAdd.mockReset();
    queueRetry.mockClear();
    queueAdd.mockImplementation(async (_name, data, options) => ({
      id: options.jobId, data, getState: async () => 'failed', retry: queueRetry,
    }));
    const handle = startBatchProcessRecovery({} as never, store([ids[0]]), { intervalMs: 60_000 });
    await vi.waitFor(() => expect(queueAdd).toHaveBeenCalledTimes(1));
    await handle.close();
    expect(queueRetry).toHaveBeenCalledWith('failed');
  });

  it('reconciles stale ownership and persisted evidence before selecting due queued work', async () => {
    const calls: string[] = [];
    const db: BatchRecoveryStore = {
      reconcileStaleProcessing: async (_now, grace, limit) => { calls.push(`stale:${grace}:${limit}`); return []; },
      recoverEvidence: async (_now, limit) => { calls.push(`evidence:${limit}`); return { selected: 0, recovered: 0, unconfirmed: 0 }; },
      listRecoverableStoredBatches: async () => { calls.push('queued'); return [ids[0]]; },
    };
    const handle = startBatchProcessRecovery({} as never, db, {
      intervalMs: 60_000, limit: 7,
      enqueue: async () => { calls.push('enqueue'); },
    });
    await vi.waitFor(() => expect(calls).toContain('enqueue'));
    await handle.close();
    expect(calls).toEqual(['stale:3600:7', 'evidence:7', 'queued', 'enqueue']);
  });
});
