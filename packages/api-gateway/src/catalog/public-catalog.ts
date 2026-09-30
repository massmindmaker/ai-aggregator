import { createHash } from 'node:crypto';
import {
  CATALOG_ACCEPTED_MAX_TOKENS,
  CATALOG_AUTHOR_DEFAULT_OUTPUT_TOKENS,
  CATALOG_AUTHOR_MAX_BODY_BYTES,
  CATALOG_AUTHOR_MAX_MESSAGES,
  CATALOG_AUTHOR_MAX_OUTPUT_TOKENS,
  CATALOG_SCHEMA_VERSION,
  catalogModes,
  encodeCatalogCursor,
  type CatalogAvailableAuthorItemV1,
  type CatalogAvailableItemV1,
  type CatalogAvailableEmbeddingsItemV1,
  type CatalogAuthorInvocationV1,
  type CatalogCursorV1,
  type CatalogItemV1,
  type CatalogMode,
  type CatalogResponseV1,
  type CatalogRetailAuthorRequestPricingV1,
  type CatalogUnavailableItemV1,
  type CatalogUnavailableReason,
  type Sha256Revision,
} from '@aiag/shared/catalog-contract';
import { config } from '../config';
import { sql } from '../lib/db';
import type { AuthenticatedApiKey } from '../middleware/auth-plan04';
import { prepareStoredChatQuote } from '../billing/candidate-quote';
import { findReviewedChatProfile, reviewedChatProfiles } from '../billing/reviewed-token-profiles';
import { normalizeStoredChatFreshPolicy, StoredChatFreshPolicyError } from '../billing/stored-chat-fresh-policy';
import { REQUEST_BODY_LIMIT_BYTES } from '../billing/stored-chat-http-contract';
import { STORED_CHAT_FORMULA } from '../billing/stored-chat-attempt-contract';
import { quoteChatMaximum, type TokenPrices } from '../billing/token-quote';
import type { ResolvedModel } from '../routing/resolver';
import { getUpstream } from '../upstreams/registry';
import type { UpstreamAdapter } from '../upstreams/interface';
import { projectCatalogRetailTokenPricing } from './retail-token-pricing';
import { projectCatalogRetailEmbeddingsPricing, projectCatalogRetailAuthorRequestPricing } from './retail-token-pricing';
import { authorChatEnabled, authorVersionListed } from './author-admission';
import { findReviewedEmbeddingProfile, reviewedEmbeddingProfiles } from '../billing/reviewed-embedding-profiles';
import { prepareStoredEmbeddingQuote } from '../billing/embedding-candidate-quote';
import { STORED_EMBEDDINGS_REQUEST_BODY_LIMIT_BYTES } from '../billing/stored-embeddings-http-contract';

export const CATALOG_MAX_CANDIDATES_PER_MODEL = 16;
export const CATALOG_MAX_CANDIDATES_PER_PAGE = 512;
export const CATALOG_MAX_AUTHOR_VERSIONS_PER_PAGE = 100;

type ExecutionMode =
  | 'legacy'
  | 'stored_chat_only'
  | 'stored_chat_embeddings'
  | 'stored_chat_embeddings_completions'
  | 'stored_chat_embeddings_completions_stream'
  | 'stored_chat_embeddings_completions_stream_media'
  | 'stored_chat_embeddings_completions_stream_media_batches';
type MechanicsReadiness = Readonly<{
  profileId: string;
  profileRevision: number;
  adapterKey: string;
  adapterContract: string;
  configured: boolean;
  forceMockExcluded: boolean;
}>;

type AuthorChatReadiness = Readonly<{
  enabled: boolean;
  endpointKeyConfigured: boolean;
}>;

export type CatalogRuntimeCapture = Readonly<{
  executionMode: ExecutionMode;
  cachingMultiplier: string;
  configuredDefaultMaxOutputTokens: number;
  authorChat: AuthorChatReadiness;
  mechanics: readonly MechanicsReadiness[];
  runtimeProjectionRevision: Sha256Revision;
}>;

export type CatalogModelRow = Readonly<{
  id: unknown;
  slug: unknown;
  type: unknown;
  status: unknown;
  /** Admitted author version for this model, or null for an ordinary upstream model. */
  author_version_id: unknown;
  author_manifest_digest: unknown;
  author_price_microcredits: unknown;
  author_policy_digest: unknown;
}>;

export type CatalogCandidateRow = Readonly<{
  model_id: unknown;
  model_upstream_id: unknown;
  upstream_id: unknown;
  upstream_model_id: unknown;
  provider: unknown;
  ru_residency: unknown;
  upstream_enabled: unknown;
  candidate_enabled: unknown;
  latency_p50_ms: unknown;
  uptime: unknown;
  price_per_1k_input: unknown;
  price_per_1k_output: unknown;
  markup: unknown;
  egress_proxy: unknown;
  priority: unknown;
}>;

type CatalogReader = Readonly<{
  readRevision(): Promise<unknown>;
  readAuthorRevision(): Promise<unknown>;
  readModels(after: CatalogCursorV1['after'] | null, limitPlusOne: number): Promise<readonly CatalogModelRow[]>;
  readCandidates(modelIds: readonly string[]): Promise<readonly CatalogCandidateRow[]>;
}>;

export type CatalogTransactionRunner = <T>(work: (reader: CatalogReader) => Promise<T>) => Promise<T>;

export class PublicCatalogError extends Error {
  constructor(readonly kind: 'key_policy_unavailable' | 'catalog_unavailable' | 'revision_changed') {
    super(kind.toUpperCase());
  }
}

