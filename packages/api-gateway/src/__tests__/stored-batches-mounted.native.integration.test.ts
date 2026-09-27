import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guard, owner, runtime, slug, type Runtime } from './stored-chat-mounted.native.fixture';

const enabled = process.env.RUN_NATIVE_DB_INTEGRATION === '1';
if (enabled) guard();

const batch = {
  type: 'chat',
  requests: [
    { custom_id: 'item.1', body: { model: slug, messages: [{ role: 'user', content: 'native batch one' }], max_tokens: 10 } },
    { custom_id: 'item.2', body: { model: slug, messages: [{ role: 'user', content: 'native batch two' }], max_tokens: 10 } },
  ],
};

describe.skipIf(!enabled)('stored batches mounted native acceptance', () => {
  let r: Runtime;

  beforeAll(async () => {
    r = await runtime({
      executionMode: 'stored_chat_embeddings_completions_stream_media_batches' as never,
      providerCompletionTokens: 5,
      providerCachedInputTokens: 0,
      providerText: 'native batch answer',
    });
  }, 30_000);

  afterAll(async () => {
    await r?.close();
  }, 30_000);

  it('commits two durable items and both holds before returning 202', async () => {
    const f = await owner(r, { initialPaygCredits: 100_000 });
    try {
      r.provider.mockClear();
      const response = await r.app.fetch(new Request('http://native.test/v1/batches', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${f.token}`,
          'content-type': 'application/json',
          'idempotency-key': 'native-batch-1',
        },
        body: JSON.stringify(batch),
      }));
      expect(response.status).toBe(202);
      const summary = await response.json() as { batch_id: string; total_count: number; status: string };
      expect(summary).toMatchObject({ total_count: 2, status: 'queued' });
      const facts = await r.other`
        SELECT a.state, a.authorized_max_credits::text AS authorized_max_credits
        FROM gateway_charge_admissions a
        WHERE a.org_id=${f.org}::uuid ORDER BY a.billing_request_id`;
      expect(facts).toHaveLength(2);
      expect(facts.every((row) => row.state === 'held')).toBe(true);
      expect((await r.other`SELECT count(*)::int AS n FROM batch_items bi JOIN batches b ON b.id=bi.batch_id WHERE b.org_id=${f.org}::uuid`)[0]?.n).toBe(2);

      const replay = await r.app.fetch(new Request('http://native.test/v1/batches', {
        method: 'POST',
        headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json', 'idempotency-key': 'native-batch-1' },
        body: JSON.stringify(batch),
      }));
      expect(replay.status).toBe(202);
      expect((await r.other`SELECT count(*)::int AS n FROM gateway_charge_admissions WHERE org_id=${f.org}::uuid`)[0]?.n).toBe(2);

      const { runStoredBatchWorkerStep } = await import('../../../../apps/worker/src/queues/batch-process');
      const { preparePinnedStoredBatchRuntime } = await import('../batch-runtime');
      const step = (item: Parameters<typeof preparePinnedStoredBatchRuntime>[0]) => preparePinnedStoredBatchRuntime(item);
      await expect(runStoredBatchWorkerStep(summary.batch_id, { prepare: step })).resolves.toMatchObject({ kind: 'requeue' });
      await expect(runStoredBatchWorkerStep(summary.batch_id, { prepare: step })).resolves.toMatchObject({ kind: 'terminal' });
      const settled = await r.other`SELECT state, actual_cost_credits::text AS actual_cost_credits FROM gateway_charge_admissions WHERE org_id=${f.org}::uuid ORDER BY billing_request_id`;
      expect(settled).toHaveLength(2);
      expect(settled.every((row) => row.state === 'settled')).toBe(true);
      expect(r.provider).toHaveBeenCalledTimes(2);
      const results = await r.app.fetch(new Request(`http://native.test/v1/batches/${summary.batch_id}/results?cursor=-1&limit=1`, { headers: { authorization: `Bearer ${f.token}` } }));
      expect(results.status).toBe(200);
      expect((await results.json() as { data: unknown[]; next_cursor: number | null }).data).toHaveLength(1);
      await expect(runStoredBatchWorkerStep(summary.batch_id, { prepare: step })).resolves.toMatchObject({ kind: 'idle' });
      expect(r.provider).toHaveBeenCalledTimes(2);
    } finally {
      await f.cleanup();
    }
  });

  it('keeps a foreign organization from reading a batch', async () => {
    const ownerA = await owner(r, { initialPaygCredits: 100_000 });
    const ownerB = await owner(r, { initialPaygCredits: 100_000 });
    try {
      const created = await r.app.fetch(new Request('http://native.test/v1/batches', {
        method: 'POST', headers: { authorization: `Bearer ${ownerA.token}`, 'content-type': 'application/json', 'idempotency-key': 'native-batch-foreign' }, body: JSON.stringify(batch),
      }));
      const id = (await created.json() as { batch_id: string }).batch_id;
      const foreign = await r.app.fetch(new Request(`http://native.test/v1/batches/${id}`, { headers: { authorization: `Bearer ${ownerB.token}` } }));
      expect(foreign.status).toBe(404);
    } finally {
      await ownerB.cleanup();
      await ownerA.cleanup();
    }
  });

  it('recovers a lost settlement ACK from persisted evidence without redispatch', async () => {
    const f = await owner(r, { initialPaygCredits: 100_000 });
    try {
      r.provider.mockClear();
      const response = await r.app.fetch(new Request('http://native.test/v1/batches', {
        method: 'POST', headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json', 'idempotency-key': 'native-batch-ack-loss' },
        body: JSON.stringify(batch),
      }));
      expect(response.status).toBe(202);
      const { batch_id: batchId } = await response.json() as { batch_id: string };
      const { runStoredBatchWorkerStep } = await import('../../../../apps/worker/src/queues/batch-process');
      const { preparePinnedStoredBatchRuntime, executeStoredBatchFinancial } = await import('../batch-runtime');
      let failSettlement = true;
      const prepare = (item: Parameters<typeof preparePinnedStoredBatchRuntime>[0]) => preparePinnedStoredBatchRuntime(item);
      const executeFinancial = (item: Parameters<typeof executeStoredBatchFinancial>[0], prepared: Parameters<typeof executeStoredBatchFinancial>[1]) => executeStoredBatchFinancial(item, prepared, {
        settleAdmittedGatewayCharge: async (args) => {
          const { settleAdmittedGatewayCharge } = await import('../billing/admission');
          const settled = await settleAdmittedGatewayCharge(args);
          if (failSettlement) { failSettlement = false; throw new Error('simulated lost settlement ACK'); }
          return settled;
        },
      });
      await expect(runStoredBatchWorkerStep(batchId, { prepare, executeFinancial })).resolves.toMatchObject({ kind: 'requeue' });
      expect(r.provider).toHaveBeenCalledTimes(1);
      const firstBeforeRecovery = await r.other`
        SELECT a.billing_request_id::text AS billing_request_id,a.state,
          o.payg_credits::text AS payg_credits,
          (SELECT count(*)::int FROM gateway_charge_admission_events e
            WHERE e.admission_id=a.billing_request_id AND e.event_kind='settlement') AS settlement_events,
          (SELECT coalesce(sum(e.used_payg_credits),0)::text FROM gateway_charge_admission_events e
            WHERE e.admission_id=a.billing_request_id AND e.event_kind='settlement') AS used_payg_credits
        FROM batch_items bi JOIN batches b ON b.id=bi.batch_id
          JOIN gateway_charge_admissions a ON a.billing_request_id=bi.billing_request_id
          JOIN organizations o ON o.id=b.org_id
        WHERE b.org_id=${f.org}::uuid AND bi.item_index=0`;
      expect(firstBeforeRecovery).toHaveLength(1);
      expect(firstBeforeRecovery[0]).toMatchObject({state:'settled',settlement_events:1});
      const pending = await r.other`SELECT bi.status, bi.pending_evidence IS NOT NULL AS has_evidence FROM batch_items bi JOIN batches b ON b.id=bi.batch_id WHERE b.org_id=${f.org}::uuid`;
      expect(pending.some((row) => row.status === 'reconciliation_required' && row.has_evidence)).toBe(true);
      const { recoverStoredBatchEvidenceOnce } = await import('../billing/stored-batch-evidence-recovery');
      await expect(recoverStoredBatchEvidenceOnce(new Date().toISOString())).resolves.toMatchObject({ selected: 1, recovered: 1, unconfirmed: 0 });
      const firstAfterRecovery = await r.other`
        SELECT a.billing_request_id::text AS billing_request_id,a.state,
          o.payg_credits::text AS payg_credits,
          (SELECT count(*)::int FROM gateway_charge_admission_events e
            WHERE e.admission_id=a.billing_request_id AND e.event_kind='settlement') AS settlement_events,
          (SELECT coalesce(sum(e.used_payg_credits),0)::text FROM gateway_charge_admission_events e
            WHERE e.admission_id=a.billing_request_id AND e.event_kind='settlement') AS used_payg_credits
        FROM batch_items bi JOIN batches b ON b.id=bi.batch_id
          JOIN gateway_charge_admissions a ON a.billing_request_id=bi.billing_request_id
          JOIN organizations o ON o.id=b.org_id
        WHERE b.org_id=${f.org}::uuid AND bi.item_index=0`;
      expect(firstAfterRecovery).toEqual(firstBeforeRecovery);
      const settled = await r.other`SELECT state FROM gateway_charge_admissions WHERE org_id=${f.org}::uuid`;
      expect(settled.filter((row) => row.state === 'settled')).toHaveLength(1);
      expect((await r.other`SELECT bi.status, bi.pending_evidence FROM batch_items bi JOIN batches b ON b.id=bi.batch_id WHERE b.org_id=${f.org}::uuid ORDER BY bi.item_index`)[0]).toMatchObject({ status: 'completed', pending_evidence: null });
      expect(r.provider).toHaveBeenCalledTimes(1);
      await expect(runStoredBatchWorkerStep(batchId, { prepare, executeFinancial })).resolves.toMatchObject({ kind: 'terminal' });
      expect(r.provider).toHaveBeenCalledTimes(2);
      expect((await r.other`SELECT count(*)::int AS n FROM gateway_charge_admissions WHERE org_id=${f.org}::uuid AND state='settled'`)[0]?.n).toBe(2);
      expect((await r.other`SELECT count(*)::int AS n FROM gateway_charge_admission_events WHERE org_id=${f.org}::uuid AND event_kind='settlement'`)[0]?.n).toBe(2);
      await expect(recoverStoredBatchEvidenceOnce(new Date().toISOString())).resolves.toMatchObject({ selected: 0, recovered: 0, unconfirmed: 0 });
      await expect(runStoredBatchWorkerStep(batchId, { prepare, executeFinancial })).resolves.toMatchObject({ kind: 'idle' });
      expect(r.provider).toHaveBeenCalledTimes(2);
    } finally {
      await f.cleanup();
    }
  });
});
