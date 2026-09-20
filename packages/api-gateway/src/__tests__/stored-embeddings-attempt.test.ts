import { describe, expect, it, vi } from 'vitest';
import {
  createStoredEmbeddingsAttempt,
  type StoredEmbeddingsAttemptArgs,
  type StoredEmbeddingsAttemptDependencies,
} from '../billing/stored-embeddings-attempt';
import type { GatewayChargeAdmissionResult } from '../billing/admission-result';
import type { AdmitGatewayChargeV2Args } from '../billing/quota-admission';
import type { AdmittedEmbeddingsRequest } from '../upstreams/interface';

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const time = '2026-09-20T12:00:00.000000Z';
const vector = () => Array(1536).fill(0.25);

function args(): StoredEmbeddingsAttemptArgs {
  return {
    orgId: uuid(1),
    apiKeyId: uuid(2),
    clientRequestId: 'trace',
    declaredSessionId: 'Original.SID',
    model: {
      slug: 'openai/text-embedding-3-small',
      type: 'embedding',
      candidates: [
        {
          id: 'openrouter',
          upstream_id: 'openrouter',
          upstream_model_id: 'openai/text-embedding-3-small',
          provider: 'openai',
          price_per_1k_input: 999,
          price_per_1k_output: 999,
          markup: 999,
          latency_p50_ms: 1,
          uptime: 1,
          ru_residency: false,
          billing: {
            modelUpstreamId: uuid(3),
            prices: {
              inputCentsPer1k: '0.002',
              outputCentsPer1k: '0',
              markup: '1.25',
            },
          },
        },
      ],
    },
    requestedMode: 'fastest',
    policy: {},
    body: {
      model: 'openai/text-embedding-3-small',
      input: ['first', 'second'],
      encoding_format: 'float',
      dimensions: 1536,
    },
    preDispatchDeadlineAt: time,
  };
}

function providerOutput() {
  return {
    response: {
      object: 'list' as const,
      model: 'openai/text-embedding-3-small',
      data: [
        { object: 'embedding' as const, index: 0, embedding: vector() },
        { object: 'embedding' as const, index: 1, embedding: vector() },
      ],
      usage: { prompt_tokens: 1000, total_tokens: 1000 },
    },
    usage: {
      promptTokens: 1000,
      totalTokens: 1000,
      providerResponseId: 'emb-1' as string | null,
    },
  };
}

function held(a: AdmitGatewayChargeV2Args): GatewayChargeAdmissionResult {
  return Object.freeze({
    billingRequestId: a.billingRequestId,
    orgId: a.orgId,
    apiKeyId: a.apiKeyId,
    clientRequestId: a.clientRequestId,
    routeKind: a.routeKind,
    billingMode: a.billingMode,
    modelSlug: a.modelSlug,
    authorizedMaxCredits: a.authorizedMaxCredits,
    heldSubscriptionCredits: 0n,
    heldPaygCredits: a.authorizedMaxCredits,
    capturedSubscriptionExpiresAt: null,
    quoteSnapshot: a.quoteSnapshot,
    attemptId: null,
    upstreamId: null,
    pricingSnapshot: null,
    actualCostCredits: null,
    usageSnapshot: null,
    outcomeKind: null,
    state: 'held',
    preDispatchDeadlineAt: a.preDispatchDeadlineAt,
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
    didTransition: true,
  });
}

function fixture() {
  let nextId = 10;
  const order: string[] = [];
  const execute = vi.fn(async (_request: AdmittedEmbeddingsRequest) => {
    order.push('provider');
    return providerOutput();
  });
  const adapter = {
    admittedEmbeddings: {
      contract: 'openrouter-pinned-provider-embeddings-v1' as const,
      execute,
    },
    chat: vi.fn(async () => {
      throw new Error('legacy forbidden');
    }),
  };
  const deps: Partial<StoredEmbeddingsAttemptDependencies> = {
    newUuid: vi.fn(() => uuid(nextId++)),
    getAdapter: vi.fn(() => adapter),
    admitAttempt: vi.fn(async (a) => {
      order.push('admit');
      return { kind: 'admitted' as const, admission: held(a) };
    }),
    markGatewayChargeDispatched: vi.fn(async ({ admission, attemptId, upstreamId, pricingSnapshot }) => {
      order.push('dispatch');
      return {
        kind: 'dispatch_granted' as const,
        admission: Object.freeze({
          ...admission,
          state: 'dispatched' as const,
          didTransition: true,
          attemptId,
          upstreamId,
          pricingSnapshot,
          dispatchedAt: time,
        }),
      };
    }),
    persistOutcome: vi.fn(async ({ admission, actualCostCredits, usageSnapshot, outcomeKind }) => {
      order.push('outcome');
      return Object.freeze({
        ...admission,
        state: 'outcome_recorded' as const,
        didTransition: true,
        actualCostCredits,
        usageSnapshot,
        outcomeKind,
        outcomeRecordedAt: time,
      });
    }),
    settleAdmittedGatewayCharge: vi.fn(async ({ admission }) => {
      order.push('settle');
      return Object.freeze({
        ...admission,
        state: 'settled' as const,
        didTransition: true,
        settledAt: time,
      });
    }),
    cancelUndispatchedGatewayCharge: vi.fn(async ({ admission }) => Object.freeze({
      ...admission,
      state: 'cancelled' as const,
      didTransition: true,
      cancelledAt: time,
    })),
  };
  const ready = () => {
    const value = createStoredEmbeddingsAttempt(args(), deps);
    if (value.status !== 'ready') throw new Error(value.status);
    return value;
  };
  return { deps, adapter, execute, order, ready };
}