function digest(value: unknown): Sha256Revision {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

function positiveSafe(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function configuredMechanics(adapter: UpstreamAdapter, contract: string): boolean {
  return (adapter.admittedChat?.contract === contract && typeof adapter.admittedChat.execute === 'function') ||
    (adapter.admittedEmbeddings?.contract === contract && typeof adapter.admittedEmbeddings.execute === 'function');
}

/** Captures every mutable process input once and retains no adapter or credential. */
export function capturePublicCatalogRuntime(source: Readonly<{
  executionMode?: ExecutionMode;
  cachingMultiplier?: string;
  configuredDefaultMaxOutputTokens?: number;
  forceMock?: boolean;
  /** Availability of the author execution contract; overrides exist for tests only. */
  authorChatEnabled?: boolean;
  authorEndpointKeyConfigured?: boolean;
  getAdapter?: (adapterKey: string) => UpstreamAdapter;
}> = {}): CatalogRuntimeCapture {
  const executionMode = source.executionMode ?? config.GATEWAY_HTTP_EXECUTION_MODE;
  const cachingMultiplier = source.cachingMultiplier ?? config.STORED_CHAT_CACHING_DISCOUNT_EXACT;
  const configuredDefaultMaxOutputTokens = source.configuredDefaultMaxOutputTokens ?? config.GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS;
  const forceMock = source.forceMock ?? process.env.AIAG_FORCE_MOCK === '1';
  const resolveAdapter = source.getAdapter ?? getUpstream;
  if (
    !['legacy', 'stored_chat_only', 'stored_chat_embeddings', 'stored_chat_embeddings_completions', 'stored_chat_embeddings_completions_stream', 'stored_chat_embeddings_completions_stream_media', 'stored_chat_embeddings_completions_stream_media_batches'].includes(executionMode) ||
    !positiveSafe(configuredDefaultMaxOutputTokens)
  )
    throw new PublicCatalogError('catalog_unavailable');

  // Validates the exact cache decimal without introducing another policy parser.
  projectCatalogRetailTokenPricing(
    { inputCentsPer1k: '0', outputCentsPer1k: '0', markup: '1' },
    cachingMultiplier,
  );

  const mechanics = Object.freeze(
    [
      ...reviewedChatProfiles,
      ...(executionMode === 'stored_chat_embeddings' || executionMode === 'stored_chat_embeddings_completions' || executionMode === 'stored_chat_embeddings_completions_stream' || executionMode === 'stored_chat_embeddings_completions_stream_media' || executionMode === 'stored_chat_embeddings_completions_stream_media_batches'
        ? reviewedEmbeddingProfiles
        : []),
    ]
      .sort((a, b) => a.profileId.localeCompare(b.profileId))
      .map((profile) => {
        let configured = false;
        if (!forceMock) {
          try {
            configured = configuredMechanics(resolveAdapter(profile.adapterKey), profile.adapterContract);
          } catch {
            configured = false;
          }
        }
        return Object.freeze({
          profileId: profile.profileId,
          profileRevision: profile.revision,
          adapterKey: profile.adapterKey,
          adapterContract: profile.adapterContract,
          configured,
          forceMockExcluded: forceMock,
        });
      }),
  );
  const authorChat: AuthorChatReadiness = Object.freeze({
    enabled: source.authorChatEnabled ?? authorChatEnabled(),
    endpointKeyConfigured: source.authorEndpointKeyConfigured ?? Boolean(process.env.AUTHOR_ENDPOINT_KEK),
  });
  const publicRuntimeTuple = Object.freeze({
    schemaVersion: CATALOG_SCHEMA_VERSION,
    executionMode,
    cachingMultiplier,
    configuredDefaultMaxOutputTokens,
    authorChat,
    request: Object.freeze({
      maxBodyBytes: REQUEST_BODY_LIMIT_BYTES,
      acceptedMaximum: CATALOG_ACCEPTED_MAX_TOKENS,
      formula: STORED_CHAT_FORMULA,
      modes: catalogModes,
    }),
    candidateBounds: Object.freeze({
      perModel: CATALOG_MAX_CANDIDATES_PER_MODEL,
      perPage: CATALOG_MAX_CANDIDATES_PER_PAGE,
    }),
    mechanics,
  });
  return Object.freeze({
    executionMode,
    cachingMultiplier,
    configuredDefaultMaxOutputTokens,
    authorChat,
    mechanics,
    runtimeProjectionRevision: digest(publicRuntimeTuple),
  });
}

function defaultTransactionRunner<T>(work: (reader: CatalogReader) => Promise<T>): Promise<T> {
  return sql.begin('isolation level repeatable read read only', async (tx) => {
    const reader: CatalogReader = {
      async readRevision() {
        const rows = await tx<readonly { revision: unknown }[]>`
          SELECT aiag_read_gateway_catalog_revision_v1()::text AS revision
        `;
        return rows[0]?.revision;
      },
      /**
       * The 0073 revision trigger set covers only `models`/`model_upstreams`/
       * `upstreams`, so author admission changes would leave cursors valid while
       * the advertised price is stale. Migrations are out of scope here, so the
       * author facts are folded into the catalog revision as bounded aggregates.
       */
      async readAuthorRevision() {
        const rows = await tx<readonly { revision: unknown }[]>`
          SELECT concat_ws('|',
                   (SELECT count(*)::text FROM author_model_versions),
                   coalesce((SELECT max(updated_at)::text FROM author_model_versions), ''),
                   coalesce((SELECT max(approved_at)::text FROM author_price_policies), ''),
                   (SELECT count(*)::text FROM author_probe_operations WHERE state = 'succeeded'),
                   (SELECT count(*)::text FROM users u
                     WHERE (NOT u.is_active OR u.is_banned)
                       AND EXISTS (SELECT 1 FROM author_model_versions v WHERE v.author_user_id = u.id))
                 ) AS revision
        `;
        return rows[0]?.revision;
      },
      async readModels(after, limitPlusOne) {
        // Author versions have no `model_upstreams` row, so they can never appear
        // through the candidate join. They are admitted here under exactly the
        // same predicate `/v1/models` uses, so the two public lists cannot drift.
        return tx<CatalogModelRow[]>`
          SELECT m.id::text AS id, m.slug, m.type, m.status,
                 a.version_id AS author_version_id,
                 a.manifest_digest AS author_manifest_digest,
                 a.price_microcredits AS author_price_microcredits,
                 a.policy_digest AS author_policy_digest
            FROM models m
            LEFT JOIN LATERAL (
              SELECT v.id::text AS version_id,
                     v.manifest_digest,
                     p.price_microcredits::text AS price_microcredits,
                     p.policy_digest
                FROM author_model_versions v
                JOIN author_price_policies p ON p.version_id = v.id
               WHERE v.id = m.current_author_version_id
                 AND v.model_id = m.id
                 AND ${authorVersionListed(tx)}
            ) a ON TRUE
           WHERE m.enabled = TRUE
             AND m.status IN ('live', 'frozen')
             AND m.slug <> 'whisper-large-v3'
             AND lower(coalesce(m.metadata->>'operation','')) <> 'stt'
             AND NOT EXISTS (
               SELECT 1 FROM unnest(m.tags) tag
                WHERE lower(tag) IN ('stt','transcription')
             )
             AND (
               ${after?.slug ?? null}::text IS NULL
               OR (m.slug, m.id) > (${after?.slug ?? null}::text, ${after?.modelId ?? null}::uuid)
             )
           ORDER BY m.slug ASC, m.id ASC
           LIMIT ${limitPlusOne}
        `;
      },
      async readCandidates(modelIds) {
        if (modelIds.length === 0) return [];
        return tx<CatalogCandidateRow[]>`
          SELECT candidate.model_id::text AS model_id,
                 candidate.model_upstream_id::text AS model_upstream_id,
                 candidate.upstream_id,
                 candidate.upstream_model_id,
                 candidate.provider,
                 candidate.ru_residency,
                 candidate.upstream_enabled,
                 candidate.candidate_enabled,
                 candidate.latency_p50_ms,
                 candidate.uptime::text AS uptime,
                 candidate.price_per_1k_input::text AS price_per_1k_input,
                 candidate.price_per_1k_output::text AS price_per_1k_output,
                 candidate.markup::text AS markup,
                 candidate.egress_proxy,
                 candidate.priority
            FROM unnest(${tx.array([...modelIds], 2950)}::uuid[]) AS selected(model_id)
            CROSS JOIN LATERAL (
              SELECT mu.model_id, mu.id AS model_upstream_id,
                     mu.upstream_id, mu.upstream_model_id,
                     u.provider, u.ru_residency,
                     u.enabled AS upstream_enabled,
                     mu.enabled AS candidate_enabled,
                     u.latency_p50_ms, u.uptime,
                     mu.price_per_1k_input, mu.price_per_1k_output,
                     mu.markup, mu.egress_proxy, mu.priority
                FROM model_upstreams mu
                JOIN upstreams u ON u.id = mu.upstream_id
               WHERE mu.model_id = selected.model_id
               ORDER BY mu.id ASC
               LIMIT ${CATALOG_MAX_CANDIDATES_PER_MODEL + 1}
            ) AS candidate
           ORDER BY candidate.model_id ASC, candidate.model_upstream_id ASC
           LIMIT ${CATALOG_MAX_CANDIDATES_PER_PAGE + 1}
        `;
      },
    };
    return work(reader);
  }) as Promise<T>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const MODEL_TYPES = ['chat', 'embedding', 'image', 'audio', 'completion', 'video'] as const;

function textValue(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max)
    throw new PublicCatalogError('catalog_unavailable');
  return value;
}

function uuidValue(value: unknown): string {
  const valueString = textValue(value, 36);
  if (!UUID.test(valueString)) throw new PublicCatalogError('catalog_unavailable');
  return valueString;
}

function decimalValue(value: unknown): string {
  const valueString = textValue(value, 128);
  if (!DECIMAL.test(valueString)) throw new PublicCatalogError('catalog_unavailable');
  return valueString;
}

function parseDbRevision(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value))
    throw new PublicCatalogError('catalog_unavailable');
  const revision = BigInt(value);
  if (revision >= 9_223_372_036_854_775_807n)
    throw new PublicCatalogError('catalog_unavailable');
  return value;
}

