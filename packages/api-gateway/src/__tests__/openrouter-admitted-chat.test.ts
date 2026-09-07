import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { transport } = vi.hoisted(() => ({ transport: vi.fn() }));
vi.mock('../upstreams/fetch-upstream', () => ({ fetchUpstream: transport }));
import { openRouterUpstream, AdmittedChatError } from '../upstreams/openrouter';
import { reviewedChatProfiles } from '../billing/reviewed-token-profiles';
const request = () => ({ modelId: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }], maxTokens: 10000, endpointPolicy: reviewedChatProfiles[0]!.endpointPolicy, byokKey: 'test-key', egressProxyUrl: 'http://test-proxy:3128' });
const response = () => ({ id: 'gen-1', object: 'chat.completion', model: 'openai/gpt-4o-mini', created: 10, choices: [{ index: 0, message: { role: 'assistant', content: 'ok', reasoning: 'private', vendor_field: 'private' }, finish_reason: 'stop', native_finish_reason: 'private' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost: 999 }, provider: 'private', system_fingerprint: 'private', cost: 999 });
beforeEach(() => { transport.mockReset(); transport.mockResolvedValue(new Response(JSON.stringify(response()))); });
afterEach(() => { vi.unstubAllEnvs(); });
const execute = (req = request()) => openRouterUpstream.admittedChat!.execute(req);
describe('admitted OpenRouter non-stream mechanics', () => {
  it('emits only pinned JSON through vetted transport and propagates key/egress', async () => {
    await execute();
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init, proxy] = transport.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(JSON.parse(init.body)).toEqual({ model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }], stream: false, max_tokens: 10000, provider: { only: ['openai'], allow_fallbacks: false, require_parameters: true } });
    expect(init.maxRedirects).toBe(0);
    expect(init.headers.authorization).toBe('Bearer test-key'); expect(init.allowlist).toEqual(['openrouter.ai']); expect(proxy).toBe('http://test-proxy:3128');
  });
  it('returns only a validated public DTO and strict original usage', async () => {
    const out = await execute();
    expect(out).toEqual({ response: { id: 'gen-1', object: 'chat.completion', model: 'openai/gpt-4o-mini', created: 10, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }, usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5, cachedInputTokens: 0 } });
  });
  it.each(['prompt_tokens','completion_tokens','total_tokens'])('requires %s without coercion or fallback', async field => {
    for (const value of [undefined,null,-1,1.5,'3',Number.MAX_SAFE_INTEGER+1]) {
      const data = response(); (data.usage as Record<string,unknown>)[field] = value;
      transport.mockResolvedValueOnce(new Response(JSON.stringify(data)));
      await expect(execute()).rejects.toMatchObject({ code: 'INVALID_ADMITTED_RESPONSE' });
    }
  });
  it('rejects absent usage and inconsistent totals', async () => {
    for (const usage of [undefined, {}, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 6 }]) {
      transport.mockResolvedValueOnce(new Response(JSON.stringify({ ...response(), usage })));
      await expect(execute()).rejects.toBeInstanceOf(AdmittedChatError);
    }
  });
  it('only nested cache count gives proven discount; malformed present detail fails', async () => {
    for (const cached_tokens of [0,2]) {
      transport.mockResolvedValueOnce(new Response(JSON.stringify({ ...response(), usage: { ...response().usage, prompt_tokens_details: { cached_tokens }, cached_input_tokens: 3 } })));
      expect((await execute()).usage.cachedInputTokens).toBe(cached_tokens);
    }
    for (const details of [null,3,{ cached_tokens: null },{ cached_tokens: -1 },{ cached_tokens: 4 },{ cached_tokens: '1' }]) {
      transport.mockResolvedValueOnce(new Response(JSON.stringify({ ...response(), usage: { ...response().usage, prompt_tokens_details: details } })));
      await expect(execute()).rejects.toBeInstanceOf(AdmittedChatError);
    }
  });
  it('accepts legitimate null assistant text on content filtering', async () => {
    transport.mockResolvedValueOnce(new Response(JSON.stringify({ ...response(), choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'content_filter' }] })));
    expect((await execute()).response.choices[0]!.message.content).toBeNull();
  });
  it('validates tuple, cap, policy and plain text messages before network', async () => {
    const changes: object[] = [{ provider: { only: ['evil'] } },{ tools: [] },{ modelId: 'alias' },{ maxTokens: 16385 },{ maxTokens: 0 },{ maxTokens: 1.2 },{ maxTokens: Infinity },{ endpointPolicy: { only: ['openai'], allowFallbacks: true, requireParameters: true } },{ messages: [] },{ messages: [{ role: 'tool', content: 'hi' }] },{ messages: [{ role: 'user', content: [] }] },{ messages: [{ role: 'assistant', content: 'hi', tool_calls: [] }] }];
    for (const change of changes) await expect(execute({ ...request(), ...change })).rejects.toMatchObject({ code: 'INVALID_ADMITTED_REQUEST' });
    expect(transport).not.toHaveBeenCalled();
  });
  it('rejects malformed public response shape or tool invocation', async () => {
    for (const change of [{ id: '' },{ created: -1 },{ model: '' },{ choices: [] },{ choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'tool_calls' }] }]) {
      transport.mockResolvedValueOnce(new Response(JSON.stringify({ ...response(), ...change })));
      await expect(execute()).rejects.toBeInstanceOf(AdmittedChatError);
    }
  });
});

