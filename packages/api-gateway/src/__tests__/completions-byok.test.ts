import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthenticatedApiKey } from '../middleware/auth-plan04';

const seams = vi.hoisted(() => ({
  transport: vi.fn(),
  resolveModel: vi.fn(),
  settleCharge: vi.fn(),
  assertPositiveBalance: vi.fn(),
  incrementSpendCounters: vi.fn(),
  logRequest: vi.fn(),
}));

vi.mock('../upstreams/fetch-upstream', () => ({ fetchUpstream: seams.transport }));
vi.mock('../routing/resolver', () => ({ resolveModelWithOverride: seams.resolveModel }));
vi.mock('../billing/settle', () => ({
  settleCharge: seams.settleCharge,
  assertPositiveBalance: seams.assertPositiveBalance,
}));
vi.mock('../billing/spend-counters', () => ({ incrementSpendCounters: seams.incrementSpendCounters }));
vi.mock('../logging/stream', () => ({ logRequest: seams.logRequest }));

import { completions } from '../routes/v1/completions';
import { openRouterUpstream } from '../upstreams/openrouter';
import { calcByokFeeCredits } from '../lib/pricing';

const callerKey = 'caller-key-only-for-test';
const platformKey = 'platform-key-only-for-test';
const primary = {
  id: 'candidate-primary',
  upstream_id: 'candidate-primary',
  provider: 'openrouter',
  upstream_model_id: 'openai/gpt-4o-mini',
  price_per_1k_input: 99,
  price_per_1k_output: 99,
  latency_p50_ms: 10,
  uptime: 1,
  ru_residency: false,
  markup: 9,
};
const secondary = { ...primary, id: 'candidate-secondary', upstream_id: 'candidate-secondary', provider: 'groq' };
const apiKey: AuthenticatedApiKey = {
  id: 'key-completions-byok',
  org_id: 'org-completions-byok',
  policies: {},
  rpm_limit: 60,
  daily_usd_cap: null,
  batch_rpm_limit: 10,
};

function app(): Hono {
  const gateway = new Hono();
  gateway.use('*', async (c, next) => {
    c.set('apiKey' as never, apiKey as never);
    c.set('requestId' as never, 'request-completions-byok' as never);
    await next();
  });
  gateway.route('/v1/completions', completions);
  return gateway;
}

async function request(): Promise<Response> {
  return app().request('http://gateway.test/v1/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-upstream-key': callerKey },
    body: JSON.stringify({ model: 'test-model', prompt: 'hello' }),
  });
}

beforeEach(() => {
  vi.stubEnv('OPENROUTER_API_KEY', platformKey);
  seams.resolveModel.mockReset();
  seams.resolveModel.mockResolvedValue({ candidates: [primary, secondary] });
  seams.settleCharge.mockReset();
  seams.settleCharge.mockResolvedValue(undefined);
  seams.assertPositiveBalance.mockReset();
  seams.incrementSpendCounters.mockReset();
  seams.incrementSpendCounters.mockResolvedValue(undefined);
  seams.logRequest.mockReset();
  seams.logRequest.mockResolvedValue(undefined);
  seams.transport.mockReset();
  seams.transport.mockResolvedValue(new Response(JSON.stringify({
    id: 'completion-1', object: 'chat.completion', created: 1,
    model: primary.upstream_model_id,
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  })));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('legacy /v1/completions header-BYOK propagation', () => {
  it('passes the caller key to the real adapter, dispatches once, and charges only the BYOK fee', async () => {
    const adapter = vi.spyOn(openRouterUpstream, 'chat');

    const response = await request();

    expect(response.status).toBe(200);
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(adapter).toHaveBeenCalledWith(expect.objectContaining({ byokKey: callerKey }));
    expect(seams.transport).toHaveBeenCalledTimes(1);
    expect(seams.transport.mock.calls[0]![1].headers.authorization).toBe(`Bearer ${callerKey}`);
    expect(seams.assertPositiveBalance).not.toHaveBeenCalled();
    expect(seams.settleCharge).toHaveBeenCalledWith(expect.objectContaining({
      costCredits: calcByokFeeCredits(),
    }));
    expect(seams.incrementSpendCounters).toHaveBeenCalledWith(expect.objectContaining({
      byok: true,
      upstreamCents: 0,
      costCredits: calcByokFeeCredits(),
    }));
  });

  it('does not fail over or settle after a provider failure', async () => {
    const adapter = vi.spyOn(openRouterUpstream, 'chat');
    seams.transport.mockResolvedValueOnce(new Response('invalid caller key', { status: 401 }));

    const response = await request();

    expect(response.status).toBe(500);
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(seams.transport).toHaveBeenCalledTimes(1);
    expect(seams.assertPositiveBalance).not.toHaveBeenCalled();
    expect(seams.settleCharge).not.toHaveBeenCalled();
    expect(seams.incrementSpendCounters).not.toHaveBeenCalled();
  });
});