type ValidModel = Readonly<{
  id: string;
  slug: string;
  type: ResolvedModel['type'];
  status: 'live' | 'frozen';
  /** Non-null only for a model whose current author version is admitted. */
  author: ValidAuthorVersion | null;
}>;
type ValidAuthorVersion = Readonly<{
  versionId: string;
  manifestDigest: string;
  priceMicrocredits: string;
  policyDigest: string;
}>;
type ValidCandidate = Readonly<{
  modelId: string;
  deploymentId: string;
  adapterKey: string;
  upstreamModelId: string;
  provider: string;
  ruResidency: boolean;
  latency: number;
  uptime: number;
  prices: TokenPrices;
  egressProxy: string | null;
  priority: number;
}>;

const DIGEST = /^sha256:[0-9a-f]{64}$/;

function validateAuthorVersion(row: CatalogModelRow): ValidAuthorVersion | null {
  if (row.author_version_id === null || row.author_version_id === undefined) return null;
  const priceMicrocredits = decimalValue(row.author_price_microcredits);
  const manifestDigest = textValue(row.author_manifest_digest, 71);
  const policyDigest = textValue(row.author_policy_digest, 71);
  // The DB constraint already bounds this; an admitted price of zero or a
  // non-digest identity must never be advertised as purchasable.
  if (!DIGEST.test(manifestDigest) || !DIGEST.test(policyDigest) || !/^[1-9][0-9]*$/.test(priceMicrocredits))
    throw new PublicCatalogError('catalog_unavailable');
  return Object.freeze({
    versionId: uuidValue(row.author_version_id),
    manifestDigest,
    priceMicrocredits,
    policyDigest,
  });
}

function validateModel(row: CatalogModelRow): ValidModel {
  const type = textValue(row.type, 20);
  const status = row.status;
  if (!MODEL_TYPES.includes(type as ResolvedModel['type']) || (status !== 'live' && status !== 'frozen'))
    throw new PublicCatalogError('catalog_unavailable');
  return Object.freeze({
    id: uuidValue(row.id),
    slug: textValue(row.slug, 128),
    type: type as ResolvedModel['type'],
    status,
    author: validateAuthorVersion(row),
  });
}

