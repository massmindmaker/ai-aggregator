import { describe, expect, it, vi } from 'vitest';
import { recoverStoredBatchEvidenceOnce } from '../stored-batch-evidence-recovery';

const attemptId = '00000000-0000-4000-8000-000000000004';
const pricingSnapshot = { profileId: 'reviewed-v1' };
const admission = { billingRequestId: '00000000-0000-4000-8000-000000000001', state: 'dispatched', attemptId, upstreamId: 'openrouter', pricingSnapshot, actualCostCredits: null, usageSnapshot: null, outcomeKind: null } as any;
const item = { billingRequestId: admission.billingRequestId, attemptId, upstreamId: 'openrouter', pricingSnapshot, status: 'reconciliation_required', admission } as any;
const evidence = { output: { id: 'o' }, usageSnapshot: { total: 2 }, actualCostCredits: 3n, resultDigest: 'a'.repeat(64) };
const candidate = { itemId: '00000000-0000-4000-8000-000000000002', parentId: '00000000-0000-4000-8000-000000000003', batchId: 'batch_00000000000000000000000000000001', billingRequestId: admission.billingRequestId, admissionState: 'dispatched', evidence } as any;

describe('stored batch evidence recovery', () => {
  it('records, settles and completes persisted evidence without provider work', async () => {
    const record = vi.fn(async () => ({ ...admission, state: 'outcome_recorded', actualCostCredits: 3n, usageSnapshot: evidence.usageSnapshot, outcomeKind: 'success' }));
    const settle = vi.fn(async () => ({ ...admission, state: 'settled', actualCostCredits: 3n, usageSnapshot: evidence.usageSnapshot, outcomeKind: 'success', settledAt: '2026-09-27T12:00:00.000000Z' }));
    const complete = vi.fn(async () => undefined);
    const hasQueued = vi.fn(async () => true);
    const markRecovery = vi.fn(async () => undefined);
    await expect(recoverStoredBatchEvidenceOnce('2026-09-27T12:00:00.000000Z', 10, { list: async () => [candidate], load: async () => item, record, settle, complete, refresh: async () => undefined, hasQueued, markRecovery })).resolves.toEqual({ selected: 1, recovered: 1, unconfirmed: 0 });
    expect(record).toHaveBeenCalledOnce(); expect(settle).toHaveBeenCalledOnce(); expect(complete).toHaveBeenCalledOnce();
    expect(hasQueued).toHaveBeenCalledWith(candidate.batchId);
    expect(markRecovery).toHaveBeenCalledWith(candidate.batchId, '2026-09-27T12:00:00.000000Z');
  });

  it('fails closed for missing evidence and never calls admission APIs', async () => {
    const record = vi.fn(); const settle = vi.fn();
    await expect(recoverStoredBatchEvidenceOnce('2026-09-27T12:00:00.000000Z', 10, { list: async () => [{ ...candidate, evidence: null }], load: async () => item, record: record as any, settle: settle as any })).resolves.toEqual({ selected: 1, recovered: 0, unconfirmed: 1 });
    expect(record).not.toHaveBeenCalled(); expect(settle).not.toHaveBeenCalled();
  });

  it.each(['outcome_recorded','settled'] as const)('recovers an already %s admission without another provider call', async (state) => {
    const recorded = { ...admission, state, actualCostCredits: 3n, usageSnapshot: evidence.usageSnapshot, outcomeKind: 'success', settledAt: state === 'settled' ? '2026-09-27T12:00:00.000000Z' : null };
    const record = vi.fn();
    const settle = vi.fn(async () => ({ ...recorded, state: 'settled', settledAt: '2026-09-27T12:00:00.000000Z' }));
    const complete = vi.fn(async () => undefined);
    const result = await recoverStoredBatchEvidenceOnce('2026-09-27T12:00:00.000000Z', 10, {
      list: async () => [{ ...candidate, admissionState: state }],
      load: async () => ({ ...item, admission: recorded }),
      record: record as any, settle: settle as any, complete,
      refresh: async () => undefined, hasQueued: async () => false,
    });
    expect(result).toEqual({ selected: 1, recovered: 1, unconfirmed: 0 });
    expect(record).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledTimes(state === 'settled' ? 0 : 1);
    expect(complete).toHaveBeenCalledWith(candidate.itemId, '2026-09-27T12:00:00.000000Z');
  });

  it('refuses settlement evidence with a different usage snapshot', async () => {
    const recorded = { ...admission, state: 'outcome_recorded', actualCostCredits: 3n, usageSnapshot: evidence.usageSnapshot, outcomeKind: 'success' };
    const complete = vi.fn();
    const result = await recoverStoredBatchEvidenceOnce('2026-09-27T12:00:00.000000Z', 10, {
      list: async () => [{ ...candidate, admissionState: 'outcome_recorded' }],
      load: async () => ({ ...item, admission: recorded }),
      settle: async () => ({ ...recorded, state: 'settled', usageSnapshot: { total: 99 }, settledAt: '2026-09-27T12:00:00.000000Z' }) as any,
      complete: complete as any,
    });
    expect(result).toEqual({ selected: 1, recovered: 0, unconfirmed: 1 });
    expect(complete).not.toHaveBeenCalled();
  });
});
