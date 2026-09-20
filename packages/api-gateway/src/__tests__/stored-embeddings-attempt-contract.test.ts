import { describe, expect, it } from 'vitest';
import {
  captureStoredEmbeddingsEvidence,
  parseStoredEmbeddingsBody,
  validateStoredEmbeddingsIdentity,
} from '../billing/stored-embeddings-attempt-contract';
import type { FrozenEmbeddingCandidate } from '../billing/embedding-candidate-quote';
import { reviewedEmbeddingProfiles } from '../billing/reviewed-embedding-profiles';

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const candidate: FrozenEmbeddingCandidate = Object.freeze({
  modelSlug: 'openai/text-embedding-3-small',
  modelType: 'embedding',
  upstreamId: 'openrouter',
  upstreamModelId: 'openai/text-embedding-3-small',
  adapterKey: 'openrouter',
  provider: 'openai',
  ruResidency: false,
  priority: 1,
  egressProxyUrl: null,
  profile: reviewedEmbeddingProfiles[0]!,
  billing: Object.freeze({
    modelUpstreamId: uuid(3),
    prices: Object.freeze({
      inputCentsPer1k: '0.002',
      outputCentsPer1k: '0',
      markup: '1.25',
    }),
  }),
  inputCount: 2,
  dimensions: 1536,
  encodingFormat: 'float',
  maxCredits: 41n,
});
const vector = () => Array.from({ length: 1536 }, (_, index) => index / 1000);
const output = () => ({
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
    providerResponseId: 'emb-1',
  },
});

describe('stored embeddings request contract', () => {
  it('normalizes scalar/defaults while preserving exact whitespace and order', () => {
    expect(parseStoredEmbeddingsBody({
      model: candidate.modelSlug,
      input: '  keep\n',
    }, candidate.modelSlug)).toEqual({
      modelSlug: candidate.modelSlug,
      input: ['  keep\n'],
      encodingFormat: 'float',
      dimensions: 1536,
    });
    expect(parseStoredEmbeddingsBody({
      model: candidate.modelSlug,
      input: ['second', 'first'],
      encoding_format: 'float',
      dimensions: 1536,
    }, candidate.modelSlug).input).toEqual(['second', 'first']);
  });

  it('enforces 16 inputs, 8192 UTF-8 bytes, well-formed Unicode and exact keys', () => {
    const accepted = '😀'.repeat(2048);
    expect(parseStoredEmbeddingsBody({ model: candidate.modelSlug, input: accepted }, candidate.modelSlug).input[0]).toBe(accepted);
    for (const body of [
      { model: candidate.modelSlug, input: '' },
      { model: candidate.modelSlug, input: [] },
      { model: candidate.modelSlug, input: Array(17).fill('x') },
      { model: candidate.modelSlug, input: `${accepted}x` },
      { model: candidate.modelSlug, input: '\ud800' },
      { model: candidate.modelSlug, input: [[1, 2]] },
      { model: candidate.modelSlug, input: 'x', dimensions: 12 },
      { model: candidate.modelSlug, input: 'x', encoding_format: 'base64' },
      { model: candidate.modelSlug, input: 'x', user: 'override' },
    ]) {
      expect(() => parseStoredEmbeddingsBody(body, candidate.modelSlug)).toThrow();
    }
  });

  it('validates normalized financial identity with fixed cache factor', () => {
    expect(validateStoredEmbeddingsIdentity({
      orgId: uuid(1).toUpperCase(),
      apiKeyId: uuid(2),
      clientRequestId: 'trace',
      declaredSessionId: 'Original.SID',
      preDispatchDeadlineAt: '2026-09-20T12:00:00Z',
    })).toEqual({
      orgId: uuid(1),
      apiKeyId: uuid(2),
      clientRequestId: 'trace',
      declaredSessionId: 'Original.SID',
      preDispatchDeadlineAt: '2026-09-20T12:00:00.000000Z',
    });
  });
});

describe('stored embeddings evidence', () => {
  it('freezes exact trusted usage and applies half-up input-only arithmetic', () => {
    const evidence = captureStoredEmbeddingsEvidence(
      output(),
      candidate,
      uuid(10),
      uuid(11),
    );
    expect(evidence.actualCostCredits).toBe(3n);
    expect(evidence.usageSnapshot).toEqual({
      version: 1,
      usageContract: 'openrouter-pinned-provider-embeddings-v1',
      billingRequestId: uuid(10),
      attemptId: uuid(11),
      upstreamId: 'openrouter',
      upstreamModelId: 'openai/text-embedding-3-small',
      adapterKey: 'openrouter',
      modelSlug: 'openai/text-embedding-3-small',
      modelUpstreamId: uuid(3),
      profileId: 'openrouter-openai-text-embedding-3-small-embeddings-v1',
      profileRevision: 1,
      providerResponseId: 'emb-1',
      reportedModel: 'openai/text-embedding-3-small',
      inputCount: 2,
      dimensions: 1536,
      encodingFormat: 'float',
      usage: {
        promptTokens: 1000,
        completionTokens: 0,
        totalTokens: 1000,
        cachedInputTokens: 0,
      },
      formulaVersion: 'db-input-output-cents-per-1k-legacy-whole-cache-v1',
    });
    expect(Object.isFrozen(evidence.usageSnapshot)).toBe(true);
  });

  it('rejects count/order/dimension/model/usage/provider-id and extra-key drift', () => {
    const cases: unknown[] = [];
    const wrongCount = output(); wrongCount.response.data.pop(); cases.push(wrongCount);
    const wrongIndex = output(); wrongIndex.response.data[1]!.index = 0; cases.push(wrongIndex);
    const wrongDimension = output(); wrongDimension.response.data[0]!.embedding.pop(); cases.push(wrongDimension);
    const wrongModel = output(); wrongModel.response.model = 'alias'; cases.push(wrongModel);
    const wrongUsage = output(); wrongUsage.usage.totalTokens = 999; cases.push(wrongUsage);
    const missingUsage = output(); delete (missingUsage.usage as Partial<typeof missingUsage.usage>).providerResponseId; cases.push(missingUsage);
    const extra = output(); (extra.response as Record<string, unknown>).cost = 1; cases.push(extra);
    for (const value of cases) {
      expect(() => captureStoredEmbeddingsEvidence(
        value as ReturnType<typeof output>, candidate, uuid(10), uuid(11),
      )).toThrow();
    }
  });
});
