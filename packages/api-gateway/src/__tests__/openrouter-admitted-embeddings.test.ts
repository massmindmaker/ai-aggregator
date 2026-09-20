import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { transport } = vi.hoisted(() => ({ transport: vi.fn() }));
vi.mock('../upstreams/fetch-upstream', () => ({ fetchUpstream: transport }));

import {
  AdmittedEmbeddingsError,
  openRouterUpstream,
} from '../upstreams/openrouter';
import { reviewedEmbeddingProfiles } from '../billing/reviewed-embedding-profiles';

const vector = () => Array.from({ length: 1536 }, (_, index) => index / 1000);
const request = () => ({
  modelId: 'openai/text-embedding-3-small',
  input: ['first', 'second'] as readonly string[],
  endpointPolicy: reviewedEmbeddingProfiles[0]!.endpointPolicy,
  egressProxyUrl: 'http://test-proxy:3128',
});
const payload = () => ({
  id: 'emb-1',
  object: 'list',
  model: 'openai/text-embedding-3-small',
  data: [
    { object: 'embedding', index: 0, embedding: vector(), vendor: 'private' },
    { object: 'embedding', index: 1, embedding: vector(), vendor: 'private' },
  ],
  usage: { prompt_tokens: 1000, total_tokens: 1000, cost: 99 },
  provider: 'private',
  cost: 99,
});
const execute = (value = request()) =>
  openRouterUpstream.admittedEmbeddings!.execute(value);

beforeEach(() => {
  vi.stubEnv('OPENROUTER_API_KEY', 'system-test-key');
  transport.mockReset();
  transport.mockResolvedValue(new Response(JSON.stringify(payload())));
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('admitted OpenRouter embeddings mechanics', () => {
  it('makes one pinned POST with float encoding, provider pin and no dimensions/BYOK', async () => {
    await execute();
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init, proxy] = transport.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/embeddings');
    expect(init.method).toBe('POST');
    expect(init.maxRedirects).toBe(0);
    expect(init.maxBufferedResponseBytes).toBe(1048576);
    expect(init.allowlist).toEqual(['openrouter.ai']);
    expect(init.headers.authorization).toBe('Bearer system-test-key');
    expect(proxy).toBe('http://test-proxy:3128');
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      model: 'openai/text-embedding-3-small',
      input: ['first', 'second'],
      encoding_format: 'float',
      provider: {
        only: ['openai'],
        allow_fallbacks: false,
        require_parameters: true,
      },
    });
    expect(body).not.toHaveProperty('dimensions');
  });

  it('returns only the public DTO and separately trusted provider id/usage', async () => {
    const result = await execute();
    expect(result.usage).toEqual({
      promptTokens: 1000,
      totalTokens: 1000,
      providerResponseId: 'emb-1',
    });
    expect(result.response).toEqual({
      object: 'list',
      model: 'openai/text-embedding-3-small',
      data: [
        { object: 'embedding', index: 0, embedding: vector() },
        { object: 'embedding', index: 1, embedding: vector() },
      ],
      usage: { prompt_tokens: 1000, total_tokens: 1000 },
    });
    expect(result.response).not.toHaveProperty('id');
    expect(result.response).not.toHaveProperty('provider');
  });

  it('uses null for an absent optional provider response id', async () => {
    const { id: _id, ...withoutId } = payload();
    transport.mockResolvedValueOnce(new Response(JSON.stringify(withoutId)));
    expect((await execute()).usage.providerResponseId).toBeNull();
  });

  it('rejects invalid request tuple/policy/input before transport', async () => {
    for (const change of [
      { modelId: 'alias' },
      { input: [] },
      { input: Array(17).fill('x') },
      { input: [''] },
      { input: [`${'😀'.repeat(2048)}x`] },
      { input: ['\ud800'] },
      { endpointPolicy: { only: ['azure'], allowFallbacks: false, requireParameters: true } },
      { byokKey: 'forbidden' },
    ]) {
      await expect(execute({ ...request(), ...change } as ReturnType<typeof request>))
        .rejects.toBeInstanceOf(AdmittedEmbeddingsError);
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it('requires exact count/order/dimension/model and bounded consistent usage', async () => {
    const variants = [
      { ...payload(), model: 'alias' },
      { ...payload(), data: payload().data.slice(0, 1) },
      { ...payload(), data: payload().data.map((item, index) => ({ ...item, index: 1 - index })) },
      { ...payload(), data: payload().data.map((item, index) => index === 0 ? { ...item, embedding: item.embedding.slice(1) } : item) },
      { ...payload(), usage: { prompt_tokens: 1000, total_tokens: 999 } },
      { ...payload(), usage: { prompt_tokens: 16385, total_tokens: 16385 } },
      { ...payload(), usage: { prompt_tokens: 1.5, total_tokens: 1.5 } },
      { ...payload(), id: null },
    ];
    for (const variant of variants) {
      transport.mockResolvedValueOnce(new Response(JSON.stringify(variant)));
      await expect(execute()).rejects.toBeInstanceOf(AdmittedEmbeddingsError);
    }
  });

  it('enforces the streamed 1 MiB response cap instead of trusting headers', async () => {
    transport.mockResolvedValueOnce(new Response('x'.repeat(1_048_577), {
      headers: { 'content-length': '1' },
    }));
    await expect(execute()).rejects.toBeInstanceOf(AdmittedEmbeddingsError);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('fails before transport when the system credential is absent', async () => {
    delete process.env.OPENROUTER_API_KEY;
    await expect(execute()).rejects.toThrow('model provider not configured');
    expect(transport).not.toHaveBeenCalled();
  });
});
