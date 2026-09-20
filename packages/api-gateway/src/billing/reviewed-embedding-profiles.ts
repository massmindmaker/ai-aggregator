/** Server-reviewed capability evidence, never a tariff source or route activation. */
export type ReviewedEmbeddingIdentity = Readonly<{
  modelSlug: string; modelType: 'embedding'; upstreamId: string; upstreamModelId: string; adapterKey: string;
}>;
export type ReviewedEmbeddingProfile = ReviewedEmbeddingIdentity & Readonly<{
  version: 1;
  profileId: string;
  revision: number;
  adapterContract: 'openrouter-pinned-provider-embeddings-v1';
  contextWindowTokens: number;
  dimensions: number;
  maxInputs: number;
  endpointPolicy: Readonly<{ only: readonly string[]; allowFallbacks: false; requireParameters: true }>;
  usageContract: 'prompt-total-embeddings-v1';
  tariffContract: 'db-input-output-cents-per-1k-legacy-whole-cache-v1';
  evidence: readonly Readonly<{ url: string; checkedAt: string }>[];
}>;

const entries: ReviewedEmbeddingProfile[] = [{
  version: 1, profileId: 'openrouter-openai-text-embedding-3-small-embeddings-v1', revision: 1,
  modelSlug: 'openai/text-embedding-3-small', modelType: 'embedding', upstreamId: 'openrouter',
  upstreamModelId: 'openai/text-embedding-3-small', adapterKey: 'openrouter',
  adapterContract: 'openrouter-pinned-provider-embeddings-v1', contextWindowTokens: 8192,
  dimensions: 1536, maxInputs: 16,
  endpointPolicy: { only: ['openai'], allowFallbacks: false, requireParameters: true },
  usageContract: 'prompt-total-embeddings-v1',
  tariffContract: 'db-input-output-cents-per-1k-legacy-whole-cache-v1',
  evidence: [
    'https://openrouter.ai/api/v1/models/openai/text-embedding-3-small/endpoints',
    'https://openrouter.ai/docs/api/api-reference/embeddings/submit-an-embedding-request',
  ].map(url => ({ url, checkedAt: '2026-09-20' })),
}];
const identityKeys = ['modelSlug', 'modelType', 'upstreamId', 'upstreamModelId', 'adapterKey'] as const;
const ids = new Set<string>();
const tuples = new Set<string>();
for (const p of entries) {
  const tuple = JSON.stringify(identityKeys.map(k => p[k]));
  if (!p.profileId || ids.has(p.profileId) || tuples.has(tuple)
    || p.version !== 1 || !Number.isSafeInteger(p.revision) || p.revision < 1
    || identityKeys.some(k => typeof p[k] !== 'string' || !p[k]) || p.modelType !== 'embedding'
    || !Number.isSafeInteger(p.contextWindowTokens) || p.contextWindowTokens <= 0
    || !Number.isSafeInteger(p.dimensions) || p.dimensions <= 0 || p.dimensions > p.contextWindowTokens
    || !Number.isSafeInteger(p.maxInputs) || p.maxInputs <= 0
    || p.adapterContract !== 'openrouter-pinned-provider-embeddings-v1'
    || p.endpointPolicy.only.length !== 1 || p.endpointPolicy.only[0] !== 'openai'
    || p.endpointPolicy.allowFallbacks !== false || p.endpointPolicy.requireParameters !== true
    || p.usageContract !== 'prompt-total-embeddings-v1'
    || p.tariffContract !== 'db-input-output-cents-per-1k-legacy-whole-cache-v1'
    || p.evidence.length === 0 || p.evidence.some(e => new URL(e.url).protocol !== 'https:' || !/^\d{4}-\d{2}-\d{2}$/.test(e.checkedAt))) {
    throw new Error('Invalid reviewed embedding manifest');
  }
  ids.add(p.profileId); tuples.add(tuple);
  Object.freeze(p.endpointPolicy.only); Object.freeze(p.endpointPolicy);
  p.evidence.forEach(Object.freeze); Object.freeze(p.evidence); Object.freeze(p);
}
export const reviewedEmbeddingProfiles: readonly ReviewedEmbeddingProfile[] = Object.freeze(entries);
export function findReviewedEmbeddingProfile(identity: ReviewedEmbeddingIdentity): ReviewedEmbeddingProfile | null {
  return reviewedEmbeddingProfiles.find(p => identityKeys.every(k => p[k] === identity[k])) ?? null;
}
