import { describe, expect, it } from 'vitest';
import {
  findReviewedEmbeddingProfile,
  reviewedEmbeddingProfiles,
} from '../billing/reviewed-embedding-profiles';

describe('reviewed embedding manifest', () => {
  it('contains only the frozen OpenRouter/OpenAI capability tuple', () => {
    expect(reviewedEmbeddingProfiles).toHaveLength(1);
    expect(reviewedEmbeddingProfiles[0]).toMatchObject({
      version: 1,
      profileId: 'openrouter-openai-text-embedding-3-small-embeddings-v1',
      revision: 1,
      modelSlug: 'openai/text-embedding-3-small',
      modelType: 'embedding',
      upstreamId: 'openrouter',
      upstreamModelId: 'openai/text-embedding-3-small',
      adapterKey: 'openrouter',
      adapterContract: 'openrouter-pinned-provider-embeddings-v1',
      contextWindowTokens: 8192,
      dimensions: 1536,
      maxInputs: 16,
      endpointPolicy: {
        only: ['openai'],
        allowFallbacks: false,
        requireParameters: true,
      },
      usageContract: 'prompt-total-embeddings-v1',
      tariffContract: 'db-input-output-cents-per-1k-legacy-whole-cache-v1',
    });
    expect(Object.isFrozen(reviewedEmbeddingProfiles[0])).toBe(true);
  });

  it('matches all actual identity fields and rejects chat/alias drift', () => {
    const identity = {
      modelSlug: 'openai/text-embedding-3-small',
      modelType: 'embedding' as const,
      upstreamId: 'openrouter',
      upstreamModelId: 'openai/text-embedding-3-small',
      adapterKey: 'openrouter',
    };
    expect(findReviewedEmbeddingProfile(identity)).toBe(reviewedEmbeddingProfiles[0]);
    expect(findReviewedEmbeddingProfile({ ...identity, modelSlug: 'alias' })).toBeNull();
    expect(findReviewedEmbeddingProfile({ ...identity, adapterKey: 'legacy' })).toBeNull();
  });
});
