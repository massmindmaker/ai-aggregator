import { describe, expect, it, vi } from 'vitest';

import {
  createStoredChatStreamAttempt,
  type StoredChatStreamAttemptArgs,
  type StoredChatStreamAttemptDependencies,
} from '../billing/stored-chat-stream-attempt';
import type { GatewayChargeAdmissionResult } from '../billing/admission-result';
import type { StoredChatStreamEvent } from '../upstreams/interface';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const time = '2026-09-24T00:00:00.000000Z';
const events: StoredChatStreamEvent[] = [
  { id: 'gen-1', object: 'chat.completion.chunk', created: 1, model: 'openai/gpt-4o-mini', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
  { id: 'gen-1', object: 'chat.completion.chunk', created: 1, model: 'openai/gpt-4o-mini', choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: null }] },
  { id: 'gen-1', object: 'chat.completion.chunk', created: 1, model: 'openai/gpt-4o-mini', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  { id: 'gen-1', object: 'chat.completion.chunk', created: 1, model: 'openai/gpt-4o-mini', choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, cached_input_tokens: 0 } },
];

function args(): StoredChatStreamAttemptArgs {
  return {
    orgId: uuid(1), apiKeyId: uuid(2), clientRequestId: 'trace', declaredSessionId: 'SID.1',
    preDispatchDeadlineAt: time, cachingDiscount: '0.5', requestedMode: 'fastest', policy: {},
    model: { slug: 'openai/gpt-4o-mini', type: 'chat', candidates: [{
      id: 'openrouter', upstream_id: 'openrouter', upstream_model_id: 'openai/gpt-4o-mini', provider: 'openai',
      price_per_1k_input: 1, price_per_1k_output: 1, markup: 1, latency_p50_ms: 1, uptime: 1,
      ru_residency: false, billing: { modelUpstreamId: uuid(3), prices: { inputCentsPer1k: '0.015', outputCentsPer1k: '0.06', markup: '1.8' } },
    }] },
    body: { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'prompt' }], max_tokens: 10, stream: true },
    defaultMaxOutputTokens: 10,
  };
}

function fixture() {
  let nextId = 10;
  const order: string[] = [];
  const execute = vi.fn(async (_request, onEvent) => {
    order.push('provider');
    let writes = true;
    for (const event of events) {
      if (!writes) continue;
      try { await onEvent?.(event); } catch { writes = false; }
    }
    return {
      events,
      response: { id: 'gen-1', object: 'chat.completion' as const, created: 1, model: 'openai/gpt-4o-mini', choices: [{ index: 0, message: { role: 'assistant' as const, content: 'answer' }, finish_reason: 'stop' as const }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, cached_input_tokens: 0 } },
      usage: { promptTokens: 100, completionTokens: 5, totalTokens: 105, cachedInputTokens: 0 },
    };
  });
  let current: GatewayChargeAdmissionResult | null = null;
  const admission = (patch: Partial<GatewayChargeAdmissionResult> = {}): GatewayChargeAdmissionResult => Object.freeze({
    orgId: uuid(1), apiKeyId: uuid(2), billingRequestId: uuid(10), clientRequestId: 'trace', routeKind: 'chat', billingMode: 'stored', modelSlug: 'openai/gpt-4o-mini',
    state: 'held', didTransition: true, authorizedMaxCredits: 3457n, heldSubscriptionCredits: 0n, heldPaygCredits: 3457n,
    quoteSnapshot: {}, preDispatchDeadlineAt: time,
    capturedSubscriptionExpiresAt: null, attemptId: null, upstreamId: null, pricingSnapshot: null, actualCostCredits: null,
    usageSnapshot: null, outcomeKind: null, createdAt: time, dispatchedAt: null, outcomeRecordedAt: null, settledAt: null,
    cancelledAt: null, reconcileAfter: null, releasedSubscriptionCredits: 0n, releasedPaygCredits: 0n,
    debtRepaidCredits: 0n, expiredSubscriptionCredits: 0n, ...patch,
  }) as GatewayChargeAdmissionResult;
  const deps: Partial<StoredChatStreamAttemptDependencies> = {
    newUuid: vi.fn(() => uuid(nextId++)),
    getAdapter: vi.fn(() => ({ admittedChatStream: { contract: 'openrouter-pinned-provider-chat-stream-v1' as const, execute }, chat: vi.fn() })),
    admitGatewayChargeV2: vi.fn(async () => { order.push('admit'); current = admission(); return current; }),
    markGatewayChargeDispatched: vi.fn(async ({ admission: before, attemptId, upstreamId, pricingSnapshot }) => {
      order.push('dispatch'); current = admission({ ...before, state: 'dispatched', attemptId, upstreamId, pricingSnapshot });
      return { kind: 'dispatch_granted' as const, admission: current };
    }),
    persistOutcome: vi.fn(async ({ admission: before, actualCostCredits, usageSnapshot }) => {
      order.push('persist'); current = admission({ ...before, state: 'outcome_recorded', actualCostCredits, usageSnapshot, outcomeKind: 'success', outcomeRecordedAt: time }); return current;
    }),
    settleAdmittedGatewayCharge: vi.fn(async ({ admission: before }) => { order.push('settle'); current = admission({ ...before, state: 'settled', settledAt: time, releasedPaygCredits: before.authorizedMaxCredits - (before.actualCostCredits ?? 0n) }); return current; }),
    cancelUndispatchedGatewayCharge: vi.fn(async ({ admission: before }) => admission({ ...before, state: 'cancelled', cancelledAt: time })),
  };
  return { deps, order, execute, admission };
}

describe('stored chat stream durable attempt', () => {
  it('confirms admit and dispatch before one provider run, then persists and settles', async () => {
    const f = fixture();
    const prepared = createStoredChatStreamAttempt(args(), f.deps);
    expect(prepared.status).toBe('ready');
    if (prepared.status !== 'ready') return;
    const begun = await prepared.begin();
    expect(begun.kind).toBe('dispatch_granted');
    expect(f.order).toEqual(['admit', 'dispatch']);
    if (begun.kind !== 'dispatch_granted') return;
    const callback = vi.fn(async () => { throw new Error('client closed'); });
    const [first, second] = await Promise.all([begun.runner.run(callback), begun.runner.run(callback)]);
    expect(first).toBe(second);
    expect(first.kind).toBe('settled_success');
    expect(f.order).toEqual(['admit', 'dispatch', 'provider', 'persist', 'settle']);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('returns admission replay without invoking provider', async () => {
    const f = fixture();
    const prepared = createStoredChatStreamAttempt(args(), {
      ...f.deps,
      admitGatewayChargeV2: vi.fn(async () => f.admission({ didTransition: false })),
    });
    if (prepared.status !== 'ready') throw new Error('fixture unavailable');
    expect(await prepared.begin()).toMatchObject({ kind: 'replay', state: 'held' });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('keeps a durable outcome pending when settlement acknowledgement fails', async () => {
    const f = fixture();
    const prepared = createStoredChatStreamAttempt(args(), {
      ...f.deps,
      settleAdmittedGatewayCharge: vi.fn(async () => { throw new Error('lost settle ack'); }),
    });
    if (prepared.status !== 'ready') throw new Error('fixture unavailable');
    const begun = await prepared.begin();
    if (begun.kind !== 'dispatch_granted') throw new Error('dispatch unavailable');
    expect(await begun.runner.run(async () => undefined)).toMatchObject({ kind: 'reconciliation_required', stage: 'settle', lastConfirmedState: 'outcome_recorded' });
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
});