function validateCandidate(row: CatalogCandidateRow): ValidCandidate | null {
  if (typeof row.candidate_enabled !== 'boolean' || typeof row.upstream_enabled !== 'boolean' || typeof row.ru_residency !== 'boolean')
    throw new PublicCatalogError('catalog_unavailable');
  const deploymentId = uuidValue(row.model_upstream_id);
  const modelId = uuidValue(row.model_id);
  const adapterKey = textValue(row.upstream_id, 64);
  const upstreamModelId = textValue(row.upstream_model_id, 256);
  const provider = textValue(row.provider, 64);
  const latency = Number(row.latency_p50_ms);
  const uptime = Number(decimalValue(row.uptime));
  const priority = Number(row.priority);
  if (!Number.isSafeInteger(latency) || latency < 0 || !Number.isFinite(uptime) || uptime < 0 || uptime > 1 || !Number.isSafeInteger(priority))
    throw new PublicCatalogError('catalog_unavailable');
  const egressProxy = row.egress_proxy;
  if (egressProxy !== null && typeof egressProxy !== 'string')
    throw new PublicCatalogError('catalog_unavailable');
  const prices = Object.freeze({
    inputCentsPer1k: decimalValue(row.price_per_1k_input),
    outputCentsPer1k: decimalValue(row.price_per_1k_output),
    markup: decimalValue(row.markup),
  });
  if (
    !Number.isFinite(Number(prices.inputCentsPer1k)) ||
    !Number.isFinite(Number(prices.outputCentsPer1k)) ||
    !Number.isFinite(Number(prices.markup))
  )
    throw new PublicCatalogError('catalog_unavailable');
  if (!row.candidate_enabled || !row.upstream_enabled) return null;
  return Object.freeze({ modelId, deploymentId, adapterKey, upstreamModelId, provider, ruResidency: row.ru_residency, latency, uptime, prices, egressProxy, priority });
}

function modelIdentity(model: ValidModel) {
  return Object.freeze({
    id: model.id,
    slug: model.slug,
    type: model.type,
    artifact: Object.freeze({ attestation: 'unattested' as const, version: null, digest: null }),
  });
}

function unavailable(model: ValidModel, reason: CatalogUnavailableReason): CatalogUnavailableItemV1 {
  return Object.freeze({
    object: 'catalog.model',
    model: modelIdentity(model),
    availability: Object.freeze({ state: 'unavailable', scope: 'advertised_contract', reason, liveUpstreamHealthChecked: false }),
    deployment: null,
    invocation: null,
    capabilities: Object.freeze([] as const),
    pricing: null,
  });
}

function mechanicsAdapter(runtime: CatalogRuntimeCapture, profileId: string): UpstreamAdapter {
  const readiness = runtime.mechanics.find((item) => item.profileId === profileId);
  if (!readiness?.configured) return Object.freeze({ chat: async () => { throw new Error('unreachable'); } });
  const base: UpstreamAdapter = {
    ...(readiness.adapterContract === 'openrouter-pinned-provider-embeddings-v1' ? {
      admittedEmbeddings: Object.freeze({
        contract: 'openrouter-pinned-provider-embeddings-v1' as const,
        execute: async () => { throw new Error('unreachable'); },
      }),
    } : {
    admittedChat: Object.freeze({
      contract: readiness.adapterContract as 'openrouter-pinned-provider-chat-v1',
      execute: async () => { throw new Error('unreachable'); },
    }),
    }),
    chat: async () => { throw new Error('unreachable'); },
  };
  return Object.freeze(base);
}

function configurationRevision(args: Readonly<{
  model: ValidModel;
  candidate: ValidCandidate;
  profile: NonNullable<ReturnType<typeof findReviewedChatProfile>>;
  runtime: CatalogRuntimeCapture;
}>): Sha256Revision {
  return digest({
    schemaVersion: 1,
    model: [args.model.id, args.model.slug, args.model.type],
    deploymentId: args.candidate.deploymentId,
    binding: [args.candidate.adapterKey, args.candidate.upstreamModelId, args.candidate.provider],
    executionConfiguration: [args.candidate.ruResidency, args.candidate.priority, args.candidate.egressProxy !== null],
    profile: [args.profile.profileId, args.profile.revision, args.profile.adapterContract],
    invocation: [REQUEST_BODY_LIMIT_BYTES, CATALOG_ACCEPTED_MAX_TOKENS, args.runtime.configuredDefaultMaxOutputTokens],
    capability: [args.profile.contextWindowTokens, args.profile.maxOutputTokens, args.profile.usageContract, args.profile.tariffContract],
    runtime: [args.runtime.executionMode, args.runtime.mechanics.find((item) => item.profileId === args.profile.profileId)?.configured === true],
  });
}

