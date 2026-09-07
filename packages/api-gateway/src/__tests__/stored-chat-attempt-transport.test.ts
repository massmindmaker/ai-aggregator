import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createStoredChatAttempt,
  type StoredChatAttemptDependencies,
} from '../billing/stored-chat-attempt';
import { openRouterUpstream } from '../upstreams/openrouter';
import type { GatewayChargeAdmissionResult } from '../billing/admission-result';
import { safeFetch } from '@aiag/shared/server';
const fetchStub = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>();
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const raw = () => ({
  id: 'gen-1',
  object: 'chat.completion',
  model: 'openai/gpt-4o-mini',
  created: 1,
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'private answer' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
});
function fixture() {
  let n = 10;
  const deps = {
    newUuid: () => id(n++),
    getAdapter: () => openRouterUpstream,
    admitGatewayChargeV2: vi.fn<
      Parameters<StoredChatAttemptDependencies['admitGatewayChargeV2']>,
      ReturnType<StoredChatAttemptDependencies['admitGatewayChargeV2']>
    >(async (a) =>
      Object.freeze({
        ...a,
        state: 'held',
        didTransition: true,
      } as unknown as GatewayChargeAdmissionResult),
    ),
    markGatewayChargeDispatched: vi.fn<
      Parameters<StoredChatAttemptDependencies['markGatewayChargeDispatched']>,
      ReturnType<StoredChatAttemptDependencies['markGatewayChargeDispatched']>
    >(async (a) => ({
      kind: 'dispatch_granted',
      admission: Object.freeze({
        ...a.admission,
        attemptId: a.attemptId,
        upstreamId: a.upstreamId,
        pricingSnapshot: a.pricingSnapshot,
        state: 'dispatched',
        didTransition: true,
      }),
    })),
    recordGatewayChargeOutcomeV2: vi.fn<
      Parameters<StoredChatAttemptDependencies['recordGatewayChargeOutcomeV2']>,
      ReturnType<StoredChatAttemptDependencies['recordGatewayChargeOutcomeV2']>
    >(async (a) =>
      Object.freeze({
        ...a.admission,
        state: 'outcome_recorded',
        actualCostCredits: a.actualCostCredits,
        usageSnapshot: a.usageSnapshot,
        outcomeKind: a.outcomeKind,
      }),
    ),
    settleAdmittedGatewayCharge: vi.fn<
      Parameters<StoredChatAttemptDependencies['settleAdmittedGatewayCharge']>,
      ReturnType<StoredChatAttemptDependencies['settleAdmittedGatewayCharge']>
    >(async (a) => Object.freeze({ ...a.admission, state: 'settled' })),
    cancelUndispatchedGatewayCharge: vi.fn<
      Parameters<
        StoredChatAttemptDependencies['cancelUndispatchedGatewayCharge']
      >,
      ReturnType<
        StoredChatAttemptDependencies['cancelUndispatchedGatewayCharge']
      >
    >(async () => {
      throw Error('must not cancel');
    }),
  };
  const ready = createStoredChatAttempt(
    {
      orgId: id(1),
      apiKeyId: id(2),
      clientRequestId: null,
      declaredSessionId: null,
      preDispatchDeadlineAt: '2026-09-08T00:00:00Z',
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
              modelUpstreamId: id(3),
              prices: {
                inputCentsPer1k: '1',
                outputCentsPer1k: '2',
                markup: '1',
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
        max_tokens: 20000,
      },
      defaultMaxOutputTokens: 4096,
    },
    deps,
  );
  if (ready.status !== 'ready') throw Error(ready.status);
  return { ready, deps };
}
beforeEach(() => {
  fetchStub.mockReset();
  vi.stubGlobal('fetch', fetchStub);
  vi.stubEnv('OPENROUTER_API_KEY', 'test-only-key');
  vi.stubEnv('AIAG_EGRESS_PROXY_URL', '');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe('real admitted adapter -> fetchUpstream -> safeFetch', () => {
  it('emits one pinned paid POST only after grant, then validates outcome and settlement', async () => {
    const f = fixture();
    let grant!: () => void;
    const gate = new Promise<void>((r) => {
      grant = r;
    });
    const original =
      f.deps.markGatewayChargeDispatched.getMockImplementation()!;
    f.deps.markGatewayChargeDispatched.mockImplementation(async (a) => {
      await gate;
      return original(a);
    });
    fetchStub.mockResolvedValue(new Response(JSON.stringify(raw())));
    const result = f.ready.run();
    await vi.waitFor(() =>
      expect(f.deps.markGatewayChargeDispatched).toHaveBeenCalled(),
    );
    expect(fetchStub).not.toHaveBeenCalled();
    grant();
    expect(await result).toMatchObject({
      kind: 'settled_success',
      actualCostCredits: 7n,
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = fetchStub.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(JSON.parse(init!.body as string)).toEqual({
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'private prompt' }],
      max_tokens: 16384,
      stream: false,
      provider: {
        only: ['openai'],
        allow_fallbacks: false,
        require_parameters: true,
      },
    });
    expect(f.deps.recordGatewayChargeOutcomeV2).toHaveBeenCalledTimes(1);
    expect(f.deps.settleAdmittedGatewayCharge).toHaveBeenCalledTimes(1);
  });
  it.each([302, 307, 308])(
    'redirect %s with Location cannot create a second HTTP request',
    async (status) => {
      fetchStub
        .mockResolvedValueOnce(
          new Response(null, {
            status,
            headers: { location: '/api/v1/chat/completions-again' },
          }),
        )
        .mockResolvedValue(new Response(JSON.stringify(raw())));
      const f = fixture();
      expect(await f.ready.run()).toMatchObject({
        kind: 'reconciliation_required',
        stage: 'provider',
        lastConfirmedState: 'dispatched',
      });
      expect(fetchStub).toHaveBeenCalledTimes(1);
      expect(f.deps.recordGatewayChargeOutcomeV2).not.toHaveBeenCalled();
      expect(f.deps.settleAdmittedGatewayCharge).not.toHaveBeenCalled();
      expect(f.deps.cancelUndispatchedGatewayCharge).not.toHaveBeenCalled();
    },
  );
  it('leaves shared redirect defaults unchanged for other callers', async () => {
    fetchStub
      .mockResolvedValueOnce(
        new Response(null, { status: 307, headers: { location: '/second' } }),
      )
      .mockResolvedValueOnce(new Response('ok'));
    expect(
      (
        await safeFetch('https://openrouter.ai/first', {
          method: 'POST',
          body: 'x',
          allowlist: ['openrouter.ai'],
        })
      ).status,
    ).toBe(200);
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(fetchStub.mock.calls[1]![1]?.method).toBe('POST');
  });
});
