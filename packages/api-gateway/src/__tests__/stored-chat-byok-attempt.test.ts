import { describe, expect, it, vi } from 'vitest';
import {
  createStoredChatByokAttempt,
  type StoredChatByokAttemptArgs,
  type StoredChatByokAttemptDependencies,
} from '../billing/stored-chat-byok-attempt';
import type { AdmittedChatRequest, AdmittedChatMechanics } from '../upstreams/interface';

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const time = '2026-09-25T12:00:00.000000Z';
const secret = 'sk-caller-secret-123';

function args(patch: Partial<StoredChatByokAttemptArgs> = {}): StoredChatByokAttemptArgs {
  return {
    orgId: uuid(1),
    apiKeyId: uuid(2),
    clientRequestId: 'trace',
    declaredSessionId: null,
    preDispatchDeadlineAt: time,
    model: {
      slug: 'openai/gpt-4o-mini',
      type: 'chat',
      candidates: [{
        id: 'openrouter',
        upstream_id: 'openrouter',
        upstream_model_id: 'openai/gpt-4o-mini',
        provider: 'openai',
        ru_residency: false,
        latency_p50_ms: 1,
        uptime: 1,
        priority: 1,
        egress_proxy: null,
        price_per_1k_input: 0.015,
        price_per_1k_output: 0.06,
        markup: 1.8,
        billing: {
          modelUpstreamId: uuid(3),
          prices: { inputCentsPer1k: '0.015', outputCentsPer1k: '0.06', markup: '1.8' },
        },
      }],
    },
    requestedMode: 'auto',
    policy: {},
    body: {
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'private prompt' }],
      max_tokens: 10,
    },
    defaultMaxOutputTokens: 4096,
    byokKey: secret,
    feeCreditsExact: '1',
    ...patch,
  };
}

function response() {
  return {
    response: {
      id: 'gen-byok',
      object: 'chat.completion' as const,
      created: 1,
      model: 'openai/gpt-4o-mini',
      choices: [{
        index: 0,
        message: { role: 'assistant' as const, content: 'answer' },
        finish_reason: 'stop' as const,
      }],
      usage: { prompt_tokens: 100, completion_tokens: 500, total_tokens: 600 },
    },
    usage: {
      promptTokens: 100,
      completionTokens: 500,
      totalTokens: 600,
      cachedInputTokens: 0,
    },
  };
}

function fixture() {
  let next = 10;
  const execute = vi.fn(async (_request: AdmittedChatRequest) => response());
  const mechanics: AdmittedChatMechanics = {
    contract: 'openrouter-pinned-provider-chat-v1',
    execute,
  };
  const adapter = {
    admittedChat: mechanics,
    chat: vi.fn(async () => { throw new Error('legacy forbidden'); }),
  };
  const admission = (
    a: Parameters<StoredChatByokAttemptDependencies['admitGatewayByokFeeV2']>[0],
  ) => Object.freeze({
    ...a,
    state: 'held' as const,
    didTransition: true,
    heldSubscriptionCredits: 0n,
    heldPaygCredits: BigInt(a.authorizedMaxCredits as bigint),
    capturedSubscriptionExpiresAt: null,
    attemptId: null,
    upstreamId: null,
    pricingSnapshot: null,
    actualCostCredits: null,
    usageSnapshot: null,
    outcomeKind: null,
    createdAt: time,
    dispatchedAt: null,
    outcomeRecordedAt: null,
    settledAt: null,
    cancelledAt: null,
    reconcileAfter: null,
    releasedSubscriptionCredits: 0n,
    releasedPaygCredits: 0n,
    debtRepaidCredits: 0n,
    expiredSubscriptionCredits: 0n,
  });
  const deps = {
    newUuid: vi.fn(() => uuid(next++)),
    getAdapter: vi.fn(() => adapter),
    admitGatewayByokFeeV2: vi.fn(async (a) => admission(a)),
    markGatewayChargeDispatched: vi.fn(async (a) => ({
      kind: 'dispatch_granted' as const,
      admission: Object.freeze({
        ...a.admission,
        state: 'dispatched' as const,
        didTransition: true,
        attemptId: a.attemptId,
        upstreamId: a.upstreamId,
        pricingSnapshot: a.pricingSnapshot,
        dispatchedAt: time,
      }),
    })),
    recordGatewayChargeOutcomeV2: vi.fn(async (a) => Object.freeze({
      ...a.admission,
      state: 'outcome_recorded' as const,
      didTransition: true,
      actualCostCredits: a.actualCostCredits,
      usageSnapshot: a.usageSnapshot,
      outcomeKind: a.outcomeKind,
      outcomeRecordedAt: time,
    })),
    settleAdmittedGatewayCharge: vi.fn(async (a) => Object.freeze({
      ...a.admission,
      state: 'settled' as const,
      didTransition: true,
      settledAt: time,
    })),
    cancelUndispatchedGatewayCharge: vi.fn(async (a) => Object.freeze({
      ...a.admission,
      state: 'cancelled' as const,
      didTransition: true,
      cancelledAt: time,
    })),
  } satisfies Partial<StoredChatByokAttemptDependencies>;
  return { deps, execute, adapter };
}

