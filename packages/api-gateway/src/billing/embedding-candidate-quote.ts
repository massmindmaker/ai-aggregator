import {
  findReviewedEmbeddingProfile,
  type ReviewedEmbeddingProfile,
} from './reviewed-embedding-profiles';
import { quoteEmbeddingMaximum } from './token-quote';
import {
  parseCandidateBillingFacts,
  pickUpstream,
  type ApiKeyPolicies,
  type CandidateBillingFacts,
  type Mode,
} from '../routing/engine';
import type { ResolvedModel } from '../routing/resolver';
import type { UpstreamAdapter } from '../upstreams/interface';

export type FrozenEmbeddingCandidate = Readonly<{
  modelSlug: string;
  modelType: 'embedding';
  upstreamId: string;
  upstreamModelId: string;
  adapterKey: string;
  provider: string;
  ruResidency: boolean;
  priority: number | undefined;
  egressProxyUrl: string | null | undefined;
  profile: ReviewedEmbeddingProfile;
  billing: CandidateBillingFacts;
  inputCount: number;
  dimensions: 1536;
  encodingFormat: 'float';
  maxCredits: bigint;
}>;

export type StoredEmbeddingQuoteSnapshot = Readonly<{
  version: 1;
  formulaVersion: 'db-input-output-cents-per-1k-legacy-whole-cache-v1';
  requestedMode: Mode;
  effectiveMode: Mode;
  authorizedMaxCredits: string;
  candidates: readonly Readonly<{
    modelSlug: string;
    modelType: 'embedding';
    upstreamId: string;
    upstreamModelId: string;
    adapterKey: string;
    modelUpstreamId: string;
    profileId: string;
    profileRevision: number;
    adapterContract: ReviewedEmbeddingProfile['adapterContract'];
    endpointPolicy: ReviewedEmbeddingProfile['endpointPolicy'];
    contextWindowTokens: number;
    inputCount: number;
    dimensions: 1536;
    encodingFormat: 'float';
    prices: CandidateBillingFacts['prices'];
    maxCredits: string;
  }>[];
}>;

export type StoredEmbeddingQuoteResult =
  | Readonly<{
      status: 'ready';
      candidates: readonly [FrozenEmbeddingCandidate];
      authorizedMaxCredits: bigint;
      quoteSnapshot: StoredEmbeddingQuoteSnapshot;
    }>
  | Readonly<{
      status: 'unavailable';
      code: 'STORED_EMBEDDINGS_UNAVAILABLE';
    }>;

const unavailable = Object.freeze({
  status: 'unavailable',
  code: 'STORED_EMBEDDINGS_UNAVAILABLE',
} as const);
const modes: readonly Mode[] = [
  'auto',
  'fastest',
  'cheapest',
  'balanced',
  'ru-only',
];

/** Pure preparation: one reviewed, policy-admitted candidate and exact DB decimals. */
export function prepareStoredEmbeddingQuote(
  args: Readonly<{
    model: ResolvedModel;
    requestedMode: Mode;
    policy: Readonly<ApiKeyPolicies>;
    inputCount: number;
    getAdapter: (key: string) => UpstreamAdapter;
  }>,
): StoredEmbeddingQuoteResult {
  if (
    args.model.type !== 'embedding' ||
    !Number.isSafeInteger(args.inputCount) ||
    args.inputCount < 1 ||
    args.inputCount > 16
  )
    return unavailable;

  const effectiveMode = args.policy.forbid_non_ru
    ? 'ru-only'
    : args.requestedMode;
  if (!modes.includes(effectiveMode)) return unavailable;

  const eligible: Array<{
    ranking: ResolvedModel['candidates'][number];
    frozen: FrozenEmbeddingCandidate;
  }> = [];
  for (const candidate of args.model.candidates) {
    const profile = findReviewedEmbeddingProfile({
      modelSlug: args.model.slug,
      modelType: args.model.type,
      upstreamId: candidate.upstream_id,
      upstreamModelId: candidate.upstream_model_id,
      adapterKey: candidate.id,
    });
    if (!profile || args.inputCount > profile.maxInputs) continue;
    if (
      args.policy.allowed_providers?.length &&
      !args.policy.allowed_providers.includes(candidate.provider)
    )
      continue;
    if (
      args.policy.blocked_providers?.includes(candidate.provider) ||
      (effectiveMode === 'ru-only' && !candidate.ru_residency)
    )
      continue;

    try {
      const mechanics = args.getAdapter(profile.adapterKey).admittedEmbeddings;
      if (
        mechanics?.contract !== profile.adapterContract ||
        typeof mechanics.execute !== 'function'
      )
        continue;
    } catch {
      continue;
    }

    const billing = parseCandidateBillingFacts(candidate.billing);
    if (!billing) return unavailable;
    let maxCredits: bigint;
    try {
      maxCredits = quoteEmbeddingMaximum(
        billing.prices,
        profile.contextWindowTokens,
        args.inputCount,
      );
    } catch {
      return unavailable;
    }
    if (maxCredits === 0n) return unavailable;

    eligible.push({
      ranking: candidate,
      frozen: Object.freeze({
        modelSlug: profile.modelSlug,
        modelType: profile.modelType,
        upstreamId: profile.upstreamId,
        upstreamModelId: profile.upstreamModelId,
        adapterKey: profile.adapterKey,
        provider: candidate.provider,
        ruResidency: candidate.ru_residency,
        priority: candidate.priority,
        egressProxyUrl: candidate.egress_proxy,
        profile,
        billing,
        inputCount: args.inputCount,
        dimensions: 1536,
        encodingFormat: 'float',
        maxCredits,
      }),
    });
  }
  if (eligible.length === 0) return unavailable;

  const winner = pickUpstream(
    eligible.map(({ ranking }) => ranking),
    effectiveMode === 'ru-only' ? 'balanced' : effectiveMode,
    {},
    'embedding',
  );
  const chosen = eligible.find(({ ranking }) => ranking === winner)?.frozen;
  if (!chosen) return unavailable;

  const candidates = Object.freeze([chosen]) as readonly [FrozenEmbeddingCandidate];
  const quoteCandidate = Object.freeze({
    modelSlug: chosen.modelSlug,
    modelType: chosen.modelType,
    upstreamId: chosen.upstreamId,
    upstreamModelId: chosen.upstreamModelId,
    adapterKey: chosen.adapterKey,
    modelUpstreamId: chosen.billing.modelUpstreamId,
    profileId: chosen.profile.profileId,
    profileRevision: chosen.profile.revision,
    adapterContract: chosen.profile.adapterContract,
    endpointPolicy: chosen.profile.endpointPolicy,
    contextWindowTokens: chosen.profile.contextWindowTokens,
    inputCount: chosen.inputCount,
    dimensions: chosen.dimensions,
    encodingFormat: chosen.encodingFormat,
    prices: chosen.billing.prices,
    maxCredits: chosen.maxCredits.toString(),
  });
  const quoteSnapshot: StoredEmbeddingQuoteSnapshot = Object.freeze({
    version: 1,
    formulaVersion: 'db-input-output-cents-per-1k-legacy-whole-cache-v1',
    requestedMode: args.requestedMode,
    effectiveMode,
    authorizedMaxCredits: chosen.maxCredits.toString(),
    candidates: Object.freeze([quoteCandidate]),
  });
  return Object.freeze({
    status: 'ready',
    candidates,
    authorizedMaxCredits: chosen.maxCredits,
    quoteSnapshot,
  });
}
