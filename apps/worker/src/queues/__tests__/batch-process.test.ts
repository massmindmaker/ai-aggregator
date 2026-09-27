import { describe, expect, it, vi } from 'vitest';
import type { StoredBatchWorkerItem } from '@aiag/api-gateway/batch-runtime';
import {
  parseBatchProcessJob,
  processBatchJob,
  runStoredBatchWorkerStep,
  type BatchProcessDependencies,
} from '../batch-process';

const batchId = 'batch_00000000000000000000000000000001';
const item = Object.freeze({
  id: '00000000-0000-4000-8000-000000000001',
  parentId: '00000000-0000-4000-8000-000000000002',
  batchId,
  status: 'processing',
}) as StoredBatchWorkerItem;

function fixture(outcome: Awaited<ReturnType<BatchProcessDependencies['executeFinancial']>>) {
  const claim = vi.fn(async () => item);
  const executeFinancial = vi.fn(async () => outcome);
  const terminal = vi.fn(async () => undefined);
  const completeFromEvidence = vi.fn(async () => undefined);
  const releaseForRetry = vi.fn(async () => undefined);
  const refresh = vi.fn(async () => undefined);
  const hasQueued = vi.fn(async () => false);
  const deps = {
    claim,
    prepare: () => null,
    executeFinancial,
    terminal,
    completeFromEvidence,
    releaseForRetry,
    refresh,
    hasQueued,
  } as Partial<BatchProcessDependencies>;
  return { deps, claim, executeFinancial, terminal, completeFromEvidence, releaseForRetry, refresh, hasQueued };
}

describe('batch process lifecycle', () => {
  it('accepts only an ID-only queue payload', () => {
    expect(parseBatchProcessJob({ batchId })).toEqual({ batchId });
    expect(() => parseBatchProcessJob({ batchId, orgId: 'foreign' })).toThrow('Invalid batch job');
    expect(() => parseBatchProcessJob({ batchId: 'batch_bad' })).toThrow('Invalid batch job');
  });

  it('persists settled output and the financial core exact digest/timestamp', async () => {
    const output = { id: 'completion-1', object: 'chat.completion' };
    const resultDigest = 'a'.repeat(64);
    const settledAt = '2026-09-27T12:00:00.123456Z';
    const f = fixture({ kind: 'settled_success', output, resultDigest, settledAt });
    await expect(runStoredBatchWorkerStep(batchId, f.deps)).resolves.toEqual({ kind: 'terminal' });
    expect(f.executeFinancial).toHaveBeenCalledOnce();
    expect(f.completeFromEvidence).toHaveBeenCalledWith(item.id, settledAt);
    expect(f.terminal).not.toHaveBeenCalled();
    expect(f.refresh).toHaveBeenCalledWith(item.parentId);
  });

  it('marks confirmed pre-dispatch cancellation failed without charging', async () => {
    const f = fixture({ kind: 'cancelled_no_charge', errorCode: 'BATCH_ITEM_EXPIRED' });
    await runStoredBatchWorkerStep(batchId, f.deps);
    expect(f.terminal).toHaveBeenCalledWith({
      itemId: item.id, status: 'failed', errorCode: 'BATCH_ITEM_EXPIRED',
    });
  });

  it('releases a temporary pre-dispatch failure for scanner retry without terminalizing', async () => {
    const retryAt = '2026-09-27T12:00:05.000Z';
    const f = fixture({ kind: 'retry_later', retryAt });
    await expect(runStoredBatchWorkerStep(batchId, f.deps)).resolves.toEqual({ kind: 'deferred' });
    expect(f.releaseForRetry).toHaveBeenCalledWith(item.id, retryAt);
    expect(f.terminal).not.toHaveBeenCalled();
    expect(f.hasQueued).not.toHaveBeenCalled();
  });

  it('persists uncertain dispatch as reconciliation and never reports success', async () => {
    const f = fixture({ kind: 'reconciliation_required', errorCode: 'DISPATCH_REPLAY' });
    await runStoredBatchWorkerStep(batchId, f.deps);
    expect(f.terminal).toHaveBeenCalledWith({
      itemId: item.id, status: 'reconciliation_required', errorCode: 'DISPATCH_REPLAY',
    });
  });

  it('does not call financial execution for an unclaimed or mismatched item', async () => {
    const f = fixture({ kind: 'reconciliation_required', errorCode: 'UNUSED' });
    await expect(runStoredBatchWorkerStep(batchId, {
      ...f.deps, claim: async () => null,
    })).resolves.toEqual({ kind: 'idle' });
    expect(f.executeFinancial).not.toHaveBeenCalled();
    await expect(runStoredBatchWorkerStep(batchId, {
      ...f.deps, claim: async () => ({ ...item, batchId: 'batch_ffffffffffffffffffffffffffffffff' }),
    })).rejects.toThrow('Unconfirmed batch item claim');
  });

  it('drains remaining queued items within one deterministic job', async () => {
    const f = fixture({ kind: 'cancelled_no_charge', errorCode: 'BATCH_ITEM_EXPIRED' });
    let count = 0;
    await expect(processBatchJob({ batchId }, {
      ...f.deps,
      claim: async () => { count += 1; return item; },
      hasQueued: async () => count < 3,
    })).resolves.toEqual({ kind: 'terminal' });
    expect(count).toBe(3);
    expect(f.executeFinancial).toHaveBeenCalledTimes(3);
  });

  it('surfaces terminal persistence failures instead of acknowledging the job', async () => {
    const f = fixture({ kind: 'reconciliation_required', errorCode: 'UNKNOWN' });
    await expect(runStoredBatchWorkerStep(batchId, {
      ...f.deps, terminal: async () => { throw new Error('DB unavailable'); },
    })).rejects.toThrow('DB unavailable');
    expect(f.refresh).not.toHaveBeenCalled();
  });
});
