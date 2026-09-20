import { describe, expect, it, vi } from 'vitest';
import { prepareStoredEmbeddingQuote } from '../billing/embedding-candidate-quote';
import type { ResolvedModel } from '../routing/resolver';
import type { UpstreamAdapter } from '../upstreams/interface';

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const mechanics = Object.freeze({
  contract: 'openrouter-pinned-provider-embeddings-v1' as const,
  execute: vi.fn(async () => {
    throw new Error('quote must not execute');
  }),
});
const adapter: UpstreamAdapter = {
  admittedEmbeddings: mechanics,
  chat: async () => {
    throw new Error('unused');
  },
};
function model(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
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
        latency_p50_ms: 25,
        uptime: 0.99,
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
    ...overrides,
  };
}
const prepare = (resolved = model()) =>
  prepareStoredEmbeddingQuote({
    model: resolved,
    requestedMode: 'cheapest',
    policy: {},
    inputCount: 2,
    getAdapter: () => adapter,
  });

describe('stored embedding quote', () => {
  it('uses exact DB decimals and freezes the one admitted candidate', () => {
    const result = prepare();
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error(result.code);
    expect(result.authorizedMaxCredits).toBe(41n);
    expect(result.candidates).toHaveLength(1);
    expect(result.quoteSnapshot).toEqual({
      version: 1,
      formulaVersion: 'db-input-output-cents-per-1k-legacy-whole-cache-v1',
      requestedMode: 'cheapest',
      effectiveMode: 'cheapest',
      authorizedMaxCredits: '41',
      candidates: [
        {
          modelSlug: 'openai/text-embedding-3-small',
          modelType: 'embedding',
          upstreamId: 'openrouter',
          upstreamModelId: 'openai/text-embedding-3-small',
          adapterKey: 'openrouter',
          modelUpstreamId: uuid(3),
          profileId: 'openrouter-openai-text-embedding-3-small-embeddings-v1',
          profileRevision: 1,
          adapterContract: 'openrouter-pinned-provider-embeddings-v1',
          endpointPolicy: {
            only: ['openai'],
            allowFallbacks: false,
            requireParameters: true,
          },
          contextWindowTokens: 8192,
          inputCount: 2,
          dimensions: 1536,
          encodingFormat: 'float',
          prices: {
            inputCentsPer1k: '0.002',
            outputCentsPer1k: '0',
            markup: '1.25',
          },
          maxCredits: '41',
        },
      ],
    });
    expect(Object.isFrozen(result.quoteSnapshot.candidates)).toBe(true);
    expect(mechanics.execute).not.toHaveBeenCalled();
  });

  it('checks the resolved model type before manifest lookup', () => {
    expect(prepare(model({ type: 'chat' })).status).toBe('unavailable');
  });

  it('selects exactly one eligible winner and never preserves fallback candidates', () => {
    const duplicate = {
      ...model().candidates[0]!,
      latency_p50_ms: 1,
      price_per_1k_input: 1,
      billing: {
        ...model().candidates[0]!.billing!,
        modelUpstreamId: uuid(4),
      },
    };
    const result = prepare(model({ candidates: [model().candidates[0]!, duplicate] }));
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error(result.code);
    expect(result.candidates).toHaveLength(1);
    expect(result.quoteSnapshot.candidates).toHaveLength(1);
    expect(result.candidates[0].billing.modelUpstreamId).toBe(uuid(4));
  });

  it('fails closed on input bounds, policy, mechanics, zero reserve or invalid billing', () => {
    const base = {
      model: model(),
      requestedMode: 'auto' as const,
      policy: {},
      inputCount: 1,
      getAdapter: () => adapter,
    };
    expect(prepareStoredEmbeddingQuote({ ...base, inputCount: 0 }).status).toBe('unavailable');
    expect(prepareStoredEmbeddingQuote({ ...base, inputCount: 17 }).status).toBe('unavailable');
    expect(prepareStoredEmbeddingQuote({ ...base, policy: { blocked_providers: ['openai'] } }).status).toBe('unavailable');
    expect(prepareStoredEmbeddingQuote({ ...base, getAdapter: () => ({ chat: adapter.chat }) }).status).toBe('unavailable');
    expect(prepareStoredEmbeddingQuote({ ...base, model: model({ candidates: [{ ...model().candidates[0]!, billing: undefined }] }) }).status).toBe('unavailable');
    expect(prepareStoredEmbeddingQuote({ ...base, model: model({ candidates: [{ ...model().candidates[0]!, billing: { ...model().candidates[0]!.billing!, prices: { inputCentsPer1k: '0', outputCentsPer1k: '0', markup: '1' } } }] }) }).status).toBe('unavailable');
  });
});
