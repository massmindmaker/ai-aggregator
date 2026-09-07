import { findReviewedChatProfile, type ReviewedChatProfile } from './reviewed-token-profiles';
import { quoteChatMaximum } from './token-quote';
import { parseCandidateBillingFacts, pickUpstream, type ApiKeyPolicies, type CandidateBillingFacts, type Mode } from '../routing/engine';
import type { ResolvedModel } from '../routing/resolver';
import type { UpstreamAdapter } from '../upstreams/interface';

export type FrozenChatCandidate = Readonly<{
  modelSlug: string; modelType: 'chat'; upstreamId: string; upstreamModelId: string; adapterKey: string;
  provider: string; ruResidency: boolean; priority: number | undefined; egressProxyUrl: string | null | undefined;
  profile: ReviewedChatProfile; billing: CandidateBillingFacts; maxOutputTokens: number; maxCredits: bigint;
}>;
export type StoredChatQuoteSnapshot = Readonly<{
  version: 1;
  formulaVersion: 'db-input-output-cents-per-1k-legacy-whole-cache-v1';
  requestedMode: Mode;
  effectiveMode: Mode;
  authorizedMaxCredits: string;
  candidates: readonly Readonly<{
    modelSlug: string; modelType: 'chat'; upstreamId: string; upstreamModelId: string; adapterKey: string;
    modelUpstreamId: string; profileId: string; profileRevision: number; adapterContract: ReviewedChatProfile['adapterContract'];
    endpointPolicy: ReviewedChatProfile['endpointPolicy']; contextWindowTokens: number; maxOutputTokens: number;
    prices: CandidateBillingFacts['prices']; maxCredits: string;
  }>[];
}>;
export type StoredChatQuoteResult = Readonly<{
  status: 'ready'; candidates: readonly FrozenChatCandidate[]; authorizedMaxCredits: bigint; quoteSnapshot: StoredChatQuoteSnapshot;
}> | Readonly<{ status: 'unavailable'; code: 'STORED_CHAT_UNAVAILABLE' }>
  | Readonly<{ status: 'bad_request'; code: 'INVALID_MAX_TOKENS' }>;
const unavailable = Object.freeze({ status: 'unavailable', code: 'STORED_CHAT_UNAVAILABLE' } as const);
const positiveSafe = (n: number) => Number.isSafeInteger(n) && n > 0;

/** Pure preparation only: no admission, provider call, retries, credentials or prompts. */
export function prepareStoredChatQuote(args: Readonly<{
  model: ResolvedModel;
  requestedMode: Mode;
  policy: Readonly<ApiKeyPolicies>;
  clientMaxTokens?: number;
  defaultMaxOutputTokens: number;
  getAdapter: (key: string) => UpstreamAdapter;
}>): StoredChatQuoteResult {
  if (args.clientMaxTokens !== undefined && !positiveSafe(args.clientMaxTokens)) {
    return Object.freeze({ status: 'bad_request', code: 'INVALID_MAX_TOKENS' });
  }
  if (!positiveSafe(args.defaultMaxOutputTokens)) return unavailable;
  const requested = args.clientMaxTokens ?? args.defaultMaxOutputTokens;
  const mode = args.policy.forbid_non_ru ? 'ru-only' : args.requestedMode;
  if (!['auto','fastest','cheapest','balanced','ru-only'].includes(mode)) return unavailable;
  const eligible: Array<{ ranking: ResolvedModel['candidates'][number]; frozen: FrozenChatCandidate }> = [];
  for (const candidate of args.model.candidates) {
    const profile = findReviewedChatProfile({ modelSlug: args.model.slug, modelType: args.model.type,
      upstreamId: candidate.upstream_id, upstreamModelId: candidate.upstream_model_id, adapterKey: candidate.id });
    if (!profile) continue;
    if (args.policy.allowed_providers?.length && !args.policy.allowed_providers.includes(candidate.provider)) continue;
    if (args.policy.blocked_providers?.includes(candidate.provider) || (mode === 'ru-only' && !candidate.ru_residency)) continue;
    try {
      const mechanics = args.getAdapter(profile.adapterKey)?.admittedChat;
      if (mechanics?.contract !== profile.adapterContract || typeof mechanics.execute !== 'function') continue;
    } catch { continue; }
    const billing = parseCandidateBillingFacts(candidate.billing);
    if (!billing) return unavailable;
    const maxOutputTokens = Math.min(requested, profile.contextWindowTokens, profile.maxOutputTokens);
    let maxCredits: bigint;
    try { maxCredits = quoteChatMaximum(billing.prices, profile.contextWindowTokens, maxOutputTokens); }
    catch { return unavailable; }
    if (maxCredits === 0n) return unavailable;
    const frozen: FrozenChatCandidate = Object.freeze({ modelSlug: profile.modelSlug, modelType: 'chat', upstreamId: profile.upstreamId,
      upstreamModelId: profile.upstreamModelId, adapterKey: profile.adapterKey, provider: candidate.provider, ruResidency: candidate.ru_residency,
      priority: candidate.priority, egressProxyUrl: candidate.egress_proxy, profile, billing, maxOutputTokens, maxCredits });
    eligible.push({ ranking: { ...candidate }, frozen });
  }
  if (!eligible.length) return unavailable;
  // All policy filters have already run. Never re-expand from original candidates.
  const winner = pickUpstream(eligible.map(e => e.ranking), mode === 'ru-only' ? 'balanced' : mode, {});
  const preferred = eligible.find(e => e.ranking === winner)!;
  const candidates = Object.freeze([preferred, ...eligible.filter(e => e !== preferred)].map(e => e.frozen));
  const authorizedMaxCredits = candidates.reduce((max, c) => c.maxCredits > max ? c.maxCredits : max, 0n);
  const quoteSnapshot: StoredChatQuoteSnapshot = Object.freeze({ version: 1,
    formulaVersion: 'db-input-output-cents-per-1k-legacy-whole-cache-v1', requestedMode: args.requestedMode, effectiveMode: mode,
    authorizedMaxCredits: authorizedMaxCredits.toString(),
    candidates: Object.freeze(candidates.map(c => Object.freeze({ modelSlug: c.modelSlug, modelType: c.modelType, upstreamId: c.upstreamId,
      upstreamModelId: c.upstreamModelId, adapterKey: c.adapterKey, modelUpstreamId: c.billing.modelUpstreamId,
      profileId: c.profile.profileId, profileRevision: c.profile.revision, adapterContract: c.profile.adapterContract,
      endpointPolicy: c.profile.endpointPolicy, contextWindowTokens: c.profile.contextWindowTokens, maxOutputTokens: c.maxOutputTokens,
      prices: c.billing.prices, maxCredits: c.maxCredits.toString() }))),
  });
  return Object.freeze({ status: 'ready', candidates, authorizedMaxCredits, quoteSnapshot });
}
