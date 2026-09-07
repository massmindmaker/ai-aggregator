/** Server-reviewed capability evidence, never a tariff source or route activation. */
export type ReviewedChatIdentity = Readonly<{
  modelSlug: string; modelType: string; upstreamId: string; upstreamModelId: string; adapterKey: string;
}>;
export type ReviewedChatProfile = ReviewedChatIdentity & Readonly<{
  version: 1;
  profileId: string;
  revision: number;
  adapterContract: 'openrouter-pinned-provider-chat-v1';
  contextWindowTokens: number;
  maxOutputTokens: number;
  endpointPolicy: Readonly<{ only: readonly string[]; allowFallbacks: false; requireParameters: true }>;
  usageContract: 'prompt-completion-total-with-optional-cached-prompt-v1';
  tariffContract: 'db-input-output-cents-per-1k-legacy-whole-cache-v1';
  evidence: readonly Readonly<{ url: string; checkedAt: string }>[];
}>;

const entries: ReviewedChatProfile[] = [{
  version: 1, profileId: 'openrouter-openai-gpt-4o-mini-chat-v1', revision: 1,
  modelSlug: 'openai/gpt-4o-mini', modelType: 'chat', upstreamId: 'openrouter',
  upstreamModelId: 'openai/gpt-4o-mini', adapterKey: 'openrouter',
  adapterContract: 'openrouter-pinned-provider-chat-v1', contextWindowTokens: 128000, maxOutputTokens: 16384,
  endpointPolicy: { only: ['openai'], allowFallbacks: false, requireParameters: true },
  usageContract: 'prompt-completion-total-with-optional-cached-prompt-v1',
  tariffContract: 'db-input-output-cents-per-1k-legacy-whole-cache-v1',
  evidence: [
    'https://openrouter.ai/api/v1/models/openai/gpt-4o-mini/endpoints',
    'https://openrouter.ai/docs/guides/overview/models',
    'https://openrouter.ai/docs/api_reference/parameters',
    'https://openrouter.ai/docs/guides/routing/provider-selection',
    'https://openrouter.ai/docs/cookbook/administration/usage-accounting',
  ].map(url => ({ url, checkedAt: '2026-09-07' })),
}];
const identityKeys = ['modelSlug', 'modelType', 'upstreamId', 'upstreamModelId', 'adapterKey'] as const;
const ids = new Set<string>();
const tuples = new Set<string>();
for (const p of entries) {
  const tuple = JSON.stringify(identityKeys.map(k => p[k]));
  if (!p.profileId || ids.has(p.profileId) || tuples.has(tuple)
    || p.version !== 1 || !Number.isSafeInteger(p.revision) || p.revision < 1
    || identityKeys.some(k => typeof p[k] !== 'string' || !p[k]) || p.modelType !== 'chat'
    || !Number.isSafeInteger(p.contextWindowTokens) || p.contextWindowTokens <= 0
    || !Number.isSafeInteger(p.maxOutputTokens) || p.maxOutputTokens <= 0 || p.maxOutputTokens > p.contextWindowTokens
    || p.adapterContract !== 'openrouter-pinned-provider-chat-v1'
    || p.endpointPolicy.only.length !== 1 || p.endpointPolicy.only[0] !== 'openai'
    || p.endpointPolicy.allowFallbacks !== false || p.endpointPolicy.requireParameters !== true
    || p.usageContract !== 'prompt-completion-total-with-optional-cached-prompt-v1'
    || p.tariffContract !== 'db-input-output-cents-per-1k-legacy-whole-cache-v1'
    || p.evidence.length === 0 || p.evidence.some(e => new URL(e.url).protocol !== 'https:' || !/^\d{4}-\d{2}-\d{2}$/.test(e.checkedAt))) {
    throw new Error('Invalid reviewed chat manifest');
  }
  ids.add(p.profileId); tuples.add(tuple);
  Object.freeze(p.endpointPolicy.only); Object.freeze(p.endpointPolicy);
  p.evidence.forEach(Object.freeze); Object.freeze(p.evidence); Object.freeze(p);
}
export const reviewedChatProfiles: readonly ReviewedChatProfile[] = Object.freeze(entries);
export function findReviewedChatProfile(identity: ReviewedChatIdentity): ReviewedChatProfile | null {
  return reviewedChatProfiles.find(p => identityKeys.every(k => p[k] === identity[k])) ?? null;
}
