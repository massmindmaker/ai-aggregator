import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  embeddingsOwner, embeddingsRuntime, guardEmbeddingsNative,
  type EmbeddingsOwner, type EmbeddingsRuntime,
} from './stored-embeddings-mounted.native.fixture';

const enabled = process.env.RUN_NATIVE_DB_INTEGRATION === '1';
if (enabled) guardEmbeddingsNative();

describe.skipIf(!enabled)('guarded mounted stored embeddings lifecycle', () => {
  let runtime: EmbeddingsRuntime;
  let owner: EmbeddingsOwner;
  beforeAll(async () => { runtime = await embeddingsRuntime(); }, 30_000);
  beforeEach(async () => { owner = await embeddingsOwner(runtime); runtime.provider.mockClear(); });
  afterEach(async () => { await owner.cleanup(); });
  afterAll(async () => { await runtime?.close(); });

  async function runActualRecovery() {
    const dbModule = await import('../../../../apps/worker/src/queues/gateway-settlement-recovery-db');
    const recovery = await import('../../../../apps/worker/src/queues/gateway-settlement-recovery');
    const db = dbModule.createGatewaySettlementRecoveryDb(process.env.TEST_DATABASE_URL!, {
      allowedRoutes: ['chat', 'embeddings'],
    });
    try { return await recovery.createGatewaySettlementRecoveryLoop(db).runTick(() => false); }
    finally { await db.close(); }
  }

  it('uses the real handler and adapter once, persists exact retail/supplier settlement and replays', async () => {
    const id = crypto.randomUUID();
    const first = await owner.post(id);
    expect(first.status, await first.clone().text()).toBe(200);
    expect(first.headers.get('x-aiag-charged-microcredits')).toBe('3');
    expect(first.headers.get('x-aiag-charged-usd-micro')).toBe('30');
    expect(await first.json()).toEqual(runtime.publicOutput);
    expect(runtime.provider).toHaveBeenCalledOnce();

    const [url, init] = runtime.provider.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/embeddings');
    expect(init).toMatchObject({ method: 'POST', maxRedirects: 0 });
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'openai/text-embedding-3-small', input: ['first private input', 'second private input'],
      encoding_format: 'float',
      provider: { only: ['openai'], allow_fallbacks: false, require_parameters: true },
    });
    expect(JSON.parse(String(init.body))).not.toHaveProperty('dimensions');
    expect(runtime.legacyEmbeddings).not.toHaveBeenCalled();
    expect(runtime.failover).not.toHaveBeenCalled();

    const facts = await owner.facts();
    expect(facts.mapping).toHaveLength(1);
    expect(facts.mapping[0]).toMatchObject({ route_kind: 'embeddings', billing_mode: 'stored' });
    expect(facts.result).toHaveLength(1);
    expect(facts.admission).toHaveLength(1);
    expect(facts.admission[0]).toMatchObject({ state: 'settled', authorized_max_credits: '41', actual_cost_credits: '3' });
    expect(facts.context[0]).toMatchObject({ supplier_authorized_max_usd_micro: '328', supplier_actual_usd_micro: '20' });
    expect(facts.balance[0]?.payg_credits).toBe('997');
    expect(facts.buckets).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'key_month_charged_v2', reserved_amount: '0', settled_amount: '3' }),
      expect.objectContaining({ kind: 'key_session_charged_v2', reserved_amount: '0', settled_amount: '3' }),
      expect.objectContaining({ kind: 'org_day_supplier_v2', reserved_amount: '0', settled_amount: '20' }),
    ]));
    const settled = facts.events.filter((event) => event.event_kind === 'settled');
    expect(settled).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'key_month_charged_v2', released_amount: '38' }),
      expect.objectContaining({ kind: 'key_session_charged_v2', released_amount: '38' }),
      expect.objectContaining({ kind: 'org_day_supplier_v2', released_amount: '308' }),
    ]));
    expect(facts.ledger).toHaveLength(1);

    const replay = await owner.post(id);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(runtime.publicOutput);
    expect(replay.headers.get('x-aiag-charged-microcredits')).toBe('3');
    expect(runtime.provider).toHaveBeenCalledOnce();
    expect((await owner.facts()).ledger).toHaveLength(1);
  });

  it('normalizes scalar/default identity and rejects changed fingerprint without redispatch', async () => {
    const id = crypto.randomUUID();
    expect((await owner.post(id, { model: owner.body.model, input: 'first private input' })).status).toBe(200);
    expect((await owner.post(id, { model: owner.body.model, input: ['first private input'], encoding_format: 'float', dimensions: 1536 })).status).toBe(200);
    const changed = await owner.post(id, { model: owner.body.model, input: ['changed'] });
    expect(changed.status).toBe(409);
    expect(runtime.provider).toHaveBeenCalledOnce();
  });

  it('denies fresh funds before provider dispatch and replays the durable rejection', async () => {
    await runtime.client`UPDATE organizations SET payg_credits=0 WHERE id=${owner.org}::uuid`;
    const id = crypto.randomUUID();
    const first = await owner.post(id);
    expect(first.status).toBe(402);
    expect(runtime.provider).not.toHaveBeenCalled();
    const second = await owner.post(id);
    expect(second.status).toBe(402);
    expect(runtime.provider).not.toHaveBeenCalled();
    expect((await owner.facts()).rejection).toHaveLength(1);
  });

  it('requires fresh auth even for a successful persisted replay', async () => {
    const id = crypto.randomUUID();
    expect((await owner.post(id)).status).toBe(200);
    await runtime.client`UPDATE gateway_api_keys SET revoked_at=clock_timestamp() WHERE id=${owner.key}::uuid`;
    expect((await owner.post(id)).status).toBe(401);
    expect(runtime.provider).toHaveBeenCalledOnce();
  });

  it('recovery: actual worker settles durable embeddings outcome once after revoke and preserves an expired tombstone', async () => {
    const settle = vi.spyOn(runtime.admission, 'settleAdmittedGatewayCharge').mockRejectedValue(new Error('forced settle unavailable'));
    const id = crypto.randomUUID();
    try { expect((await owner.post(id)).status).toBe(503); }
    finally { settle.mockRestore(); }
    expect(runtime.provider).toHaveBeenCalledOnce();
    let facts = await owner.facts();
    expect(facts.admission[0]).toMatchObject({ state: 'outcome_recorded', authorized_max_credits: '41', actual_cost_credits: '3' });
    expect(facts.context[0]).toMatchObject({ supplier_authorized_max_usd_micro: '328', supplier_actual_usd_micro: '20' });
    const billing = String(facts.admission[0]!.billing_request_id);

    await runtime.client`WITH original AS (
      DELETE FROM gateway_http_results WHERE billing_request_id=${billing}::uuid AND org_id=${owner.org}::uuid RETURNING *
    ) INSERT INTO gateway_http_results(billing_request_id,org_id,api_key_id,contract_version,http_status,content_type,response_body,response_digest,stored_at,expires_at)
      SELECT billing_request_id,org_id,api_key_id,contract_version,http_status,content_type,response_body,response_digest,t.at-INTERVAL '168 hours',t.at
      FROM original CROSS JOIN (SELECT clock_timestamp() AS at) t`;
    expect(await runtime.storage.expireGatewayHttpResult({ orgId: owner.org, billingRequestId: billing }, runtime.client)).toBe(true);
    await runtime.client`UPDATE gateway_api_keys SET revoked_at=clock_timestamp() WHERE id=${owner.key}::uuid`;

    expect(await runActualRecovery()).toMatchObject({ selected: 1, attempted: 1, settled: 1, unconfirmed: 0 });
    facts = await owner.facts();
    expect(facts.admission[0]?.state).toBe('settled');
    expect(facts.balance[0]?.payg_credits).toBe('997');
    expect(facts.ledger).toHaveLength(1);
    expect(facts.result[0]?.response_body).toBeNull();
    expect(facts.buckets).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'key_month_charged_v2', reserved_amount: '0', settled_amount: '3' }),
      expect.objectContaining({ kind: 'key_session_charged_v2', reserved_amount: '0', settled_amount: '3' }),
      expect.objectContaining({ kind: 'org_day_supplier_v2', reserved_amount: '0', settled_amount: '20' }),
    ]));
    expect(await runActualRecovery()).toMatchObject({ selected: 0, attempted: 0, settled: 0 });
    expect(await runActualRecovery()).toMatchObject({ selected: 0, attempted: 0, settled: 0 });
    expect((await owner.facts()).ledger).toHaveLength(1);

    expect((await owner.post(id)).status).toBe(401);
    await runtime.client`UPDATE gateway_api_keys SET revoked_at=NULL WHERE id=${owner.key}::uuid`;
    const tombstone = await owner.post(id);
    expect(tombstone.status).toBe(410);
    expect(runtime.provider).toHaveBeenCalledOnce();
  });

  it('recovery: malformed provider usage leaves dispatched hold and actual worker skips it', async () => {
    runtime.provider.mockImplementationOnce(async () => new Response(JSON.stringify({
      ...runtime.output,
      usage: { prompt_tokens: 1000, total_tokens: 999 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const response = await owner.post();
    expect(response.status).toBe(503);
    expect(runtime.provider).toHaveBeenCalledOnce();
    const before = await owner.facts();
    expect(before.admission[0]).toMatchObject({ state: 'dispatched', authorized_max_credits: '41', actual_cost_credits: null });
    expect(before.result).toHaveLength(0);
    expect(before.balance[0]?.payg_credits).toBe('959');
    expect(await runActualRecovery()).toMatchObject({ selected: 0, attempted: 0, settled: 0 });
    const after = await owner.facts();
    expect(after).toEqual(before);
    expect(runtime.provider).toHaveBeenCalledOnce();
  });
});