function projectEmbeddingModel(
  model: ValidModel,
  rawCandidates: readonly CatalogCandidateRow[],
  runtime: CatalogRuntimeCapture,
  normalized: ReturnType<typeof normalizeStoredChatFreshPolicy>,
): CatalogItemV1 {
  if (runtime.executionMode !== 'stored_chat_embeddings' && runtime.executionMode !== 'stored_chat_embeddings_completions' && runtime.executionMode !== 'stored_chat_embeddings_completions_stream' && runtime.executionMode !== 'stored_chat_embeddings_completions_stream_media' && runtime.executionMode !== 'stored_chat_embeddings_completions_stream_media_batches')
    return unavailable(model, 'runtime_contract_unavailable');
  const candidates = rawCandidates.map(validateCandidate).filter((candidate): candidate is ValidCandidate => candidate !== null);
  const reviewed = candidates.map((candidate) => ({
    candidate,
    profile: findReviewedEmbeddingProfile({
      modelSlug: model.slug, modelType: 'embedding', upstreamId: candidate.adapterKey,
      upstreamModelId: candidate.upstreamModelId, adapterKey: candidate.adapterKey,
    }),
  })).filter((entry): entry is { candidate: ValidCandidate; profile: NonNullable<typeof entry.profile> } => entry.profile !== null);
  if (!reviewed.length) return unavailable(model, 'no_admitted_deployment');
  const configured = reviewed.filter(({ profile }) => runtime.mechanics.some(
    (item) => item.profileId === profile.profileId && item.configured,
  ));
  if (!configured.length) return unavailable(model, 'service_configuration_unavailable');

  const resolved: ResolvedModel = {
    slug: model.slug,
    type: 'embedding',
    candidates: configured.map(({ candidate }) => ({
      id: candidate.adapterKey, upstream_id: candidate.adapterKey,
      upstream_model_id: candidate.upstreamModelId, provider: candidate.provider,
      ru_residency: candidate.ruResidency,
      price_per_1k_input: Number(candidate.prices.inputCentsPer1k),
      price_per_1k_output: Number(candidate.prices.outputCentsPer1k),
      markup: Number(candidate.prices.markup), latency_p50_ms: candidate.latency,
      uptime: candidate.uptime, egress_proxy: candidate.egressProxy, priority: candidate.priority,
      billing: { modelUpstreamId: candidate.deploymentId, prices: candidate.prices },
    })),
  };
  const ready: Array<{ mode: CatalogMode; quote: Extract<ReturnType<typeof prepareStoredEmbeddingQuote>, { status: 'ready' }> }> = [];
  for (const mode of catalogModes) {
    const quote = prepareStoredEmbeddingQuote({
      model: resolved, requestedMode: mode, policy: normalized.policy, inputCount: 16,
      getAdapter: (adapterKey) => {
        const profile = configured.find((entry) => entry.candidate.adapterKey === adapterKey)?.profile;
        return mechanicsAdapter(runtime, profile?.profileId ?? '');
      },
    });
    if (quote.status === 'ready') ready.push({ mode, quote });
  }
  if (!ready.length) return unavailable(model, 'no_admitted_deployment');
  const deploymentIds = new Set(ready.map(({ quote }) => quote.candidates[0].billing.modelUpstreamId));
  if (deploymentIds.size !== 1) return unavailable(model, 'runtime_contract_unavailable');
  const selected = configured.find((entry) => entry.candidate.deploymentId === [...deploymentIds][0])!;
  let pricing: CatalogAvailableEmbeddingsItemV1['pricing'];
  try { pricing = projectCatalogRetailEmbeddingsPricing(selected.candidate.prices); }
  catch { return unavailable(model, 'retail_pricing_unavailable'); }
  const availableValues = Object.freeze(ready.map(({ mode }) => mode));
  const defaultRequested = normalized.policy.default_mode ?? 'auto';
  const effectiveDefault = normalized.policy.forbid_non_ru ? 'ru-only' : defaultRequested;
  const invocation: CatalogAvailableEmbeddingsItemV1['invocation'] = Object.freeze({
    method: 'POST', path: '/v1/embeddings', authorization: 'bearer_api_key', contentType: 'application/json',
    maxBodyBytes: STORED_EMBEDDINGS_REQUEST_BODY_LIMIT_BYTES,
    requestBody: Object.freeze({ unknownFields: 'reject' }),
    headers: Object.freeze({
      idempotencyKey: Object.freeze({ name: 'Idempotency-Key', required: true, pattern: '^[A-Za-z0-9._:-]{1,128}$' }),
      sessionId: Object.freeze({ name: 'X-AIAG-Session-Id', required: false, pattern: '^[A-Za-z0-9._:-]{1,128}$' }),
      upstreamKey: Object.freeze({ name: 'X-Upstream-Key', allowed: false, rejection: 'UNSUPPORTED_EXECUTION_CONTRACT' }),
    }),
    parameters: Object.freeze({
      model: Object.freeze({ required: true, const: model.slug }),
      input: Object.freeze({ required: true, minItems: 1, maxItems: 16, item: 'nonempty_utf8_string_max_8192_bytes' }),
      encoding_format: Object.freeze({ required: false, const: 'float', normalizedDefault: 'float' }),
      dimensions: Object.freeze({ required: false, const: 1536, normalizedDefault: 1536 }),
      aiag_mode: Object.freeze({
        required: false, values: catalogModes, availableValues, defaultRequested, effectiveDefault,
        requiresExplicitAvailableValue: !availableValues.includes(effectiveDefault),
      }),
    }),
  });
  const configurationRevisionValue = digest({
    schemaVersion: 1, model: [model.id, model.slug, model.type], deploymentId: selected.candidate.deploymentId,
    binding: [selected.candidate.adapterKey, selected.candidate.upstreamModelId, selected.candidate.provider],
    executionConfiguration: [selected.candidate.ruResidency, selected.candidate.priority, selected.candidate.egressProxy !== null],
    profile: [selected.profile.profileId, selected.profile.revision, selected.profile.adapterContract],
    invocation: [STORED_EMBEDDINGS_REQUEST_BODY_LIMIT_BYTES, 8192, 16, 1536, 'float'],
    runtime: [runtime.executionMode, true],
  });
  return Object.freeze({
    object: 'catalog.model', model: modelIdentity(model),
    availability: Object.freeze({ state: 'available', scope: 'advertised_contract', reason: null, liveUpstreamHealthChecked: false }),
    deployment: Object.freeze({ id: selected.candidate.deploymentId, configurationRevision: configurationRevisionValue, contract: 'stored-embeddings-v1' }),
    invocation,
    capabilities: Object.freeze([Object.freeze({
      id: 'embeddings.stored.float.v1', inputModalities: Object.freeze(['text'] as const),
      outputModalities: Object.freeze(['embedding'] as const), storedResult: true, usageReceipt: true,
      requestDependentRestrictions: Object.freeze(['pii_transborder'] as const), contextWindowTokensPerInput: 8192,
      maxInputs: 16, dimensions: 1536, encodingFormat: 'float',
    })] as const),
    pricing,
  });
}

/**
 * Projects one admitted author version. It is deliberately NOT an upstream
 * candidate: there is no `model_upstreams` row, no reviewed profile and no
 * per-token tariff, so the deployment identity is the author version and the
 * price is the approved fixed per-request amount.
 */
