import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { guard, owner, runtime, type Owner, type Runtime, slug } from './stored-completions-mounted.native.fixture';

const enabled = process.env.RUN_NATIVE_DB_INTEGRATION === '1';
if (enabled) guard();

async function waitFor(check: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

describe.skipIf(!enabled)('mounted stored completions native lifecycle', () => {
  let r: Runtime;
  let f: Owner;

  beforeAll(async () => {
    r = await runtime();
    f = await owner(r);
  });
  afterAll(async () => {
    const failures: unknown[] = [];
    try { await f?.cleanup(); } catch (error) { failures.push(error); }
    try { await r?.close(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'stored completions cleanup failed');
  });

  async function runActualRecovery() {
    const dbModule = await import('../../../../apps/worker/src/queues/gateway-settlement-recovery-db');
    const recovery = await import('../../../../apps/worker/src/queues/gateway-settlement-recovery');
    const db = dbModule.createGatewaySettlementRecoveryDb(process.env.TEST_DATABASE_URL!, {
      allowedRoutes: ['chat', 'embeddings', 'completions'],
    });
    try {
      return await recovery.createGatewaySettlementRecoveryLoop(db).runTick(() => false);
    } finally {
      await db.close();
    }
  }

  it('mounts the exact text DTO and settles the frozen synthetic quote once across replay', async () => {
    const id = randomUUID();
    const fresh = await f.post(id);
    expect(fresh.status, await fresh.clone().text()).toBe(200);
    expect(await fresh.clone().json()).toEqual({
      id: 'cmpl-native',
      object: 'text_completion',
      created: 1,
      model: slug,
      choices: [{ text: 'native completion text', index: 0, logprobs: null, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
    });
    expect(fresh.headers.get('x-aiag-charged-microcredits')).toBe('3');
    expect(fresh.headers.get('x-aiag-charged-usd-micro')).toBe('30');
    expect(r.provider).toHaveBeenCalledTimes(1);

    const replay = await f.post(id, { model: slug, prompt: 'private native completion prompt', max_tokens: 10, stream: false });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(await fresh.json());
    expect(r.provider).toHaveBeenCalledTimes(1);

    const conflict = await f.post(id, { model: slug, prompt: 'changed prompt', max_tokens: 10 });
    expect(conflict.status).toBe(409);
    expect(r.provider).toHaveBeenCalledTimes(1);
    await r.client`UPDATE gateway_api_keys SET revoked_at=clock_timestamp() WHERE id=${f.key}::uuid`;
    expect((await f.post(id)).status).toBe(401);
    await r.client`UPDATE gateway_api_keys SET revoked_at=NULL WHERE id=${f.key}::uuid`;

    const facts = await f.facts();
    expect(facts.mapping).toHaveLength(1);
    expect(facts.result).toHaveLength(1);
    expect(facts.admission).toHaveLength(1);
    expect(facts.ledger).toHaveLength(1);
    expect(facts.admission[0]).toMatchObject({
      route_kind: 'completions',
      state: 'settled',
      authorized_max_credits: '3457',
      actual_cost_credits: '3',
      released_payg_credits: '3454',
    });
    expect(facts.context[0]).toMatchObject({
      supplier_authorized_max_usd_micro: '19205',
      supplier_actual_usd_micro: '18',
    });
    expect(
      BigInt(facts.context[0]!.supplier_authorized_max_usd_micro as string) -
        BigInt(facts.context[0]!.supplier_actual_usd_micro as string),
    ).toBe(19_187n);
    expect(facts.balance[0]?.payg_credits).toBe('9997');
  });

  it('persists a fresh funds denial and replays it without provider dispatch', async () => {
    const id = randomUUID();
    const before = r.provider.mock.calls.length;
    await r.client`UPDATE organizations SET payg_credits=0 WHERE id=${f.org}::uuid`;
    const denied = await f.post(id);
    expect(denied.status).toBe(402);
    await r.client`UPDATE organizations SET payg_credits=9997 WHERE id=${f.org}::uuid`;
    expect((await f.post(id)).status).toBe(402);
    expect(r.provider).toHaveBeenCalledTimes(before);
  });

  it('keeps malformed post-dispatch usage held unknown with no stored success', async () => {
    const before = await f.facts();
    r.provider.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'cmpl-invalid', object: 'chat.completion', created: 1, model: slug,
      choices: [{ index: 0, message: { role: 'assistant', content: 'invalid' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 11, total_tokens: 111 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    expect((await f.post(randomUUID())).status).toBe(503);
    const after = await f.facts();
    expect(after.admission).toHaveLength(before.admission.length + 1);
    expect(after.result).toHaveLength(before.result.length);
    const priorBillingIds = new Set(before.admission.map((row) => String(row.billing_request_id)));
    const created = after.admission.filter((row) => !priorBillingIds.has(String(row.billing_request_id)));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ route_kind: 'completions', state: 'dispatched' });
  });

  it('mounts the trailing slash as the same durable completions identity', async () => {
    const id = randomUUID();
    const before = r.provider.mock.calls.length;
    const trailing = await r.app.fetch(new Request('http://native.test/v1/completions/', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${f.token}`,
        'content-type': 'application/json',
        'idempotency-key': id,
      },
      body: JSON.stringify(f.body),
    }));
    expect(trailing.status).toBe(200);
    expect((await f.post(id)).status).toBe(200);
    expect(r.provider).toHaveBeenCalledTimes(before + 1);
  });

  it('keeps the same idempotency key independent between completions and chat routes', async () => {
    const id = randomUUID();
    const before = r.provider.mock.calls.length;
    const completion = await f.post(id);
    const chat = await r.app.fetch(new Request('http://native.test/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${f.token}`,
        'content-type': 'application/json',
        'idempotency-key': id,
      },
      body: JSON.stringify({
        model: slug,
        messages: [{ role: 'user', content: 'private native completion prompt' }],
        max_tokens: 10,
      }),
    }));
    expect(completion.status).toBe(200);
    expect(chat.status).toBe(200);
    expect((await completion.json() as { object: string }).object).toBe('text_completion');
    expect((await chat.json() as { object: string }).object).toBe('chat.completion');
    expect(r.provider).toHaveBeenCalledTimes(before + 2);
  });

  it('recovery: actual new-mode worker settles durable text once after revoke/expiry and skips malformed held usage', async () => {
    const recoveryOwner = await owner(r);
    const malformedOwner = await owner(r);
    try {
      r.provider.mockClear();
      const settle = vi.spyOn(r.admission, 'settleAdmittedGatewayCharge').mockRejectedValue(
        new Error('forced settle unavailable'),
      );
      const id = randomUUID();
      try {
        expect((await recoveryOwner.post(id)).status).toBe(503);
      } finally {
        settle.mockRestore();
      }
      expect(r.provider).toHaveBeenCalledOnce();
      let facts = await recoveryOwner.facts();
      expect(facts.admission[0]).toMatchObject({
        route_kind: 'completions',
        state: 'outcome_recorded',
        authorized_max_credits: '3457',
        actual_cost_credits: '3',
      });
      expect(facts.context[0]).toMatchObject({
        supplier_authorized_max_usd_micro: '19205',
        supplier_actual_usd_micro: '18',
      });
      const billing = String(facts.admission[0]!.billing_request_id);

      await r.client`WITH original AS (
        DELETE FROM gateway_http_results
         WHERE billing_request_id=${billing}::uuid AND org_id=${recoveryOwner.org}::uuid
         RETURNING *
      ) INSERT INTO gateway_http_results(
        billing_request_id,org_id,api_key_id,contract_version,http_status,
        content_type,response_body,response_digest,stored_at,expires_at
      ) SELECT billing_request_id,org_id,api_key_id,contract_version,http_status,
               content_type,response_body,response_digest,t.at-INTERVAL '168 hours',t.at
          FROM original CROSS JOIN (SELECT clock_timestamp() AS at) t`;
      expect(await r.storage.expireGatewayHttpResult(
        { orgId: recoveryOwner.org, billingRequestId: billing },
        r.client,
      )).toBe(true);
      await r.client`UPDATE gateway_api_keys SET revoked_at=clock_timestamp() WHERE id=${recoveryOwner.key}::uuid`;

      expect(await runActualRecovery()).toMatchObject({
        selected: 1, attempted: 1, settled: 1, unconfirmed: 0,
      });
      facts = await recoveryOwner.facts();
      expect(facts.admission[0]).toMatchObject({
        state: 'settled',
        released_payg_credits: '3454',
      });
      expect(facts.balance[0]?.payg_credits).toBe('9997');
      expect(facts.ledger).toHaveLength(1);
      expect(facts.result[0]?.response_body).toBeNull();
      expect(await runActualRecovery()).toMatchObject({ selected: 0, attempted: 0, settled: 0 });
      expect((await recoveryOwner.facts()).ledger).toHaveLength(1);
      expect(r.provider).toHaveBeenCalledOnce();
      expect((await recoveryOwner.post(id)).status).toBe(401);
      await r.client`UPDATE gateway_api_keys SET revoked_at=NULL WHERE id=${recoveryOwner.key}::uuid`;
      expect((await recoveryOwner.post(id)).status).toBe(410);
      expect(r.provider).toHaveBeenCalledOnce();

      r.provider.mockClear();
      r.provider.mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'cmpl-invalid-recovery', object: 'chat.completion', created: 1, model: slug,
        choices: [{ index: 0, message: { role: 'assistant', content: 'invalid' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 11, total_tokens: 111 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
      expect((await malformedOwner.post()).status).toBe(503);
      expect(r.provider).toHaveBeenCalledOnce();
      const before = await malformedOwner.facts();
      expect(before.admission[0]).toMatchObject({
        route_kind: 'completions', state: 'dispatched',
        authorized_max_credits: '3457', actual_cost_credits: null,
      });
      expect(before.result).toHaveLength(0);
      expect(before.balance[0]?.payg_credits).toBe('6543');
      expect(await runActualRecovery()).toMatchObject({ selected: 0, attempted: 0, settled: 0 });
      expect(await malformedOwner.facts()).toEqual(before);
      expect(r.provider).toHaveBeenCalledOnce();
    } finally {
      await Promise.allSettled([recoveryOwner.cleanup(), malformedOwner.cleanup()]).then((results) => {
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason), 'recovery owner cleanup failed');
      });
    }
  });

  it('concurrent fresh same-key requests have one winner and a new app instance replays the persisted text result', async () => {
    const concurrentOwner = await owner(r);
    let releaseLock!: () => void;
    let lockReady!: () => void;
    let releaseReads!: () => void;
    let bothReads!: () => void;
    const lockGate = new Promise<void>((resolve) => { releaseLock = resolve; });
    const locked = new Promise<void>((resolve) => { lockReady = resolve; });
    const readGate = new Promise<void>((resolve) => { releaseReads = resolve; });
    const readsReady = new Promise<void>((resolve) => { bothReads = resolve; });
    const held = r.client.begin(async (tx) => {
      await tx`LOCK TABLE gateway_http_requests IN SHARE ROW EXCLUSIVE MODE`;
      lockReady();
      await lockGate;
    });
    const heldDone = Promise.allSettled([held]);
    let requestResults: PromiseSettledResult<Response>[] = [];
    let requestDone: Promise<PromiseSettledResult<Response>[]> = Promise.resolve([]);
    let readSpy: { mockRestore(): void } | undefined;
    const failures: unknown[] = [];
    try {
      await Promise.race([
        locked,
        heldDone.then(([result]) => {
          if (result?.status === 'rejected') throw result.reason;
          throw new Error('claim lock finished before readiness');
        }),
      ]);
      r.provider.mockClear();
      let reads = 0;
      const actualRead = r.terminal.readGatewayHttpResultV2;
      readSpy = vi.spyOn(r.terminal, 'readGatewayHttpResultV2').mockImplementation(async (scope) => {
        const value = await actualRead(scope);
        if (value.status === 'not_found') {
          reads += 1;
          if (reads === 2) bothReads();
          await readGate;
        }
        return value;
      });
      const id = randomUUID();
      requestDone = Promise.allSettled([concurrentOwner.post(id), concurrentOwner.post(id)]);
      await readsReady;
      releaseReads();
      await waitFor(async () => Number((await r.other`
        SELECT count(*)::int AS n
          FROM pg_stat_activity
         WHERE wait_event_type='Lock'
           AND query LIKE '%aiag_claim_gateway_http_request_v1%'
      `)[0]?.n) >= 2, 'two completions claim waits were not observed');
      releaseLock();
      for (const result of await heldDone)
        if (result.status === 'rejected') failures.push(result.reason);
      requestResults = await requestDone;
      for (const result of requestResults)
        if (result.status === 'rejected') failures.push(result.reason);
      if (failures.length) throw new AggregateError(failures, 'concurrent completions requests failed');
      for (const result of requestResults) {
        if (result.status !== 'fulfilled') throw result.reason;
        expect([200, 202]).toContain(result.value.status);
      }
      const replay = await concurrentOwner.post(id);
      expect(replay.status).toBe(200);
      expect(await replay.clone().json()).toEqual({
        id: 'cmpl-native', object: 'text_completion', created: 1, model: slug,
        choices: [{ text: 'native completion text', index: 0, logprobs: null, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
      });
      expect(replay.headers.get('x-aiag-charged-microcredits')).toBe('3');
      expect(replay.headers.get('x-aiag-charged-usd-micro')).toBe('30');
      expect(r.provider).toHaveBeenCalledOnce();
      let facts = await concurrentOwner.facts();
      expect(facts.mapping).toHaveLength(1);
      expect(facts.admission).toHaveLength(1);
      expect(facts.ledger).toHaveLength(1);
      expect(facts.context[0]).toMatchObject({
        supplier_authorized_max_usd_micro: '19205', supplier_actual_usd_micro: '18',
      });

      const child = `
        import {assertTestDatabaseEnvironment,withGuardedTestDatabase} from './packages/database/scripts/test-db-guard.ts';
        import {createPgTestClient} from './packages/database/scripts/pg-test-client.ts';
        assertTestDatabaseEnvironment(process.env);
        await withGuardedTestDatabase(process.env,{clientFactory:createPgTestClient},async()=>{});
        globalThis.fetch=async()=>{throw new Error('new app replay attempted provider/network');};
        const {app}=await import('./packages/api-gateway/src/server.ts');
        try {
          const response=await app.fetch(new Request('http://native.test/v1/completions',{
            method:'POST',headers:{authorization:'Bearer '+process.env.REPLAY_TOKEN,'content-type':'application/json','idempotency-key':process.env.REPLAY_ID},
            body:process.env.REPLAY_BODY,
          }));
          const body=await response.json();
          if(response.status!==200||body.object!=='text_completion'||body.choices?.[0]?.text!=='native completion text')throw new Error('new app replay body mismatch');
          if(response.headers.get('x-aiag-charged-microcredits')!=='3'||response.headers.get('x-aiag-charged-usd-micro')!=='30')throw new Error('new app replay receipt mismatch');
        } finally {
          await (await import('./packages/api-gateway/src/lib/db.ts')).sql.end();
          const redis=await import('./packages/api-gateway/src/lib/redis.ts');
          await redis.redis.quit();await redis.makeRedis('ratelimit').quit();
        }
        console.log('new app completion replay verified');
      `;
      expect(execFileSync('bun', ['-e', child], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          REPLAY_TOKEN: concurrentOwner.token,
          REPLAY_ID: id,
          REPLAY_BODY: JSON.stringify(concurrentOwner.body),
        },
        encoding: 'utf8',
        timeout: 20_000,
      })).toContain('new app completion replay verified');
      facts = await concurrentOwner.facts();
      expect(facts.ledger).toHaveLength(1);
      expect(r.provider).toHaveBeenCalledOnce();
    } catch (error) {
      failures.push(error);
      throw error;
    } finally {
      releaseReads?.();
      releaseLock?.();
      await heldDone;
      await requestDone;
      readSpy?.mockRestore();
      await concurrentOwner.cleanup();
    }
  }, 30_000);

  it('rejects arrays and unknown fields before provider/admission', async () => {
    const before = r.provider.mock.calls.length;
    for (const body of [
      { model: slug, prompt: ['one'] },
      { model: slug, prompt: [1, 2] },
      { model: slug, prompt: 'p', temperature: 0 },
    ]) {
      const response = await f.post(randomUUID(), body);
      expect(response.status).toBe(400);
    }
    expect(r.provider).toHaveBeenCalledTimes(before);
  });
});
