import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createStoredChatAttempt,
  type StoredChatAttemptDependencies,
  type StoredChatAttemptArgs,
} from '../billing/stored-chat-attempt';
import {
  AdmissionConflictError,
  AdmissionDeadlineExpiredError,
  AdmissionUnavailableError,
} from '../billing/admission';
import { errors } from '../lib/errors';
import type { GatewayChargeAdmissionState } from '../billing/admission-result';
import type {
  AdmittedChatMechanics,
  AdmittedChatRequest,
} from '../upstreams/interface';
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const time = '2026-09-08T00:00:00.000000Z';
function args(): StoredChatAttemptArgs {
  return {
    orgId: uuid(1),
    apiKeyId: uuid(2),
    clientRequestId: 'trace',
    preDispatchDeadlineAt: time,
    cachingDiscount: '0.5',
    model: {
      slug: 'openai/gpt-4o-mini',
      type: 'chat',
      candidates: [
        {
          id: 'openrouter',
          upstream_id: 'openrouter',
          upstream_model_id: 'openai/gpt-4o-mini',
          provider: 'openai',
          price_per_1k_input: 1,
          price_per_1k_output: 1,
          markup: 999,
          latency_p50_ms: 1,
          uptime: 1,
          ru_residency: false,
          billing: {
            modelUpstreamId: uuid(3),
            prices: {
              inputCentsPer1k: '0.123456789012345678',
              outputCentsPer1k: '0.5',
              markup: '1.25',
            },
          },
        },
      ],
    },
    requestedMode: 'fastest',
    policy: {},
    body: {
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'private prompt' }],
    },
    defaultMaxOutputTokens: 4096,
  };
}
function completion() {
  return {
    response: {
      id: 'gen-1',
      object: 'chat.completion' as const,
      created: 1,
      model: 'reported/alias',
      choices: [
        {
          index: 0,
          message: { role: 'assistant' as const, content: 'private answer' },
          finish_reason: 'stop' as const,
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    },
    usage: {
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cachedInputTokens: 50,
    },
  };
}
function fixture() {
  let id = 10;
  const order: string[] = [];
  const output = completion();
  const execute = vi.fn(async (_request: AdmittedChatRequest) => {
    order.push('execute');
    return output;
  });
  const mechanics: AdmittedChatMechanics = {
    contract: 'openrouter-pinned-provider-chat-v1',
    execute,
  };
  const legacy = vi.fn(async () => {
    throw Error('legacy forbidden');
  });
  const adapter = { admittedChat: mechanics, chat: legacy };
  const deps = {
    newUuid: vi.fn(() => uuid(id++)),
    getAdapter: vi.fn(() => adapter),
    admitGatewayCharge: vi.fn<
      Parameters<StoredChatAttemptDependencies['admitGatewayCharge']>,
      ReturnType<StoredChatAttemptDependencies['admitGatewayCharge']>
    >(async (a) => {
      order.push('admit');
      return Object.freeze({
        ...a,
        state: 'held',
        didTransition: true,
        heldSubscriptionCredits: 0n,
        heldPaygCredits: a.authorizedMaxCredits,
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
    }),
    markGatewayChargeDispatched: vi.fn<
      Parameters<StoredChatAttemptDependencies['markGatewayChargeDispatched']>,
      ReturnType<StoredChatAttemptDependencies['markGatewayChargeDispatched']>
    >(async (a) => {
      order.push('dispatch');
      return {
        kind: 'dispatch_granted',
        admission: Object.freeze({
          ...a.admission,
          state: 'dispatched',
          didTransition: true,
          attemptId: a.attemptId,
          upstreamId: a.upstreamId,
          pricingSnapshot: a.pricingSnapshot,
          dispatchedAt: time,
        }),
      };
    }),
    recordGatewayChargeOutcome: vi.fn<
      Parameters<StoredChatAttemptDependencies['recordGatewayChargeOutcome']>,
      ReturnType<StoredChatAttemptDependencies['recordGatewayChargeOutcome']>
    >(async (a) => {
      order.push('outcome');
      return Object.freeze({
        ...a.admission,
        state: 'outcome_recorded',
        didTransition: true,
        actualCostCredits: a.actualCostCredits,
        outcomeKind: a.outcomeKind,
        usageSnapshot: a.usageSnapshot,
        outcomeRecordedAt: time,
      });
    }),
    settleAdmittedGatewayCharge: vi.fn<
      Parameters<StoredChatAttemptDependencies['settleAdmittedGatewayCharge']>,
      ReturnType<StoredChatAttemptDependencies['settleAdmittedGatewayCharge']>
    >(async (a) => {
      order.push('settle');
      return Object.freeze({
        ...a.admission,
        state: 'settled',
        didTransition: true,
        settledAt: time,
      });
    }),
    cancelUndispatchedGatewayCharge: vi.fn<
      Parameters<
        StoredChatAttemptDependencies['cancelUndispatchedGatewayCharge']
      >,
      ReturnType<
        StoredChatAttemptDependencies['cancelUndispatchedGatewayCharge']
      >
    >(async (a) => {
      order.push('cancel');
      return Object.freeze({
        ...a.admission,
        state: 'cancelled',
        didTransition: true,
        cancelledAt: time,
      });
    }),
  };
  const input = args();
  const ready = () => {
    const result = createStoredChatAttempt(input, deps);
    if (result.status !== 'ready') throw Error(result.status);
    return result;
  };
  return {
    input,
    deps,
    order,
    output,
    execute,
    mechanics,
    adapter,
    legacy,
    ready,
  };
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
afterEach(() => {
  vi.unstubAllEnvs();
});
describe('one funded stored attempt', () => {
  it('memoizes the same promise synchronously through all deferred stages', async () => {
    const f = fixture();
    const gates: Array<() => void> = [];
    for (const key of [
      'admitGatewayCharge',
      'markGatewayChargeDispatched',
      'recordGatewayChargeOutcome',
      'settleAdmittedGatewayCharge',
    ] as const) {
      const original = f.deps[key].getMockImplementation()!;
      const gate = deferred<void>();
      gates.push(() => gate.resolve());
      f.deps[key].mockImplementation((async (a: never) => {
        await gate.promise;
        return original(a);
      }) as never);
    }
    const provider = deferred<void>();
    f.execute.mockImplementation(async () => {
      f.order.push('execute');
      await provider.promise;
      return f.output;
    });
    const handle = f.ready();
    const first = handle.run();
    expect(handle.run()).toBe(first);
    expect(f.execute).not.toHaveBeenCalled();
    gates[0]!();
    await vi.waitFor(() =>
      expect(f.deps.markGatewayChargeDispatched).toHaveBeenCalledTimes(1),
    );
    expect(f.execute).not.toHaveBeenCalled();
    gates[1]!();
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
    expect(f.deps.recordGatewayChargeOutcome).not.toHaveBeenCalled();
    provider.resolve();
    await vi.waitFor(() =>
      expect(f.deps.recordGatewayChargeOutcome).toHaveBeenCalledTimes(1),
    );
    expect(f.deps.settleAdmittedGatewayCharge).not.toHaveBeenCalled();
    gates[2]!();
    await vi.waitFor(() =>
      expect(f.deps.settleAdmittedGatewayCharge).toHaveBeenCalledTimes(1),
    );
    gates[3]!();
    expect((await first).kind).toBe('settled_success');
    expect(handle.run()).toBe(first);
    expect(f.order).toEqual([
      'admit',
      'dispatch',
      'execute',
      'outcome',
      'settle',
    ]);
    expect(f.deps.newUuid).toHaveBeenCalledTimes(2);
  });
  it('freezes all input financial/request facts and bound mechanics once', async () => {
    const f = fixture();
    const handle = f.ready();
    f.input.model.slug = 'changed';
    f.input.model.candidates[0]!.billing = undefined;
    (f.input.body as { messages: { content: string }[] }).messages[0]!.content =
      'changed';
    f.input.cachingDiscount = '1';
    (f.mechanics as { execute: unknown }).execute = vi.fn(() => {
      throw Error('mutated');
    });
    f.adapter.admittedChat = {
      contract: 'openrouter-pinned-provider-chat-v1',
      execute: async () => {
        throw Error('replaced');
      },
    };
    expect((await handle.run()).kind).toBe('settled_success');
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.deps.getAdapter).toHaveBeenCalledTimes(1);
    expect(f.legacy).not.toHaveBeenCalled();
    expect(f.execute.mock.calls[0]?.[0]).toMatchObject({
      messages: [{ content: 'private prompt' }],
      modelId: 'openai/gpt-4o-mini',
      maxTokens: 4096,
    });
    const admission = f.deps.admitGatewayCharge.mock.calls[0]![0];
    expect(admission.quoteSnapshot).toMatchObject({
      version: 1,
      actualChargePolicy: { cachingDiscount: '0.5' },
    });
    expect(JSON.stringify(admission.quoteSnapshot)).not.toContain(
      'private prompt',
    );
  });
  it.each([undefined, 10000, 20000])('pins cap %s', async (cap) => {
    const f = fixture();
    if (cap !== undefined)
      (f.input.body as Record<string, unknown>).max_tokens = cap;
    await f.ready().run();
    expect(f.execute.mock.calls[0]?.[0]).toMatchObject({
      maxTokens: cap === undefined ? 4096 : Math.min(cap, 16384),
    });
  });
  it('keeps maximum of expensive eligible rows while billing the cheap winner', async () => {
    const f = fixture();
    const c = f.input.model.candidates[0]!;
    f.input.model.candidates.push({
      ...c,
      latency_p50_ms: 10,
      billing: {
        modelUpstreamId: uuid(4),
        prices: { inputCentsPer1k: '1', outputCentsPer1k: '2', markup: '2' },
      },
    });
    const result = await f.ready().run();
    expect(result).toMatchObject({
      kind: 'settled_success',
      actualCostCredits: 21n,
    });
    expect(
      f.deps.admitGatewayCharge.mock.calls[0]![0].authorizedMaxCredits,
    ).toBe(264192n);
    expect(
      f.deps.markGatewayChargeDispatched.mock.calls[0]![0].pricingSnapshot,
    ).toMatchObject({ modelUpstreamId: uuid(3), maxCredits: '21681' });
    expect(f.deps.getAdapter).toHaveBeenCalledTimes(1);
  });
  it.each([
    'held',
    'dispatched',
    'outcome_recorded',
    'settled',
    'cancelled',
  ] as GatewayChargeAdmissionState[])(
    'admission replay %s never marks, cancels or executes',
    async (state) => {
      const f = fixture();
      const original = f.deps.admitGatewayCharge.getMockImplementation()!;
      f.deps.admitGatewayCharge.mockImplementation(async (a) => ({
        ...(await original(a)),
        state,
        didTransition: false,
      }));
      expect(await f.ready().run()).toMatchObject({ kind: 'replay', state });
      expect(f.deps.markGatewayChargeDispatched).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.deps.cancelUndispatchedGatewayCharge).not.toHaveBeenCalled();
    },
  );
  it.each([
    'dispatched',
    'outcome_recorded',
    'settled',
  ] as GatewayChargeAdmissionState[])(
    'dispatch replay %s never executes',
    async (state) => {
      const f = fixture();
      const original =
        f.deps.markGatewayChargeDispatched.getMockImplementation()!;
      f.deps.markGatewayChargeDispatched.mockImplementation(async (a) => ({
        kind: 'replay',
        admission: {
          ...(await original(a)).admission,
          state,
          didTransition: false,
        },
      }));
      expect(await f.ready().run()).toMatchObject({ kind: 'replay', state });
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.deps.cancelUndispatchedGatewayCharge).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['admitGatewayCharge', 'admit', null],
    ['markGatewayChargeDispatched', 'dispatch', 'held'],
    ['recordGatewayChargeOutcome', 'outcome', 'dispatched'],
    ['settleAdmittedGatewayCharge', 'settle', 'outcome_recorded'],
  ] as const)(
    'lost acknowledgement %s is funded unknown',
    async (key, stage, lastConfirmedState) => {
      const f = fixture();
      f.deps[key].mockRejectedValue(new AdmissionUnavailableError());
      const handle = f.ready();
      const result = await handle.run();
      expect(result).toMatchObject({
        kind: 'reconciliation_required',
        stage,
        lastConfirmedState,
        billingRequestId: uuid(10),
      });
      expect(await handle.run()).toBe(result);
      expect(f.execute.mock.calls.length).toBe(
        key === 'admitGatewayCharge' || key === 'markGatewayChargeDispatched'
          ? 0
          : 1,
      );
      expect(f.deps.cancelUndispatchedGatewayCharge).not.toHaveBeenCalled();
    },
  );
  it.each([
    'admitGatewayCharge',
    'markGatewayChargeDispatched',
    'recordGatewayChargeOutcome',
    'settleAdmittedGatewayCharge',
  ] as const)('malformed acknowledgement %s is unknown', async (key) => {
    const f = fixture();
    f.deps[key].mockResolvedValue(undefined as never);
    expect((await f.ready().run()).kind).toBe('reconciliation_required');
  });
  it('dispatch conflict forbids execution and cancellation', async () => {
    const f = fixture();
    f.deps.markGatewayChargeDispatched.mockRejectedValue(
      new AdmissionConflictError(),
    );
    expect(await f.ready().run()).toMatchObject({
      kind: 'reconciliation_required',
      stage: 'dispatch',
    });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.deps.cancelUndispatchedGatewayCharge).not.toHaveBeenCalled();
  });
  it.each([new AdmissionDeadlineExpiredError(), errors.paymentRequired()])(
    'confirmed admission rejection is neutral',
    async (error) => {
      const f = fixture();
      f.deps.admitGatewayCharge.mockRejectedValue(error);
      expect((await f.ready().run()).kind).toBe('rejected');
      expect(f.execute).not.toHaveBeenCalled();
    },
  );
  it('already aborted never admits', async () => {
    const f = fixture();
    f.input.signal = AbortSignal.abort();
    expect((await f.ready().run()).kind).toBe('not_started');
    expect(f.deps.admitGatewayCharge).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'abort before mark cancels only on confirmed ack (lost=%s)',
    async (lost) => {
      const f = fixture();
      const controller = new AbortController();
      f.input.signal = controller.signal;
      const original = f.deps.admitGatewayCharge.getMockImplementation()!;
      f.deps.admitGatewayCharge.mockImplementation(async (a) => {
        const held = await original(a);
        controller.abort();
        return held;
      });
      if (lost)
        f.deps.cancelUndispatchedGatewayCharge.mockRejectedValue(
          new AdmissionUnavailableError(),
        );
      expect(await f.ready().run()).toMatchObject(
        lost
          ? {
              kind: 'reconciliation_required',
              stage: 'cancel',
              lastConfirmedState: 'held',
            }
          : { kind: 'cancelled_no_charge' },
      );
      expect(f.deps.markGatewayChargeDispatched).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.deps.cancelUndispatchedGatewayCharge).toHaveBeenCalledTimes(1);
    },
  );
  it.each([false, true])(
    'reviewed dispatch deadline uses cancel CAS (conflict=%s)',
    async (conflict) => {
      const f = fixture();
      f.deps.markGatewayChargeDispatched.mockRejectedValue(
        new AdmissionDeadlineExpiredError(),
      );
      if (conflict)
        f.deps.cancelUndispatchedGatewayCharge.mockRejectedValue(
          new AdmissionConflictError(),
        );
      expect(await f.ready().run()).toMatchObject(
        conflict
          ? { kind: 'reconciliation_required', stage: 'cancel' }
          : { kind: 'cancelled_no_charge' },
      );
      expect(f.execute).not.toHaveBeenCalled();
    },
  );
  it('abort after mark starts still records a valid completion', async () => {
    const f = fixture();
    const controller = new AbortController();
    f.input.signal = controller.signal;
    const original =
      f.deps.markGatewayChargeDispatched.getMockImplementation()!;
    f.deps.markGatewayChargeDispatched.mockImplementation(async (a) => {
      controller.abort();
      return original(a);
    });
    expect((await f.ready().run()).kind).toBe('settled_success');
    expect(f.deps.cancelUndispatchedGatewayCharge).not.toHaveBeenCalled();
  });
  it.each([
    'timeout',
    'HTTP 400',
    'HTTP 401',
    'HTTP 429',
    'HTTP 500',
    'malformed JSON',
  ])('provider %s leaves hold unknown', async (message) => {
    const f = fixture();
    f.execute.mockRejectedValue(Error(`secret ${message}`));
    const result = await f.ready().run();
    expect(result).toMatchObject({
      kind: 'reconciliation_required',
      stage: 'provider',
      lastConfirmedState: 'dispatched',
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(f.deps.recordGatewayChargeOutcome).not.toHaveBeenCalled();
    expect(f.deps.cancelUndispatchedGatewayCharge).not.toHaveBeenCalled();
  });
  it('invalid usage never records or settles', async () => {
    const f = fixture();
    f.output.usage.completionTokens = 5000;
    expect(await f.ready().run()).toMatchObject({
      kind: 'reconciliation_required',
      stage: 'usage',
    });
    expect(f.deps.recordGatewayChargeOutcome).not.toHaveBeenCalled();
    expect(f.deps.settleAdmittedGatewayCharge).not.toHaveBeenCalled();
  });
  it('zero actual records success and settles', async () => {
    const f = fixture();
    f.input.cachingDiscount = '0';
    f.output.usage.cachedInputTokens = 100;
    expect(await f.ready().run()).toMatchObject({
      kind: 'settled_success',
      actualCostCredits: 0n,
    });
    expect(
      f.deps.recordGatewayChargeOutcome.mock.calls[0]![0].outcomeKind,
    ).toBe('success');
  });
  it('already settled matching outcome skips redundant settlement', async () => {
    const f = fixture();
    const original = f.deps.recordGatewayChargeOutcome.getMockImplementation()!;
    f.deps.recordGatewayChargeOutcome.mockImplementation(async (a) => ({
      ...(await original(a)),
      state: 'settled',
      didTransition: false,
      settledAt: time,
    }));
    expect((await f.ready().run()).kind).toBe('settled_success');
    expect(f.deps.settleAdmittedGatewayCharge).not.toHaveBeenCalled();
  });
  it('detaches outcome evidence before the record await', async () => {
    const f = fixture();
    const original = f.deps.recordGatewayChargeOutcome.getMockImplementation()!;
    f.deps.recordGatewayChargeOutcome.mockImplementation(async (a) => {
      f.output.usage.totalTokens = 0;
      f.output.response.usage.total_tokens = 0;
      return original(a);
    });
    const result = await f.ready().run();
    expect(result).toMatchObject({
      kind: 'settled_success',
      response: { usage: { total_tokens: 120 } },
    });
    expect(
      f.deps.recordGatewayChargeOutcome.mock.calls[0]![0].usageSnapshot,
    ).toMatchObject({ usage: { totalTokens: 120 } });
  });
  it.each(['bad', uuid(10)])(
    'invalid or duplicate generated UUID fails before DB %s',
    (id) => {
      const f = fixture();
      f.deps.newUuid.mockReturnValue(id);
      expect(createStoredChatAttempt(f.input, f.deps).status).toBe(
        'unavailable',
      );
      expect(f.deps.admitGatewayCharge).not.toHaveBeenCalled();
    },
  );
  it('captures unavailable lookup once across duplicate candidate keys', () => {
    const f = fixture();
    f.input.model.candidates.push({ ...f.input.model.candidates[0]! });
    f.deps.getAdapter.mockImplementation(() => {
      throw Error('unavailable');
    });
    expect(createStoredChatAttempt(f.input, f.deps).status).toBe('unavailable');
    expect(f.deps.getAdapter).toHaveBeenCalledTimes(1);
  });
  it('force mock/default registry cannot become billable admitted mechanics', () => {
    const f = fixture();
    vi.stubEnv('AIAG_FORCE_MOCK', '1');
    const { getAdapter: _lookup, ...deps } = f.deps;
    expect(createStoredChatAttempt(f.input, deps).status).toBe('unavailable');
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('preserves the original mechanics receiver as well as the execute function', async () => {
    const f = fixture();
    const bound = vi.fn(function (
      this: AdmittedChatMechanics,
      _request: AdmittedChatRequest,
    ) {
      expect(this).toBe(f.mechanics);
      return Promise.resolve(f.output);
    });
    (f.mechanics as { execute: AdmittedChatMechanics['execute'] }).execute =
      bound;
    const handle = f.ready();
    (f.mechanics as { execute: AdmittedChatMechanics['execute'] }).execute =
      async () => {
        throw Error('replaced');
      };
    expect((await handle.run()).kind).toBe('settled_success');
    expect(bound).toHaveBeenCalledTimes(1);
  });
  it('never broadens admission after policy/prices/egress mutate during admit await', async () => {
    const f = fixture();
    const candidate = f.input.model.candidates[0]!;
    candidate.egress_proxy = 'http://test-only-user:test-only-pass@proxy:3128';
    const policy = {
      allowed_providers: ['openai'],
      blocked_providers: [] as string[],
    };
    f.input.policy = policy;
    const original = f.deps.admitGatewayCharge.getMockImplementation()!;
    f.deps.admitGatewayCharge.mockImplementation(async (a) => {
      policy.allowed_providers.length = 0;
      policy.blocked_providers.push('openai');
      candidate.billing = {
        modelUpstreamId: uuid(9),
        prices: {
          inputCentsPer1k: '999',
          outputCentsPer1k: '999',
          markup: '999',
        },
      };
      candidate.egress_proxy = 'changed';
      f.input.model.candidates.length = 0;
      return original(a);
    });
    expect(await f.ready().run()).toMatchObject({
      kind: 'settled_success',
      actualCostCredits: 21n,
    });
    expect(f.execute.mock.calls[0]![0].egressProxyUrl).toBe(
      'http://test-only-user:test-only-pass@proxy:3128',
    );
    const admission = f.deps.admitGatewayCharge.mock.calls[0]![0];
    const pricing =
      f.deps.markGatewayChargeDispatched.mock.calls[0]![0].pricingSnapshot;
    expect(JSON.stringify([admission.quoteSnapshot, pricing])).not.toMatch(
      /private prompt|test-only-pass|proxy/,
    );
  });
  it.each([
    'recordGatewayChargeOutcome',
    'settleAdmittedGatewayCharge',
  ] as const)(
    'mismatched confirmed evidence at %s remains unknown',
    async (key) => {
      const f = fixture();
      const original = f.deps[key].getMockImplementation()!;
      f.deps[key].mockImplementation((async (a: never) => ({
        ...(await original(a)),
        actualCostCredits: 999n,
      })) as never);
      expect((await f.ready().run()).kind).toBe('reconciliation_required');
      expect(f.execute).toHaveBeenCalledTimes(1);
      expect(f.deps.cancelUndispatchedGatewayCharge).not.toHaveBeenCalled();
    },
  );
  it.each([
    { state: 'held', didTransition: true },
    { state: 'dispatched', didTransition: false },
    { state: 'dispatched', didTransition: true, attemptId: uuid(99) },
  ])('malformed grant %j never authorizes provider', async (patch) => {
    const f = fixture();
    const original =
      f.deps.markGatewayChargeDispatched.getMockImplementation()!;
    f.deps.markGatewayChargeDispatched.mockImplementation(async (a) => {
      const result = await original(a);
      return {
        ...result,
        admission: { ...result.admission, ...patch },
      } as Awaited<ReturnType<typeof original>>;
    });
    expect(await f.ready().run()).toMatchObject({
      kind: 'reconciliation_required',
      stage: 'dispatch',
      lastConfirmedState: 'held',
    });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('a cancellation acknowledgement in another state is unknown', async () => {
    const f = fixture();
    const controller = new AbortController();
    f.input.signal = controller.signal;
    const original = f.deps.admitGatewayCharge.getMockImplementation()!;
    f.deps.admitGatewayCharge.mockImplementation(async (a) => {
      controller.abort();
      return original(a);
    });
    f.deps.cancelUndispatchedGatewayCharge.mockImplementation(async (a) => ({
      ...a.admission,
      state: 'dispatched',
    }));
    expect(await f.ready().run()).toMatchObject({
      kind: 'reconciliation_required',
      stage: 'cancel',
      lastConfirmedState: 'held',
    });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it.each([
    { body: {} },
    { cachingDiscount: '1e-1' },
    { orgId: 'invalid' },
    { preDispatchDeadlineAt: 'invalid' },
  ])('invalid factory contract %j touches no DB/provider', (patch) => {
    const f = fixture();
    Object.assign(f.input, patch);
    expect(createStoredChatAttempt(f.input, f.deps).status).toBe('bad_request');
    expect(f.deps.admitGatewayCharge).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.deps.newUuid).not.toHaveBeenCalled();
  });
});