function projectAuthorModel(
  model: ValidModel,
  runtime: CatalogRuntimeCapture,
  normalized: ReturnType<typeof normalizeStoredChatFreshPolicy>,
): CatalogItemV1 {
  const author = model.author;
  if (!author) return unavailable(model, 'no_admitted_deployment');
  if (model.status === 'frozen') return unavailable(model, 'model_frozen');
  if (normalized.whitelist.length && !normalized.whitelist.includes(model.slug))
    return unavailable(model, 'key_policy_excludes_model');
  // Author chat is a stored-mode contract; legacy execution cannot serve it.
  if (runtime.executionMode === 'legacy') return unavailable(model, 'runtime_contract_unavailable');
  if (model.type !== 'chat') return unavailable(model, 'no_admitted_deployment');
  if (!runtime.authorChat.enabled) return unavailable(model, 'runtime_contract_unavailable');
  // Without the endpoint KEK the author token envelope cannot be decrypted, so
  // the version is admitted in the DB but not executable here.
  if (!runtime.authorChat.endpointKeyConfigured)
    return unavailable(model, 'service_configuration_unavailable');
  // Author hosting residency is not independently verified; mirror the exact
  // runtime policy in author-chat.ts `checkPolicy` instead of guessing RU-ness.
  if (
    normalized.policy.forbid_non_ru ||
    normalized.policy.default_mode === 'ru-only' ||
    normalized.policy.blocked_providers?.includes('author') ||
    (normalized.policy.allowed_providers?.length &&
      !normalized.policy.allowed_providers.includes('author'))
  )
    return unavailable(model, 'key_policy_excludes_model');

  let pricing: CatalogRetailAuthorRequestPricingV1;
  try {
    pricing = projectCatalogRetailAuthorRequestPricing(author.priceMicrocredits);
  } catch {
    return unavailable(model, 'retail_pricing_unavailable');
  }
  const effectiveMaximum: number = CATALOG_AUTHOR_MAX_OUTPUT_TOKENS;
  const configuredDefault: number = CATALOG_AUTHOR_DEFAULT_OUTPUT_TOKENS;
  const maxMessages: number = CATALOG_AUTHOR_MAX_MESSAGES;
  // Author chat serves one endpoint, so only `auto` is actually selectable; the
  // ru-only case is already rejected above, never advertised.
  const defaultRequested = (normalized.policy.default_mode ?? 'auto') as CatalogMode;
  const effectiveDefault = defaultRequested;
  const authorAvailableValues: readonly CatalogMode[] = Object.freeze(
    catalogModes.filter((mode) => mode === 'auto' || mode === defaultRequested),
  );
  const invocation: CatalogAuthorInvocationV1 = Object.freeze({
    method: 'POST' as const,
    path: '/v1/chat/completions' as const,
    authorization: 'bearer_api_key' as const,
    contentType: 'application/json' as const,
    maxBodyBytes: CATALOG_AUTHOR_MAX_BODY_BYTES,
    requestBody: Object.freeze({
      unknownFields: 'reject' as const,
      unknownMessageFields: 'reject' as const,
      unsupportedExecutionFields: Object.freeze(['tools', 'functions', 'tool_choice', 'modalities', 'audio', 'input_audio'] as const),
      multimodalMessageContent: 'reject' as const,
    }),
    headers: Object.freeze({
      idempotencyKey: Object.freeze({ name: 'Idempotency-Key' as const, required: true as const, pattern: '^[A-Za-z0-9._:-]{1,128}$' as const }),
      sessionId: Object.freeze({ name: 'X-AIAG-Session-Id' as const, required: false as const, pattern: '^[A-Za-z0-9._:-]{1,128}$' as const }),
      upstreamKey: Object.freeze({ name: 'X-Upstream-Key' as const, allowed: false as const, rejection: 'UNSUPPORTED_EXECUTION_CONTRACT' as const }),
    }),
    parameters: Object.freeze({
      model: Object.freeze({ required: true as const, const: model.slug }),
      messages: Object.freeze({
        required: true as const, minItems: 1 as const, maxItems: maxMessages as typeof CATALOG_AUTHOR_MAX_MESSAGES,
        roles: Object.freeze(['system', 'user', 'assistant'] as const), content: 'nonempty_string' as const,
      }),
      stream: Object.freeze({ required: false as const, const: false as const, normalizedDefault: false as const }),
      max_tokens: Object.freeze({
        required: false as const, type: 'integer' as const, minimum: 1 as const,
        acceptedMaximum: effectiveMaximum as typeof CATALOG_AUTHOR_MAX_OUTPUT_TOKENS,
        effectiveMaximum: effectiveMaximum as typeof CATALOG_AUTHOR_MAX_OUTPUT_TOKENS,
        configuredDefault: configuredDefault as typeof CATALOG_AUTHOR_DEFAULT_OUTPUT_TOKENS,
        defaultApplied: Math.min(configuredDefault, effectiveMaximum) as typeof CATALOG_AUTHOR_DEFAULT_OUTPUT_TOKENS,
        normalization: 'clamp_to_effective_max' as const,
      }),
      // The author endpoint has no provider fan-out, so only the modes it can
      // actually honour are advertised as available values.
      aiag_mode: Object.freeze({
        required: false as const,
        values: catalogModes,
        availableValues: authorAvailableValues,
        defaultRequested,
        effectiveDefault,
        requiresExplicitAvailableValue: !authorAvailableValues.includes(effectiveDefault),
      }),
    }),
  });
  const result: CatalogAvailableAuthorItemV1 = Object.freeze({
    object: 'catalog.model',
    model: modelIdentity(model),
    availability: Object.freeze({ state: 'available', scope: 'advertised_contract', reason: null, liveUpstreamHealthChecked: false }),
    ownedBy: 'author',
    deployment: Object.freeze({
      id: author.versionId,
      configurationRevision: digest({
        schemaVersion: 1,
        model: [model.id, model.slug, model.type],
        deploymentId: author.versionId,
        binding: [author.manifestDigest, author.policyDigest],
        invocation: [CATALOG_AUTHOR_MAX_BODY_BYTES, CATALOG_AUTHOR_MAX_MESSAGES, CATALOG_AUTHOR_MAX_OUTPUT_TOKENS, CATALOG_AUTHOR_DEFAULT_OUTPUT_TOKENS],
        runtime: [runtime.executionMode, runtime.authorChat.enabled, runtime.authorChat.endpointKeyConfigured],
      }),
      contract: 'stored-author-chat-v1',
    }),
    invocation,
    capabilities: Object.freeze([Object.freeze({
      id: 'chat.completions.stored.author.v1' as const,
      inputModalities: Object.freeze(['text'] as const),
      outputModalities: Object.freeze(['text'] as const),
      streaming: false as const,
      toolCalling: false as const,
      structuredOutput: false as const,
      asynchronous: false as const,
      storedResult: true as const,
      usageReceipt: true as const,
      requestDependentRestrictions: Object.freeze(['pii_transborder'] as const),
      contextWindowTokens: null as null,
      maxOutputTokens: CATALOG_AUTHOR_MAX_OUTPUT_TOKENS as typeof CATALOG_AUTHOR_MAX_OUTPUT_TOKENS,
    })] as const),
    pricing,
  });
  return result;
}

