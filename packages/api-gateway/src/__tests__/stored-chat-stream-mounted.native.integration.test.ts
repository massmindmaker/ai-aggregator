import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { guard, owner, runtime, slug, type Runtime } from './stored-chat-mounted.native.fixture';

const enabled = process.env.RUN_NATIVE_DB_INTEGRATION === '1';
if (enabled) guard();

function streamBody(prompt: string) {
  return { model: slug, messages: [{ role: 'user', content: prompt }], max_tokens: 10, stream: true };
}
function parseSse(text: string) {
  const payloads = text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6));
  return { payloads, events: payloads.filter((value) => value !== '[DONE]').map((value) => JSON.parse(value)) };
}
async function waitFor(check: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

describe.skipIf(!enabled)('stored chat stream mounted native lifecycle', () => {
  let r: Runtime;
  beforeAll(async () => { r = await runtime({ executionMode: 'stored_chat_embeddings_completions_stream', providerCompletionTokens: 5, providerCachedInputTokens: 0 }); });
  afterAll(async () => { await r?.close(); });

  async function runActualRecovery() {
    const dbModule = await import('../../../../apps/worker/src/queues/gateway-settlement-recovery-db');
    const recovery = await import('../../../../apps/worker/src/queues/gateway-settlement-recovery');
    const db = dbModule.createGatewaySettlementRecoveryDb(process.env.TEST_DATABASE_URL!, {
      allowedRoutes: ['chat', 'embeddings', 'completions'],
      allowedContractVersions: [1, 2],
    });
    try { return await recovery.createGatewaySettlementRecoveryLoop(db).runTick(() => false); }
    finally { await db.close(); }
  }

  it('streams normalized events, settles exact money, and replays stored SSE once', async () => {
    const f = await owner(r, { body: streamBody('native stream'), initialPaygCredits: 10_000 });
    try {
      r.provider.mockClear();
      const id = randomUUID();
      const fresh = await f.post(id);
      expect(fresh.status).toBe(200);
      expect(fresh.headers.get('content-type')).toContain('text/event-stream');
      expect(fresh.headers.get('x-aiag-charged-microcredits')).toBeNull();
      const freshText = await fresh.text();
      const parsed = parseSse(freshText);
      expect(parsed.payloads.at(-1)).toBe('[DONE]');
      expect(parsed.events).toHaveLength(4);
      expect(parsed.events[1].choices[0].delta.content).toBe('native private completion');
      expect(parsed.events.at(-1)).toMatchObject({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, cached_input_tokens: 0 } });
      expect(r.provider).toHaveBeenCalledTimes(1);

      const facts = await f.facts();
      expect(facts.mapping).toHaveLength(1);
      expect(facts.result).toHaveLength(1);
      expect(facts.admission).toHaveLength(1);
      expect(facts.ledger).toHaveLength(1);
      expect(facts.mapping[0]).toMatchObject({ contract_version: 2, route_kind: 'chat' });
      expect(facts.result[0]).toMatchObject({ contract_version: 2, content_type: 'text/event-stream' });
      expect(facts.admission[0]).toMatchObject({ state: 'settled', authorized_max_credits: '3457', actual_cost_credits: '3', released_payg_credits: '3454' });
      expect(facts.context[0]).toMatchObject({ supplier_authorized_max_usd_micro: '19205', supplier_actual_usd_micro: '18' });
      expect(facts.balance[0]?.payg_credits).toBe('9997');
      const storedBody = facts.result[0]!.response_body as Record<string, unknown>;
      const usageSnapshot = facts.admission[0]!.usage_snapshot as Record<string, unknown>;
      const changedFinal = structuredClone(storedBody) as { final: { choices: Array<{ message: { content: string } }> } };
      changedFinal.final.choices[0]!.message.content = 'changed';
      await expect(r.client`SELECT aiag_http_validate_response('chat',${JSON.stringify(changedFinal)}::jsonb,${JSON.stringify(usageSnapshot)}::jsonb)`).rejects.toThrow();
      const missingUsage = structuredClone(storedBody) as { events: unknown[] };
      missingUsage.events.pop();
      await expect(r.client`SELECT aiag_http_validate_response('chat',${JSON.stringify(missingUsage)}::jsonb,${JSON.stringify(usageSnapshot)}::jsonb)`).rejects.toThrow();

      const replay = await f.post(id);
      expect(replay.status).toBe(200);
      expect(replay.headers.get('x-aiag-charged-microcredits')).toBe('3');
      expect(replay.headers.get('x-aiag-charged-usd-micro')).toBe('30');
      const replayParsed = parseSse(await replay.text());
      expect(replayParsed.payloads.at(-1)).toBe('[DONE]');
      expect(replayParsed.events).toEqual(parsed.events);
      expect(r.provider).toHaveBeenCalledTimes(1);

      const conflict = await f.post(id, { ...streamBody('native stream'), stream: false });
      expect(conflict.status).toBe(409);
      expect(r.provider).toHaveBeenCalledTimes(1);
      await r.client`UPDATE gateway_api_keys SET revoked_at=clock_timestamp() WHERE id=${f.key}::uuid`;
      expect((await f.post(id)).status).toBe(401);
    } finally { await f.cleanup(); }
  });

  it('continues provider evidence and settles after the client cancels its reader', async () => {
    const f = await owner(r, { body: streamBody('disconnect stream'), initialPaygCredits: 10_000 });
    try {
      r.provider.mockClear();
      const response = await f.post();
      const reader = response.body!.getReader();
      await reader.read();
      await reader.cancel();
      await waitFor(async () => (await f.facts()).admission[0]?.state === 'settled', 'stream did not settle after client cancel');
      const facts = await f.facts();
      expect(facts.admission[0]).toMatchObject({ actual_cost_credits: '3', released_payg_credits: '3454' });
      expect(facts.ledger).toHaveLength(1);
      expect(r.provider).toHaveBeenCalledTimes(1);
    } finally { await f.cleanup(); }
  }, 10_000);

  it('serializes concurrent fresh claims and replays through a new app process', async () => {
    const f = await owner(r, { body: streamBody('concurrent stream'), initialPaygCredits: 10_000 });
    let releaseLock!: () => void, lockReady!: () => void, releaseReads!: () => void, bothReads!: () => void;
    const lockGate = new Promise<void>((resolve) => { releaseLock = resolve; });
    const locked = new Promise<void>((resolve) => { lockReady = resolve; });
    const readGate = new Promise<void>((resolve) => { releaseReads = resolve; });
    const readsReady = new Promise<void>((resolve) => { bothReads = resolve; });
    const held = r.client.begin(async (tx) => {
      await tx`LOCK TABLE gateway_http_requests IN SHARE ROW EXCLUSIVE MODE`;
      lockReady();
      await lockGate;
    });
    let readSpy: { mockRestore(): void } | undefined;
    let requestDone: Promise<PromiseSettledResult<Response>[]> = Promise.resolve([]);
    try {
      await locked;
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
      requestDone = Promise.allSettled([f.post(id), f.post(id)]);
      await readsReady;
      releaseReads();
      await waitFor(async () => Number((await r.other`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE wait_event_type='Lock' AND query LIKE '%aiag_claim_gateway_http_request_v1%'
      `)[0]?.n) >= 2, 'two stream claim waits were not observed');
      releaseLock();
      await held;
      const results = await requestDone;
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason;
        expect([200, 202]).toContain(result.value.status);
        await result.value.text();
      }
      const replay = await f.post(id);
      expect(replay.status).toBe(200);
      const replayText = await replay.text();
      expect(parseSse(replayText).payloads.at(-1)).toBe('[DONE]');
      expect(replay.headers.get('x-aiag-charged-microcredits')).toBe('3');
      expect(r.provider).toHaveBeenCalledTimes(1);
      let facts = await f.facts();
      expect(facts.mapping).toHaveLength(1);
      expect(facts.admission).toHaveLength(1);
      expect(facts.ledger).toHaveLength(1);

      const child = `
        import {assertTestDatabaseEnvironment,withGuardedTestDatabase} from './packages/database/scripts/test-db-guard.ts';
        import {createPgTestClient} from './packages/database/scripts/pg-test-client.ts';
        assertTestDatabaseEnvironment(process.env);
        await withGuardedTestDatabase(process.env,{clientFactory:createPgTestClient},async()=>{});
        globalThis.fetch=async()=>{throw new Error('new app stream replay attempted network');};
        const {app}=await import('./packages/api-gateway/src/server.ts');
        try {
          const response=await app.fetch(new Request('http://native.test/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+process.env.REPLAY_TOKEN,'content-type':'application/json','idempotency-key':process.env.REPLAY_ID},body:process.env.REPLAY_BODY}));
          const text=await response.text();
          if(response.status!==200||!text.includes('data: [DONE]'))throw new Error('new app stream replay mismatch');
          if(response.headers.get('x-aiag-charged-microcredits')!=='3'||response.headers.get('x-aiag-charged-usd-micro')!=='30')throw new Error('new app stream receipt mismatch');
        } finally {
          await (await import('./packages/api-gateway/src/lib/db.ts')).sql.end();
          const redis=await import('./packages/api-gateway/src/lib/redis.ts');
          await redis.redis.quit();await redis.makeRedis('ratelimit').quit();
        }
        console.log('new app stream replay verified');
      `;
      expect(execFileSync('bun', ['-e', child], { cwd: process.cwd(), env: { ...process.env, REPLAY_TOKEN: f.token, REPLAY_ID: id, REPLAY_BODY: JSON.stringify(f.body) }, encoding: 'utf8', timeout: 20_000 })).toContain('new app stream replay verified');
      facts = await f.facts();
      expect(facts.ledger).toHaveLength(1);
      expect(r.provider).toHaveBeenCalledTimes(1);
    } finally {
      releaseReads?.(); releaseLock?.();
      readSpy?.mockRestore();
      await Promise.allSettled([held]);
      await requestDone;
      await f.cleanup();
    }
  }, 30_000);

  it('rejects BYOK, key exclusion, and insufficient funds before provider execution', async () => {
    const byok = await owner(r, { body: streamBody('byok denied'), initialPaygCredits: 10_000 });
    const excluded = await owner(r, { body: streamBody('policy denied'), initialPaygCredits: 10_000 });
    const unfunded = await owner(r, { body: streamBody('no funds'), initialPaygCredits: 0 });
    const failures: unknown[] = [];
    try {
      r.provider.mockClear();

      const byokResponse = await byok.post(randomUUID(), byok.body, {
        headers: { 'x-upstream-key': 'secret-provider-key' },
      });
      expect(byokResponse.status).toBe(501);
      expect((await byok.facts()).admission).toHaveLength(0);

      await r.client`UPDATE gateway_api_keys
        SET model_whitelist='["forbidden/model"]'::jsonb
        WHERE id=${excluded.key}::uuid`;
      const excludedResponse = await excluded.post();
      expect(excludedResponse.status).toBe(403);
      expect((await excluded.facts()).admission).toHaveLength(0);

      const unfundedResponse = await unfunded.post();
      expect(unfundedResponse.status).toBe(402);
      expect((await unfunded.facts()).ledger).toHaveLength(0);

      expect(r.provider).not.toHaveBeenCalled();
    } catch (error) {
      failures.push(error);
    } finally {
      const results = await Promise.allSettled([
        byok.cleanup(),
        excluded.cleanup(),
        unfunded.cleanup(),
      ]);
      for (const result of results) {
        if (result.status === 'rejected') failures.push(result.reason);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) {
      throw new AggregateError(failures, 'stream denial fixture or cleanup failed');
    }
  });

  it('keeps missing terminal usage held and excludes it from actual recovery', async () => {
    const f = await owner(r, { body: streamBody('missing usage'), initialPaygCredits: 10_000 });
    try {
      r.provider.mockClear();
      const common = { id: 'cmpl-missing', object: 'chat.completion.chunk', created: 1, model: slug };
      const invalid = [
        { ...common, choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] },
        { ...common, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ];
      r.provider.mockResolvedValueOnce(new Response(`${invalid.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
      const response = await f.post();
      expect(response.status).toBe(200);
      expect((await response.text()).endsWith('[DONE]\n\n')).toBe(false);
      const before = await f.facts();
      expect(before.admission[0]).toMatchObject({ state: 'dispatched', authorized_max_credits: '3457', actual_cost_credits: null });
      expect(before.result).toHaveLength(0);
      expect(before.balance[0]?.payg_credits).toBe('6543');
      expect(await runActualRecovery()).toMatchObject({ selected: 0, attempted: 0, settled: 0 });
      expect(await f.facts()).toEqual(before);
      expect(r.provider).toHaveBeenCalledTimes(1);
    } finally { await f.cleanup(); }
  });

  it('recovers one durable stream outcome after settle failure, revoke, and expiry', async () => {
    const f = await owner(r, { body: streamBody('recover stream'), initialPaygCredits: 10_000 });
    try {
      r.provider.mockClear();
      const settle = vi.spyOn(r.admission, 'settleAdmittedGatewayCharge').mockRejectedValue(new Error('forced settle unavailable'));
      const id = randomUUID();
      try {
        const response = await f.post(id);
        expect(response.status).toBe(200);
        expect((await response.text()).includes('data: [DONE]')).toBe(false);
      }
      finally { settle.mockRestore(); }
      expect(r.provider).toHaveBeenCalledTimes(1);
      let facts = await f.facts();
      expect(facts.admission[0]).toMatchObject({ state: 'outcome_recorded', actual_cost_credits: '3' });
      const billing = String(facts.admission[0]!.billing_request_id);
      await r.client`WITH original AS (
        DELETE FROM gateway_http_results WHERE billing_request_id=${billing}::uuid AND org_id=${f.org}::uuid RETURNING *
      ) INSERT INTO gateway_http_results(billing_request_id,org_id,api_key_id,contract_version,http_status,content_type,response_body,response_digest,stored_at,expires_at)
        SELECT billing_request_id,org_id,api_key_id,contract_version,http_status,content_type,response_body,response_digest,t.at-INTERVAL '168 hours',t.at
        FROM original CROSS JOIN (SELECT clock_timestamp() AS at) t`;
      expect(await r.storage.expireGatewayHttpResult({ orgId: f.org, billingRequestId: billing }, r.client)).toBe(true);
      await r.client`UPDATE gateway_api_keys SET revoked_at=clock_timestamp() WHERE id=${f.key}::uuid`;
      expect(await runActualRecovery()).toMatchObject({ selected: 1, attempted: 1, settled: 1, unconfirmed: 0 });
      facts = await f.facts();
      expect(facts.admission[0]).toMatchObject({ state: 'settled', released_payg_credits: '3454' });
      expect(facts.ledger).toHaveLength(1);
      expect(facts.balance[0]?.payg_credits).toBe('9997');
      expect(await runActualRecovery()).toMatchObject({ selected: 0, attempted: 0, settled: 0 });
      expect(r.provider).toHaveBeenCalledTimes(1);
      expect((await f.post(id)).status).toBe(401);
      await r.client`UPDATE gateway_api_keys SET revoked_at=NULL WHERE id=${f.key}::uuid`;
      expect((await f.post(id)).status).toBe(410);
    } finally { await f.cleanup(); }
  });
});
