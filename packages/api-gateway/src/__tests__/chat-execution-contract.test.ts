/**
 * P0 — "инструменты исчезают молча" (tools vanish silently).
 *
 * THE DEFECT
 * ----------
 * `routes/v1/chat.ts` (the legacy `/v1/chat/completions` route, and the route
 * the Agents Market worker reaches by default via AIAG_GATEWAY_URL) declared
 * `ChatBody` as only `{ model, messages, stream?, aiag_mode? }`. A request body
 * carrying `tools` / `tool_choice` therefore had those fields simply ignored:
 * the upstream adapter was invoked with the same argument set as a toolless
 * request, and the caller got a normal 200 completion containing no tool calls.
 *
 * The caller is an agent loop. It reads "no tool_calls in the response" as
 * "the model chose to answer in prose", finishes the turn, and settles the run
 * — a successful run with a silently wrong result. ECOSYSTEM-START-HERE
 * ("Неподдерживаемые параметры должны явно отклоняться до вызова провайдера, а
 * не исчезать") requires a refusal instead.
 *
 * WHAT THESE TESTS PIN
 * --------------------
 * 1. A 501 `UNSUPPORTED_EXECUTION_CONTRACT` — the same contract the stored
 *    route already returns for these fields (`hasUnsupportedFeature` in
 *    `billing/stored-chat-http-contract.ts`), so the refusal is uniform.
 * 2. ZERO provider calls. Not "fewer", not "the tools aren't forwarded" —
 *    `getUpstream` is never reached, so no adapter can be handed a contract it
 *    will drop. This is the assertion that fails on the pre-fix code: it
 *    returned 200 after a full upstream round-trip.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const spies = vi.hoisted(() => ({
  resolveModelWithOverride: vi.fn(),
  getUpstream: vi.fn(),
  assertPositiveBalance: vi.fn(),
  settleCharge: vi.fn(),
  incrementSpendCounters: vi.fn(),
  logRequest: vi.fn(),
  pickUpstream: vi.fn(),
}));

vi.mock('../lib/db', () => ({ sql: vi.fn() }));
vi.mock('../routing/resolver', () => ({
  resolveModelWithOverride: spies.resolveModelWithOverride,
}));
vi.mock('../upstreams/registry', () => ({ getUpstream: spies.getUpstream }));
vi.mock('../billing/settle', async () => ({
  ...(await vi.importActual<typeof import('../billing/settle')>('../billing/settle')),
  assertPositiveBalance: spies.assertPositiveBalance,
  settleCharge: spies.settleCharge,
}));
vi.mock('../billing/spend-counters', () => ({ incrementSpendCounters: spies.incrementSpendCounters }));
vi.mock('../logging/stream', () => ({ logRequest: spies.logRequest }));

import { chat, rejectUnsupportedExecutionFeatures } from '../routes/v1/chat';
import { applyAiagErrorHandler } from '../lib/errors';
import { fixedStoredChatHttpError } from '../billing/stored-chat-http-contract';

const CANDIDATE = {
  id: '11111111-1111-1111-1111-111111111111',
  provider: 'openrouter',
  upstream_id: 'up-1',
  upstream_model_id: 'openai/gpt-4o-mini',
  price_per_1k_input: 0.1,
  price_per_1k_output: 0.2,
  latency_p50_ms: 300,
  uptime: 99.9,
  ru_residency: false,
  markup: 1.8,
  priority: 100,
};

function testApp(): Hono {
  const app = new Hono();
  applyAiagErrorHandler(app);
  app.use('*', async (c, next) => {
    // The real server's pre-handler context (server.ts) so the route sees a
    // normally-authenticated, normally-minted request.
    c.set('apiKey' as never, {
      id: '30000000-0000-4000-8000-000000000001',
      org_id: '40000000-0000-4000-8000-000000000001',
      policies: {},
      rpm_limit: 1000,
      batch_rpm_limit: 1000,
      daily_usd_cap: null,
    } as never);
    c.set('requestId' as never, 'req-1' as never);
    c.set('settlementRequestId' as never, 'stl_1' as never);
    await next();
  });
  app.route('/v1/chat', chat);
  return app;
}

async function post(body: unknown): Promise<Response> {
  return testApp().fetch(
    new Request('http://gateway.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

const TOOL = {
  type: 'function',
  function: { name: 'list_models', description: 'list models', parameters: { type: 'object' } },
};

beforeEach(() => {
  vi.clearAllMocks();
  spies.resolveModelWithOverride.mockResolvedValue({
    slug: 'openai/gpt-4o-mini',
    type: 'chat',
    candidates: [CANDIDATE],
  });
  spies.pickUpstream.mockReturnValue(CANDIDATE);
  spies.getUpstream.mockReturnValue({
    chat: vi.fn(async () => ({
      id: 'cmpl-1',
      object: 'chat.completion',
      created: 1,
      model: 'openai/gpt-4o-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })),
  });
});

describe('legacy /v1/chat/completions refuses an unsupported execution contract (P0)', () => {
  it('501s a `tools` request instead of silently serving it without tools', async () => {
    const res = await post({
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [TOOL],
      tool_choice: 'auto',
    });

    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('UNSUPPORTED_EXECUTION_CONTRACT');
    // The refusal names what was refused, so the caller can act on it.
    expect(body.error.message).toContain('tools');
    expect(body.error.message).toContain('tool_choice');
  });

  it('never reaches the provider on that path — the actual P0 invariant', async () => {
    // Pre-fix this was a 200 with a real upstream call and no tool_calls.
    await post({
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [TOOL],
    });

    expect(spies.getUpstream).not.toHaveBeenCalled();
    expect(spies.resolveModelWithOverride).not.toHaveBeenCalled();
    expect(spies.assertPositiveBalance).not.toHaveBeenCalled();
    expect(spies.settleCharge).not.toHaveBeenCalled();
  });

  it('rejects tool_choice even with an empty tools array', async () => {
    // `tools: []` / `tool_choice: 'none'` are how a caller probes the contract.
    // A truthiness check would wave them through and keep the silent-drop
    // behaviour alive for exactly those probes.
    const res = await post({
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      tool_choice: 'none',
    });
    expect(res.status).toBe(501);
    expect(spies.getUpstream).not.toHaveBeenCalled();
  });

  it('rejects the deprecated function-calling aliases and the media contract too', async () => {
    for (const field of ['functions', 'function_call', 'parallel_tool_calls', 'modalities', 'audio', 'input_audio']) {
      spies.getUpstream.mockClear();
      const res = await post({
        model: 'openai/gpt-4o-mini',
        messages: [{ role: 'user', content: 'hello' }],
        [field]: field === 'functions' ? [{ name: 'f' }] : {},
      });
      expect(res.status, `${field} must be refused`).toBe(501);
      expect(spies.getUpstream, `${field} must not reach the provider`).not.toHaveBeenCalled();
    }
  });

  it('still serves a plain request unchanged', async () => {
    // The guard must not turn into a blanket rejection: this route is the
    // worker's default and toolless runs are its main traffic.
    const res = await post({
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 2000,
    });
    expect(res.status).toBe(200);
    expect(spies.getUpstream).toHaveBeenCalledTimes(1);
    expect(spies.settleCharge).toHaveBeenCalledTimes(1);
  });

  it('keeps model/messages validation ahead of the contract check', async () => {
    const res = await post({ messages: [{ role: 'user', content: 'hi' }], tools: [TOOL] });
    expect(res.status).toBe(400);
  });
});

describe('rejectUnsupportedExecutionFeatures', () => {
  it('throws 501 UNSUPPORTED_EXECUTION_CONTRACT listing the offending fields', () => {
    let error: unknown;
    try {
      rejectUnsupportedExecutionFeatures({ model: 'm', tools: [], tool_choice: 'auto' });
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ status: 501, code: 'UNSUPPORTED_EXECUTION_CONTRACT' });
    expect((error as Error).message).toContain('tools');
    expect((error as Error).message).toContain('tool_choice');
  });

  it('passes through a body with no execution-contract fields', () => {
    expect(() =>
      rejectUnsupportedExecutionFeatures({ model: 'm', messages: [], stream: false, aiag_mode: 'auto' }),
    ).not.toThrow();
  });

  it('ignores non-object bodies rather than throwing on shape', () => {
    expect(() => rejectUnsupportedExecutionFeatures(null)).not.toThrow();
    expect(() => rejectUnsupportedExecutionFeatures([])).not.toThrow();
    expect(() => rejectUnsupportedExecutionFeatures('tools')).not.toThrow();
  });
});

describe('stored and legacy routes agree on the contract', () => {
  it('legacy uses the same code the stored route already returns', async () => {
    // Wiring guard, in the spirit of billing-preflight.test.ts: a correct helper
    // wired into only ONE of the two routes is exactly how this defect lived for
    // a week. The stored route's own behaviour is covered by
    // stored-chat-http-contract.test.ts (hasUnsupportedFeature lists the same
    // fields); here we pin only that legacy speaks the same code, so a client
    // can branch on one contract instead of two.
    const res = await post({
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [TOOL],
    });
    const body = (await res.json()) as { error: { code: string } };
    const stored = fixedStoredChatHttpError('unsupported_execution_contract');
    const storedBody = stored.body as { error: { code: string } };
    expect(body.error.code).toBe(storedBody.error.code);
    expect(body.error.code).toBe('UNSUPPORTED_EXECUTION_CONTRACT');
    expect(res.status).toBe(stored.status);
  });
});