function projectModel(
  model: ValidModel,
  rawCandidates: readonly CatalogCandidateRow[],
  runtime: CatalogRuntimeCapture,
  normalized: ReturnType<typeof normalizeStoredChatFreshPolicy>,
): CatalogItemV1 {
  // An admitted author version is sold as itself, never blended with upstream
  // candidates: it has no reviewed profile and no per-token tariff.
  if (model.author) return projectAuthorModel(model, runtime, normalized);
  if (model.status === 'frozen') return unavailable(model, 'model_frozen');
  if (normalized.whitelist.length && !normalized.whitelist.includes(model.slug))
    return unavailable(model, 'key_policy_excludes_model');
  if (model.type === 'embedding') return projectEmbeddingModel(model, rawCandidates, runtime, normalized);
  if (runtime.executionMode === 'legacy') return unavailable(model, 'runtime_contract_unavailable');
  if (model.type !== 'chat') return unavailable(model, 'no_admitted_deployment');

  const candidates = rawCandidates.map(validateCandidate).filter((candidate): candidate is ValidCandidate => candidate !== null);
  const reviewed = candidates.map((candidate) => ({
    candidate,
    profile: findReviewedChatProfile({
      modelSlug: model.slug,
      modelType: model.type,
      upstreamId: candidate.adapterKey,
      upstreamModelId: candidate.upstreamModelId,
      adapterKey: candidate.adapterKey,
    }),
  })).filter((entry): entry is { candidate: ValidCandidate; profile: NonNullable<typeof entry.profile> } => entry.profile !== null);
  if (!reviewed.length) return unavailable(model, 'no_admitted_deployment');
  const configured = reviewed.filter(({ profile }) => runtime.mechanics.some((item) => item.profileId === profile.profileId && item.configured));
  if (!configured.length) return unavailable(model, 'service_configuration_unavailable');

  for (const { candidate, profile } of configured) {
    try {
      projectCatalogRetailTokenPricing(candidate.prices, runtime.cachingMultiplier);
      quoteChatMaximum(
        candidate.prices,
        profile.contextWindowTokens,
        Math.min(
          runtime.configuredDefaultMaxOutputTokens,
          profile.contextWindowTokens,
          profile.maxOutputTokens,
        ),
      );
    } catch {
      return unavailable(model, 'retail_pricing_unavailable');
    }
  }

  const resolved: ResolvedModel = {
    slug: model.slug,
    type: model.type,
    candidates: configured.map(({ candidate }) => ({
      id: candidate.adapterKey,
      upstream_id: candidate.adapterKey,
      upstream_model_id: candidate.upstreamModelId,
      provider: candidate.provider,
      ru_residency: candidate.ruResidency,
      price_per_1k_input: Number(candidate.prices.inputCentsPer1k),
      price_per_1k_output: Number(candidate.prices.outputCentsPer1k),
      markup: Number(candidate.prices.markup),
      latency_p50_ms: candidate.latency,
      uptime: candidate.uptime,
      egress_proxy: candidate.egressProxy,
      priority: candidate.priority,
      billing: { modelUpstreamId: candidate.deploymentId, prices: candidate.prices },
    })),
  };

  const ready: Array<{ mode: CatalogMode; quote: Extract<ReturnType<typeof prepareStoredChatQuote>, { status: 'ready' }> }> = [];
  for (const mode of catalogModes) {
    const quote = prepareStoredChatQuote({
      model: resolved,
      requestedMode: mode,
      policy: normalized.policy,
      defaultMaxOutputTokens: runtime.configuredDefaultMaxOutputTokens,
      getAdapter: (adapterKey) => {
        const profile = configured.find((entry) => entry.candidate.adapterKey === adapterKey)?.profile;
        return profile ? mechanicsAdapter(runtime, profile.profileId) : mechanicsAdapter(runtime, '');
      },
    });
    if (quote.status === 'ready') ready.push({ mode, quote });
  }
  if (!ready.length) return unavailable(model, 'no_admitted_deployment');
  const deploymentIds = new Set(ready.flatMap(({ quote }) => quote.candidates.map((candidate) => candidate.billing.modelUpstreamId)));
  if (deploymentIds.size !== 1) return unavailable(model, 'runtime_contract_unavailable');
  const deploymentId = [...deploymentIds][0]!;
  const selected = configured.find((entry) => entry.candidate.deploymentId === deploymentId)!;
  const effectiveMaximum = Math.min(selected.profile.contextWindowTokens, selected.profile.maxOutputTokens);
  const availableValues = Object.freeze(ready.map(({ mode }) => mode));
  const defaultRequested = normalized.policy.default_mode ?? 'auto';
  const effectiveDefault = normalized.policy.forbid_non_ru ? 'ru-only' : defaultRequested;
  const pricing = projectCatalogRetailTokenPricing(selected.candidate.prices, runtime.cachingMultiplier);
  const invocation = Object.freeze({
    method: 'POST' as const,
    path: '/v1/chat/completions' as const,
    authorization: 'bearer_api_key' as const,
    contentType: 'application/json' as const,
    maxBodyBytes: REQUEST_BODY_LIMIT_BYTES,
    requestBody: Object.freeze({
      unknownFields: 'reject' as const,
      unknownMessageFields: 'reject' as const,
      unsupportedExecutionFields: Object.freeze(['tools', 'functions', 'tool_choice', 'modalities', 'audio', 'input_audio'] as const),
      multimodalMessageContent: 'reject' as const,
    }),
    headers: Object.freeze({
      idempotencyKey: Object.freeze({ name: 'Idempotency-Key' as const, required: true as const, pattern: '^[A-Za-z0-9._:-]{1,128}$' as const }),
      sessionId: Object.freeze({ name: 'X-AIAG-Session-Id' as const, required: false as const, pattern: '^[A-Za-z0-9._:-]{1,128}$' as const }),
      upstreamKey: Object.freeze({ name: 'X-Upstream-Key' as const, allowed: false as const, rejection: 'UNSUPPORTED_EXECUTION_CONTRACT' as const }),
    }),
    parameters: Object.freeze({
      model: Object.freeze({ required: true as const, const: model.slug }),
      messages: Object.freeze({ required: true as const, minItems: 1 as const, roles: Object.freeze(['system', 'user', 'assistant'] as const), content: 'nonempty_string' as const }),
      stream: Object.freeze({ required: false as const, const: false as const, normalizedDefault: false as const }),
      max_tokens: Object.freeze({
        required: false as const, type: 'integer' as const, minimum: 1 as const,
        acceptedMaximum: CATALOG_ACCEPTED_MAX_TOKENS,
        effectiveMaximum,
        configuredDefault: runtime.configuredDefaultMaxOutputTokens,
        defaultApplied: Math.min(runtime.configuredDefaultMaxOutputTokens, effectiveMaximum),
        normalization: 'clamp_to_effective_max' as const,
      }),
      aiag_mode: Object.freeze({
        required: false as const,
        values: catalogModes,
        availableValues,
        defaultRequested,
        effectiveDefault,
        requiresExplicitAvailableValue: !availableValues.includes(effectiveDefault),
      }),
    }),
  });
  const capability = Object.freeze({
    id: 'chat.completions.stored.plaintext.v1' as const,
    inputModalities: Object.freeze(['text'] as const),
    outputModalities: Object.freeze(['text'] as const),
    streaming: false as const,
    toolCalling: false as const,
    structuredOutput: false as const,
    asynchronous: false as const,
    storedResult: true as const,
    usageReceipt: true as const,
    requestDependentRestrictions: Object.freeze(['pii_transborder'] as const),
    contextWindowTokens: selected.profile.contextWindowTokens,
    maxOutputTokens: selected.profile.maxOutputTokens,
  });
  const result: CatalogAvailableItemV1 = Object.freeze({
    object: 'catalog.model',
    model: modelIdentity(model),
    availability: Object.freeze({ state: 'available', scope: 'advertised_contract', reason: null, liveUpstreamHealthChecked: false }),
    deployment: Object.freeze({
      id: selected.candidate.deploymentId,
      configurationRevision: configurationRevision({ model, candidate: selected.candidate, profile: selected.profile, runtime }),
      contract: 'stored-plaintext-chat-v1',
    }),
    invocation,
    capabilities: Object.freeze([capability] as const),
    pricing,
  });
  return result;
}