describe('durable stored chat BYOK attempt', () => {
  it('reserves and settles the fixed fee while using the caller key exactly once', async () => {
    const f = fixture();
    const prepared = createStoredChatByokAttempt(args(), f.deps);
    expect(prepared.status).toBe('ready');
    if (prepared.status !== 'ready') return;

    const result = await prepared.run();
    expect(result).toMatchObject({
      kind: 'settled_success',
      actualCostCredits: 1000n,
    });
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.execute.mock.calls[0]![0]).toMatchObject({
      modelId: 'openai/gpt-4o-mini',
      maxTokens: 10,
      byokKey: secret,
    });
    expect(f.execute.mock.calls[0]![0]).not.toHaveProperty('egressProxyUrl');

    const admitted = f.deps.admitGatewayByokFeeV2.mock.calls[0]![0];
    expect(admitted).toMatchObject({
      billingMode: 'byok_fee',
      authorizedMaxCredits: 1000n,
      supplierQuoteSnapshot: { version: 2, formulaVersion: 'byok-zero-v2' },
    });
    const dispatched = f.deps.markGatewayChargeDispatched.mock.calls[0]![0];
    expect(dispatched.pricingSnapshot).toEqual({
      version: 2,
      formulaVersion: 'byok-fee-microcredits-v2',
      upstreamId: 'openrouter',
      feeMicrocredits: '1000',
    });
    const outcome = f.deps.recordGatewayChargeOutcomeV2.mock.calls[0]![0];
    expect(outcome.actualCostCredits).toBe(1000n);
    expect(outcome.usageSnapshot).toEqual({
      version: 2,
      formulaVersion: 'byok-fee-microcredits-v2',
      billingRequestId: prepared.billingRequestId,
      attemptId: expect.any(String),
      upstreamId: 'openrouter',
      verified: true,
    });
    expect(
      JSON.stringify(
        { admitted, dispatched, outcome },
        (_key, value) => typeof value === 'bigint' ? value.toString() : value,
      ),
    ).not.toContain(secret);
  });

  it('does not derive the platform fee from provider token usage', async () => {
    const f = fixture();
    const prepared = createStoredChatByokAttempt(args({ feeCreditsExact: '1.2345' }), f.deps);
    expect(prepared.status).toBe('ready');
    if (prepared.status !== 'ready') return;
    const result = await prepared.run();
    expect(result).toMatchObject({ kind: 'settled_success', actualCostCredits: 1235n });
    expect(f.deps.recordGatewayChargeOutcomeV2.mock.calls[0]![0].actualCostCredits).toBe(1235n);
  });

  it('keeps a post-dispatch provider failure held without outcome, settlement, or retry', async () => {
    const f = fixture();
    f.execute.mockRejectedValueOnce(new Error('provider failed'));
    const prepared = createStoredChatByokAttempt(args(), f.deps);
    expect(prepared.status).toBe('ready');
    if (prepared.status !== 'ready') return;
    await expect(prepared.run()).resolves.toMatchObject({
      kind: 'reconciliation_required',
      stage: 'provider',
      lastConfirmedState: 'dispatched',
    });
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.deps.recordGatewayChargeOutcomeV2).not.toHaveBeenCalled();
    expect(f.deps.settleAdmittedGatewayCharge).not.toHaveBeenCalled();
  });

  it('rejects Aggregator-managed egress proxy before fee admission or provider dispatch', () => {
    const f = fixture();
    const input = args();
    input.model.candidates[0]!.egress_proxy = 'http://proxy.test:3128';
    const prepared = createStoredChatByokAttempt(input, f.deps);
    expect(prepared).toEqual({ status: 'unavailable', code: 'STORED_CHAT_UNAVAILABLE' });
    expect(f.deps.admitGatewayByokFeeV2).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('rejects zero fixed fee before durable admission', () => {
    const f = fixture();
    const prepared = createStoredChatByokAttempt(args({ feeCreditsExact: '0' }), f.deps);
    expect(prepared).toEqual({ status: 'unavailable', code: 'STORED_CHAT_UNAVAILABLE' });
    expect(f.deps.admitGatewayByokFeeV2).not.toHaveBeenCalled();
  });
});
