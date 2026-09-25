import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  guard,
  owner,
  runtime,
  slug,
  type Runtime,
} from './stored-chat-mounted.native.fixture';

const enabled = process.env.RUN_NATIVE_DB_INTEGRATION === '1';
if (enabled) guard();

const callerKey = 'caller-openrouter-key-123';
const body = {
  model: slug,
  messages: [{ role: 'user' as const, content: 'durable BYOK native' }],
  max_tokens: 10,
};

async function runActualRecovery() {
  const dbModule = await import(
    '../../../../apps/worker/src/queues/gateway-settlement-recovery-db'
  );
  const recovery = await import(
    '../../../../apps/worker/src/queues/gateway-settlement-recovery'
  );
  const db = dbModule.createGatewaySettlementRecoveryDb(
    process.env.TEST_DATABASE_URL!,
    {
      allowedRoutes: ['chat', 'embeddings', 'completions'],
      allowedContractVersions: [1, 2, 3],
    },
  );
  try {
    return await recovery
      .createGatewaySettlementRecoveryLoop(db)
      .runTick(() => false);
  } finally {
    await db.close();
  }
}

function byokHeaders(key = callerKey): Record<string, string> {
  return { 'x-upstream-key': key };
}

describe.skipIf(!enabled)('stored chat BYOK mounted native lifecycle', () => {
  let r: Runtime;

  beforeAll(async () => {
    r = await runtime({
      executionMode: 'stored_chat_embeddings_completions_stream',
      providerCompletionTokens: 5,
      providerCachedInputTokens: 0,
      providerText: 'BYOK native answer',
    });
  });

  afterAll(async () => {
    await r?.close();
  });

  it('reserves and settles the exact fixed fee with zero supplier cost and caller provider key', async () => {
    const f = await owner(r, { body, initialPaygCredits: 5_000 });
    try {
      r.provider.mockClear();
      const id = randomUUID();
      const fresh = await f.post(id, f.body, { headers: byokHeaders() });
      expect(fresh.status).toBe(200);
      expect(fresh.headers.get('x-aiag-charged-microcredits')).toBe('1000');
      expect(fresh.headers.get('x-aiag-charged-usd-micro')).toBe('10000');
      expect(await fresh.json()).toMatchObject({
        object: 'chat.completion',
        choices: [{ message: { content: 'BYOK native answer' } }],
      });
      expect(r.provider).toHaveBeenCalledOnce();
      const init = r.provider.mock.calls[0]![1];
      expect((init.headers as Record<string, string>).authorization).toBe(
        `Bearer ${callerKey}`,
      );

      const facts = await f.facts();
      expect(facts.mapping).toHaveLength(1);
      expect(facts.mapping[0]).toMatchObject({
        route_kind: 'chat',
        billing_mode: 'byok_fee',
        contract_version: 3,
      });
      expect(facts.admission).toHaveLength(1);
      expect(facts.admission[0]).toMatchObject({
        state: 'settled',
        billing_mode: 'byok_fee',
        authorized_max_credits: '1000',
        actual_cost_credits: '1000',
        released_payg_credits: '0',
      });
      expect(facts.context[0]).toMatchObject({
        supplier_authorized_max_usd_micro: '0',
        supplier_actual_usd_micro: '0',
      });
      expect(facts.balance[0]?.payg_credits).toBe('4000');
      expect(facts.ledger).toHaveLength(1);
      expect(String(facts.ledger[0]!.delta)).toBe('-1000');

      const serialized = JSON.stringify({
        mapping: facts.mapping,
        admission: facts.admission,
        context: facts.context,
        result: facts.result,
      });
      expect(serialized).not.toContain(callerKey);

      const replay = await f.post(id, f.body, { headers: byokHeaders() });
      expect(replay.status).toBe(200);
      expect(replay.headers.get('x-aiag-charged-microcredits')).toBe('1000');
      expect(r.provider).toHaveBeenCalledOnce();
      expect((await f.facts()).ledger).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  });

  it('conflicts changed BYOK credentials and stored reuse under the same chat idempotency key', async () => {
    const f = await owner(r, { body, initialPaygCredits: 5_000 });
    try {
      r.provider.mockClear();
      const id = randomUUID();
      expect((await f.post(id, f.body, { headers: byokHeaders() })).status).toBe(200);
      expect(
        (await f.post(id, f.body, {
          headers: byokHeaders('different-caller-provider-key'),
        })).status,
      ).toBe(409);
      expect((await f.post(id, f.body)).status).toBe(409);
      expect(r.provider).toHaveBeenCalledOnce();
      expect((await f.facts()).ledger).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  });

  it('keeps the fixed-fee hold on provider failure and does not recover or retry unknown outcome', async () => {
    const f = await owner(r, { body, initialPaygCredits: 5_000 });
    try {
      r.provider.mockClear();
      r.provider.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'synthetic provider failure' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      );
      const response = await f.post(randomUUID(), f.body, {
        headers: byokHeaders(),
      });
      expect(response.status).toBe(503);
      expect(r.provider).toHaveBeenCalledOnce();

      const facts = await f.facts();
      expect(facts.admission[0]).toMatchObject({
        state: 'dispatched',
        billing_mode: 'byok_fee',
        authorized_max_credits: '1000',
        actual_cost_credits: null,
      });
      expect(facts.result).toHaveLength(0);
      expect(facts.ledger).toHaveLength(0);
      expect(facts.balance[0]?.payg_credits).toBe('4000');
      expect(await runActualRecovery()).toMatchObject({
        selected: 0,
        attempted: 0,
        settled: 0,
      });
      expect(r.provider).toHaveBeenCalledOnce();
    } finally {
      await f.cleanup();
    }
  });

  it('recovers one durable BYOK outcome after settle failure and key revoke without another provider call', async () => {
    const f = await owner(r, { body, initialPaygCredits: 5_000 });
    try {
      r.provider.mockClear();
      const settle = vi
        .spyOn(r.admission, 'settleAdmittedGatewayCharge')
        .mockRejectedValueOnce(new Error('forced BYOK settle failure'));
      const id = randomUUID();
      try {
        expect(
          (await f.post(id, f.body, { headers: byokHeaders() })).status,
        ).toBe(503);
      } finally {
        settle.mockRestore();
      }

      let facts = await f.facts();
      expect(facts.admission[0]).toMatchObject({
        state: 'outcome_recorded',
        billing_mode: 'byok_fee',
        actual_cost_credits: '1000',
      });
      expect(facts.result).toHaveLength(1);
      expect(facts.ledger).toHaveLength(0);
      expect(r.provider).toHaveBeenCalledOnce();

      await r.client`UPDATE gateway_api_keys SET revoked_at=clock_timestamp() WHERE id=${f.key}::uuid`;
      expect(await runActualRecovery()).toMatchObject({
        selected: 1,
        attempted: 1,
        settled: 1,
        unconfirmed: 0,
      });
      expect(await runActualRecovery()).toMatchObject({
        selected: 0,
        attempted: 0,
        settled: 0,
      });

      facts = await f.facts();
      expect(facts.admission[0]).toMatchObject({ state: 'settled' });
      expect(facts.balance[0]?.payg_credits).toBe('4000');
      expect(facts.ledger).toHaveLength(1);
      expect(r.provider).toHaveBeenCalledOnce();

      await r.client`UPDATE gateway_api_keys SET revoked_at=NULL WHERE id=${f.key}::uuid`;
      const replay = await f.post(id, f.body, { headers: byokHeaders() });
      expect(replay.status).toBe(200);
      expect(replay.headers.get('x-aiag-charged-microcredits')).toBe('1000');
      expect(r.provider).toHaveBeenCalledOnce();
    } finally {
      await f.cleanup();
    }
  });
});