describe('one stored embeddings attempt', () => {
  it('memoizes one run and preserves exact quote, dispatch and outcome evidence', async () => {
    const f = fixture();
    const handle = f.ready();
    const first = handle.run();
    expect(handle.run()).toBe(first);
    const result = await first;
    expect(result.kind).toBe('settled_success');
    if (result.kind !== 'settled_success') throw new Error(result.kind);
    expect(result.actualCostCredits).toBe(3n);
    expect(f.order).toEqual(['admit', 'dispatch', 'provider', 'outcome', 'settle']);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.adapter.chat).not.toHaveBeenCalled();
    expect(f.execute.mock.calls[0]![0]).toEqual({
      modelId: 'openai/text-embedding-3-small',
      input: ['first', 'second'],
      endpointPolicy: {
        only: ['openai'],
        allowFallbacks: false,
        requireParameters: true,
      },
    });
    const admit = vi.mocked(f.deps.admitAttempt!).mock.calls[0]![0];
    expect(admit.routeKind).toBe('embeddings');
    expect(admit.authorizedMaxCredits).toBe(41n);
    expect(admit.quoteSnapshot).toMatchObject({
      version: 1,
      actualChargePolicy: {
        formulaVersion: 'db-input-output-cents-per-1k-legacy-whole-cache-v1',
        cachingDiscount: '1',
      },
      tokenQuote: { candidates: [{ modelType: 'embedding', inputCount: 2 }] },
    });
    const persisted = vi.mocked(f.deps.persistOutcome!).mock.calls[0]![0];
    expect(persisted.actualCostCredits).toBe(3n);
    expect(persisted.usageSnapshot).toMatchObject({
      providerResponseId: 'emb-1',
      inputCount: 2,
      usage: { promptTokens: 1000, completionTokens: 0, totalTokens: 1000, cachedInputTokens: 0 },
    });
  });

  it('never invokes provider without a confirmed matching dispatch grant', async () => {
    const f = fixture();
    vi.mocked(f.deps.markGatewayChargeDispatched!).mockResolvedValueOnce({
      kind: 'replay',
      admission: held(vi.mocked(f.deps.admitAttempt!).mock.calls[0]?.[0] ?? ({ } as AdmitGatewayChargeV2Args)),
    });
    const result = await f.ready().run();
    expect(result).toMatchObject({ kind: 'reconciliation_required', stage: 'dispatch' });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.deps.persistOutcome).not.toHaveBeenCalled();
  });

  it('leaves malformed post-dispatch usage unknown and does not settle or redispatch', async () => {
    const f = fixture();
    f.execute.mockResolvedValueOnce({
      ...providerOutput(),
      usage: { promptTokens: 1000, totalTokens: 999, providerResponseId: null },
    });
    const handle = f.ready();
    const result = await handle.run();
    expect(result).toMatchObject({
      kind: 'reconciliation_required',
      stage: 'usage',
      lastConfirmedState: 'dispatched',
    });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(handle.run()).resolves.toBe(result);
    expect(f.deps.persistOutcome).not.toHaveBeenCalled();
    expect(f.deps.settleAdmittedGatewayCharge).not.toHaveBeenCalled();
  });

  it('captures and binds mechanics before caller mutation', async () => {
    const f = fixture();
    const handle = f.ready();
    f.adapter.admittedEmbeddings.execute = vi.fn(async (_request: AdmittedEmbeddingsRequest): ReturnType<typeof f.execute> => {
      throw new Error('mutated');
    });
    const result = await handle.run();
    expect(result.kind).toBe('settled_success');
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('returns bad_request/unavailable before any admission for invalid body or model type', () => {
    const f = fixture();
    expect(createStoredEmbeddingsAttempt({ ...args(), body: { model: args().model.slug, input: [] } }, f.deps).status).toBe('bad_request');
    expect(createStoredEmbeddingsAttempt({ ...args(), model: { ...args().model, type: 'chat' } }, f.deps).status).toBe('unavailable');
    expect(f.deps.admitAttempt).not.toHaveBeenCalled();
  });
});