const AUTHOR_REVISION = /^[0-9|]{1,512}$/;

function authorRevisionValue(value: unknown): string {
  if (typeof value !== 'string' || !AUTHOR_REVISION.test(value))
    throw new PublicCatalogError('catalog_unavailable');
  return value;
}

function keyPolicyRevision(normalized: ReturnType<typeof normalizeStoredChatFreshPolicy>): Sha256Revision {
  const sorted = (values: readonly string[] | undefined) => values ? [...values].sort() : undefined;
  return digest({
    whitelist: [...normalized.whitelist].sort(),
    policy: {
      ...normalized.policy,
      allowed_providers: sorted(normalized.policy.allowed_providers),
      blocked_providers: sorted(normalized.policy.blocked_providers),
    },
  });
}

export async function readPublicCatalog(args: Readonly<{
  key: AuthenticatedApiKey;
  limit: number;
  cursor: CatalogCursorV1 | null;
  runtime?: CatalogRuntimeCapture;
  transaction?: CatalogTransactionRunner;
}>): Promise<CatalogResponseV1> {
  const runtime = args.runtime ?? capturePublicCatalogRuntime();
  let normalized: ReturnType<typeof normalizeStoredChatFreshPolicy>;
  try {
    normalized = normalizeStoredChatFreshPolicy(args.key);
  } catch (error) {
    if (error instanceof StoredChatFreshPolicyError)
      throw new PublicCatalogError('key_policy_unavailable');
    throw error;
  }
  if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 100)
    throw new PublicCatalogError('catalog_unavailable');
  const transaction = args.transaction ?? defaultTransactionRunner;
  try {
    return await transaction(async (reader) => {
      const dbRevision = parseDbRevision(await reader.readRevision());
      const authorRevision = authorRevisionValue(await reader.readAuthorRevision());
      const modelRows = await reader.readModels(args.cursor?.after ?? null, args.limit + 1);
      if (modelRows.length > args.limit + 1) throw new PublicCatalogError('catalog_unavailable');
      const models = modelRows.map(validateModel);
      const candidateRows = await reader.readCandidates(models.map((model) => model.id));
      const counts = new Map<string, number>();
      const selectedIds = new Set(models.map((model) => model.id));
      for (const row of candidateRows) {
        const modelId = uuidValue(row.model_id);
        if (!selectedIds.has(modelId))
          throw new PublicCatalogError('catalog_unavailable');
        counts.set(modelId, (counts.get(modelId) ?? 0) + 1);
      }
      if (candidateRows.length > CATALOG_MAX_CANDIDATES_PER_PAGE || [...counts.values()].some((count) => count > CATALOG_MAX_CANDIDATES_PER_MODEL))
        throw new PublicCatalogError('catalog_unavailable');

      const catalogRevision = digest([1, dbRevision, authorRevision, runtime.runtimeProjectionRevision, keyPolicyRevision(normalized)]);
      if (args.cursor && args.cursor.catalogRevision !== catalogRevision)
        throw new PublicCatalogError('revision_changed');
      const pageModels = models.slice(0, args.limit);
      const data = Object.freeze(pageModels.map((model) => projectModel(
        model,
        candidateRows.filter((row) => row.model_id === model.id),
        runtime,
        normalized,
      )));
      const last = pageModels.at(-1);
      const nextCursor = models.length > args.limit && last
        ? encodeCatalogCursor({ schemaVersion: 1, catalogRevision, after: { slug: last.slug, modelId: last.id } })
        : null;
      return Object.freeze({
        schemaVersion: 1,
        object: 'catalog.list',
        catalogRevision,
        data,
        page: Object.freeze({ limit: args.limit, nextCursor }),
      });
    });
  } catch (error) {
    if (error instanceof PublicCatalogError) throw error;
    throw new PublicCatalogError('catalog_unavailable');
  }
}
