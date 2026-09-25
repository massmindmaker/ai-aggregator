import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { transport } = vi.hoisted(() => ({ transport: vi.fn() }));
vi.mock('../upstreams/fetch-upstream', () => ({ fetchUpstream: transport }));

import { openRouterUpstream, AdmittedChatError } from '../upstreams/openrouter';
import { reviewedChatProfiles } from '../billing/reviewed-token-profiles';

const request = () => ({ modelId: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }], maxTokens: 10, endpointPolicy: reviewedChatProfiles[0]!.endpointPolicy, egressProxyUrl: 'http://proxy.test' });
const chunk = (overrides: Record<string, unknown> = {}) => ({ id: 'gen-1', object: 'chat.completion.chunk', created: 10, model: 'openai/gpt-4o-mini', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }], ...overrides });
const stream = (...values: unknown[]) => new Response(values.map(value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });

beforeEach(() => { vi.stubEnv('OPENROUTER_API_KEY', 'stream-test-key'); transport.mockReset(); transport.mockResolvedValue(stream(chunk(), { ...chunk(), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, { ...chunk(), choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('admitted OpenRouter chat stream', () => {
  it('pins stream options, policy, redirect and proxy transport', async () => {
    await openRouterUpstream.admittedChatStream!.execute(request());
    const [url, init, proxy] = transport.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.maxRedirects).toBe(0);
    expect(init.sse).toBe(true);
    expect(proxy).toBe('http://proxy.test');
    expect(JSON.parse(init.body)).toMatchObject({ stream: true, stream_options: { include_usage: true }, max_tokens: 10, provider: { only: ['openai'], allow_fallbacks: false, require_parameters: true } });
  });

  it('continues provider evidence after callback failure', async () => {
    const seen: unknown[] = [];
    const out = await openRouterUpstream.admittedChatStream!.execute(request(), async event => { seen.push(event); throw new Error('client gone'); });
    expect(seen).toHaveLength(1);
    expect(out.events).toHaveLength(3);
    expect(out.usage).toMatchObject({ promptTokens: 3, completionTokens: 1, totalTokens: 4 });
  });

  it.each([
    ['missing usage', [chunk(), { ...chunk(), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]],
    ['missing finish', [chunk(), { ...chunk(), choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }]],
    ['bad json', ['{bad']],
    ['duplicate usage', [chunk(), { ...chunk(), choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }, { ...chunk(), choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }]],
    ['content after finish', [chunk(), { ...chunk(), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, chunk()]],
  ])('rejects %s after dispatch', async (_name, values) => {
    transport.mockResolvedValueOnce(stream(...values));
    await expect(openRouterUpstream.admittedChatStream!.execute(request())).rejects.toBeInstanceOf(AdmittedChatError);
  });

  it('rejects unknown nested usage fields instead of silently normalizing them', async () => {
    transport.mockResolvedValueOnce(stream(
      chunk(),
      { ...chunk(), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      {
        ...chunk(),
        choices: [],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 1,
          total_tokens: 4,
          provider_cost: 123,
        },
      },
    ));
    await expect(
      openRouterUpstream.admittedChatStream!.execute(request()),
    ).rejects.toBeInstanceOf(AdmittedChatError);
  });

  it('rejects a canonical stored stream envelope above 1 MiB before returning it', async () => {
    const values: unknown[] = Array.from({ length: 4093 }, () =>
      chunk({ choices: [{ index: 0, delta: { content: 'x'.repeat(100) }, finish_reason: null }] }),
    );
    values.push(
      { ...chunk(), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      {
        ...chunk(),
        choices: [],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      },
    );
    transport.mockResolvedValueOnce(stream(...values));
    await expect(
      openRouterUpstream.admittedChatStream!.execute(request()),
    ).rejects.toBeInstanceOf(AdmittedChatError);
  });

  it('requires the terminal DONE marker', async () => {
    transport.mockResolvedValueOnce(new Response(
      `data: ${JSON.stringify(chunk())}\n\ndata: ${JSON.stringify({ ...chunk(), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: ${JSON.stringify({ ...chunk(), choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    ));
    await expect(openRouterUpstream.admittedChatStream!.execute(request())).rejects.toBeInstanceOf(AdmittedChatError);
  });
});