it('missing nested cached count never trusts a legacy top-level cache hint', async () => {
  for (const extra of [{ cached_input_tokens: 3 }, { prompt_tokens_details: {} }]) {
    transport.mockResolvedValueOnce(new Response(JSON.stringify({ ...response(), usage: { ...response().usage, ...extra } })));
    expect((await execute()).usage.cachedInputTokens).toBe(0);
  }
});
it('system credential fallback remains available and missing credentials fail before transport', async () => {
  vi.stubEnv('OPENROUTER_API_KEY','system-test-key');
  const { byokKey: _ignored, ...req } = request();
  await openRouterUpstream.admittedChat!.execute(req);
  expect(transport.mock.calls[0]![1].headers.authorization).toBe('Bearer system-test-key');
  delete process.env.OPENROUTER_API_KEY; transport.mockClear();
  await expect(openRouterUpstream.admittedChat!.execute(req)).rejects.toThrow('model provider not configured');
  expect(transport).not.toHaveBeenCalled();
});

it('legacy chat keeps its existing model/body and missing-usage behavior', async () => {
  transport.mockResolvedValueOnce(new Response(JSON.stringify({ ...response(), usage: undefined })));
  const result = await openRouterUpstream.chat({ modelId: 'legacy/alias', messages: [{ role: 'user', content: [{ type: 'text', text: 'legacy' }] }], temperature: 0.3, byokKey: 'legacy-test-key' });
  const body = JSON.parse(transport.mock.calls[0]![1].body);
  expect(body.model).toBe('legacy/alias'); expect(body.temperature).toBe(0.3); expect(body.provider).toBeUndefined();
  expect(result.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
});

it('permits empty tool metadata but rejects an actual invocation even with stop finish', async () => {
  for (const tool_calls of [null, []]) {
    transport.mockResolvedValueOnce(new Response(JSON.stringify({ ...response(), choices: [{ index: 0, message: { role: 'assistant', content: 'ok', tool_calls, function_call: null }, finish_reason: 'stop' }] })));
    expect((await execute()).response.choices[0]!.message).toEqual({ role: 'assistant', content: 'ok' });
  }
  transport.mockResolvedValueOnce(new Response(JSON.stringify({ ...response(), choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, finish_reason: 'stop' }] })));
  await expect(execute()).rejects.toBeInstanceOf(AdmittedChatError);
});
