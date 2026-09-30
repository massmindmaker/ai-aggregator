import { describe, expect, it } from 'vitest';
import {
  decodeCatalogCursor,
  parseCatalogResponseV1,
  type CatalogAvailableItemV1,
  type CatalogItemV1,
} from '@aiag/shared/catalog-contract';
import {
  CATALOG_MAX_CANDIDATES_PER_MODEL,
  CATALOG_MAX_CANDIDATES_PER_PAGE,
  PublicCatalogError,
  capturePublicCatalogRuntime,
  readPublicCatalog,
  type CatalogCandidateRow,
  type CatalogModelRow,
  type CatalogTransactionRunner,
} from '../catalog/public-catalog';
import { captureStoredChatHttpIdentity } from '../billing/stored-chat-http-identity';
import { prepareStoredChatQuote } from '../billing/candidate-quote';
import type { AuthenticatedApiKey } from '../middleware/auth-plan04';
import type { UpstreamAdapter } from '../upstreams/interface';

const modelId = '10000000-0000-4000-8000-000000000001';
const deploymentId = '20000000-0000-4000-8000-000000000001';

const adapter = (): UpstreamAdapter => ({
  admittedChat: {
    contract: 'openrouter-pinned-provider-chat-v1',
    execute: async () => { throw new Error('must not execute'); },
  },
  chat: async () => { throw new Error('must not execute'); },
});
const combinedAdapter = (): UpstreamAdapter => ({
  ...adapter(),
  admittedEmbeddings: {
    contract: 'openrouter-pinned-provider-embeddings-v1',
    execute: async () => { throw new Error('must not execute'); },
  },
});

const runtime = (overrides: Parameters<typeof capturePublicCatalogRuntime>[0] = {}) =>
  capturePublicCatalogRuntime({
    executionMode: 'stored_chat_only',
    cachingMultiplier: '0.5',
    configuredDefaultMaxOutputTokens: 4096,
    forceMock: false,
    authorChatEnabled: true,
    authorEndpointKeyConfigured: true,
    getAdapter: () => adapter(),
    ...overrides,
  });

const key = (policies: Record<string, unknown> = {}): AuthenticatedApiKey => ({
  id: '30000000-0000-4000-8000-000000000001',
  org_id: '40000000-0000-4000-8000-000000000001',
  policies,
  rpm_limit: 10,
  batch_rpm_limit: 1,
  daily_usd_cap: null,
  model_whitelist: [],
  ru_residency_only: false,
});

const model = (overrides: Partial<CatalogModelRow> = {}): CatalogModelRow => ({
  id: modelId,
  slug: 'openai/gpt-4o-mini',
  type: 'chat',
  status: 'live',
  author_version_id: null,
  author_manifest_digest: null,
  author_price_microcredits: null,
  author_policy_digest: null,
  ...overrides,
});

/** An admitted author version: no `model_upstreams` row exists for it in production. */
const authorModel = (overrides: Partial<CatalogModelRow> = {}): CatalogModelRow =>
  model({
    slug: 'author/cool-model',
    author_version_id: '50000000-0000-4000-8000-000000000001',
    author_manifest_digest: `sha256:${'a'.repeat(64)}`,
    author_price_microcredits: '2500',
    author_policy_digest: `sha256:${'b'.repeat(64)}`,
    ...overrides,
  });

const candidate = (overrides: Partial<CatalogCandidateRow> = {}): CatalogCandidateRow => ({
  model_id: modelId,
  model_upstream_id: deploymentId,
  upstream_id: 'openrouter',
  upstream_model_id: 'openai/gpt-4o-mini',
  provider: 'neutral-provider',
  ru_residency: true,
  upstream_enabled: true,
  candidate_enabled: true,
  latency_p50_ms: 10,
  uptime: '0.9999',
  price_per_1k_input: '0.15',
  price_per_1k_output: '0.6',
  markup: '1.8',
  egress_proxy: null,
  priority: 100,
  ...overrides,
});

function runner(args: Readonly<{
  revision?: unknown;
  authorRevision?: unknown;
  models?: readonly CatalogModelRow[];
  candidates?: readonly CatalogCandidateRow[];
  calls?: string[];
}> = {}): CatalogTransactionRunner {
  return async (work) => work({
    async readRevision() { args.calls?.push('revision'); return args.revision ?? '1'; },
    async readAuthorRevision() { args.calls?.push('authorRevision'); return args.authorRevision ?? '0|||0|0'; },
    async readModels() { args.calls?.push('models'); return args.models ?? [model()]; },
    async readCandidates() { args.calls?.push('candidates'); return args.candidates ?? [candidate()]; },
  });
}

async function read(overrides: Partial<Parameters<typeof readPublicCatalog>[0]> = {}) {
  return readPublicCatalog({
    key: key(),
    limit: 20,
    cursor: null,
    runtime: runtime(),
    transaction: runner(),
    ...overrides,
  });
}

function assertAvailable(item: CatalogItemV1): asserts item is CatalogAvailableItemV1 {
  if (item.pricing === null) throw new Error('expected available');
}

describe('public catalog projector', () => {
  it('does not advertise batch invocation metadata in the batches execution mode', async () => {
    const response = await read({
      runtime: runtime({ executionMode: 'stored_chat_embeddings_completions_stream_media_batches' }),
    });
    expect(JSON.stringify(response)).not.toContain('/v1/batches');
  });

  it.each(['stored_chat_embeddings', 'stored_chat_embeddings_completions', 'stored_chat_embeddings_completions_stream', 'stored_chat_embeddings_completions_stream_media', 'stored_chat_embeddings_completions_stream_media_batches'] as const)(
    'advertises the reviewed embeddings operation in explicit combined mode %s',
    async (executionMode) => {
    const embeddingModel = model({ type: 'embedding', slug: 'openai/text-embedding-3-small' });
    const embeddingCandidate = candidate({
      upstream_model_id: 'openai/text-embedding-3-small',
      price_per_1k_input: '0.002', price_per_1k_output: '0', markup: '1.25',
    });
    const combined = runtime({ executionMode, getAdapter: () => combinedAdapter() });
    const response = parseCatalogResponseV1(await read({
      runtime: combined,
      transaction: runner({ models: [embeddingModel], candidates: [embeddingCandidate] }),
    }));
    const item = response.data[0]!;
    expect(item.availability.state).toBe('available');
    if (
      item.availability.state !== 'available' ||
      item.invocation === null ||
      item.pricing === null ||
      item.invocation.path !== '/v1/embeddings'
    )
      throw new Error('expected embeddings operation');
    expect(item.invocation.parameters).toMatchObject({
      input: { minItems: 1, maxItems: 16 }, dimensions: { const: 1536 }, encoding_format: { const: 'float' },
    });
    expect(item.capabilities[0]).toMatchObject({ id: 'embeddings.stored.float.v1', contextWindowTokensPerInput: 8192 });
    expect(item.pricing.rates.input.amount).toBe('0.0025');

    const oldMode = await read({
      runtime: runtime({ executionMode: 'stored_chat_only', getAdapter: () => combinedAdapter() }),
      transaction: runner({ models: [embeddingModel], candidates: [embeddingCandidate] }),
    });
    expect(oldMode.data[0]!.availability).toMatchObject({ state: 'unavailable', reason: 'runtime_contract_unavailable' });
    },
  );

  it('projects one strict available unattested item through all five modes', async () => {
    const response = parseCatalogResponseV1(await read());
    expect(response.data).toHaveLength(1);
    const item = response.data[0]!;
    expect(item.availability.state).toBe('available');
    assertAvailable(item);
    expect(item.deployment.id).toBe(deploymentId);
    expect(item.model.artifact).toEqual({ attestation: 'unattested', version: null, digest: null });
    expect(item.invocation.parameters.aiag_mode.availableValues).toEqual(['auto', 'fastest', 'cheapest', 'balanced', 'ru-only']);
    expect(item.pricing.rates).toEqual({
      input: { amount: '0.27', unit: 'microcredit_per_token' },
      output: { amount: '1.08', unit: 'microcredit_per_token' },
    });
    expect(JSON.stringify(response)).not.toMatch(/provider|markup|metadata|egress|secret/i);
  });

  it('pins invocation acceptance and clamp parity for omitted, 1, cap, cap+1 and MAX_SAFE_INTEGER', async () => {
    const item = (await read()).data[0]!;
    assertAvailable(item);
    const descriptor = item.invocation.parameters.max_tokens;
    expect(descriptor).toMatchObject({
      acceptedMaximum: Number.MAX_SAFE_INTEGER,
      effectiveMaximum: 16_384,
      configuredDefault: 4096,
      defaultApplied: 4096,
      normalization: 'clamp_to_effective_max',
    });
    for (const requested of [undefined, 1, 16_384, 16_385, Number.MAX_SAFE_INTEGER]) {
      const identity = captureStoredChatHttpIdentity({
        body: { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'x' }], ...(requested === undefined ? {} : { max_tokens: requested }) },
        idempotencyKey: 'idempotent',
        declaredSessionId: null,
      });
      const quote = prepareStoredChatQuote({
        model: {
          slug: 'openai/gpt-4o-mini', type: 'chat',
          candidates: [{
            id: 'openrouter', upstream_id: 'openrouter', upstream_model_id: 'openai/gpt-4o-mini', provider: 'neutral-provider',
            ru_residency: true, price_per_1k_input: 0.15, price_per_1k_output: 0.6, markup: 1.8,
            latency_p50_ms: 10, uptime: 1, billing: { modelUpstreamId: deploymentId, prices: { inputCentsPer1k: '0.15', outputCentsPer1k: '0.6', markup: '1.8' } },
          }],
        },
        requestedMode: 'auto', policy: {}, clientMaxTokens: identity.attemptBody.max_tokens,
        defaultMaxOutputTokens: descriptor.configuredDefault, getAdapter: () => adapter(),
      });
      expect(quote.status).toBe('ready');
      if (quote.status === 'ready')
        expect(quote.candidates[0]!.maxOutputTokens).toBe(Math.min(requested ?? descriptor.defaultApplied, descriptor.effectiveMaximum));
    }
  });

  it('checks revision, author revision, models and raw candidates in fixed transaction order', async () => {
    const calls: string[] = [];
    await read({ transaction: runner({ calls }) });
    expect(calls).toEqual(['revision', 'authorRevision', 'models', 'candidates']);
  });

  it('advertises an admitted author version as its own author-owned deployment', async () => {
    const response = parseCatalogResponseV1(await read({
      transaction: runner({ models: [authorModel()], candidates: [] }),
    }));
    const item = response.data[0]!;
    expect(item.availability.state).toBe('available');
    if (item.availability.state !== 'available' || !('ownedBy' in item))
      throw new Error('expected an author item');
    expect(item.ownedBy).toBe('author');
    expect(item.deployment).toMatchObject({
      id: '50000000-0000-4000-8000-000000000001',
      contract: 'stored-author-chat-v1',
    });
    expect(item.pricing?.rates).toEqual({ request: { amount: '2500', unit: 'microcredit_per_request' } });
    expect(item.invocation?.parameters.max_tokens).toMatchObject({
      effectiveMaximum: 4096, configuredDefault: 1024, defaultApplied: 1024,
    });
    expect(item.capabilities[0]).toMatchObject({
      id: 'chat.completions.stored.author.v1', contextWindowTokens: null,
    });
    // An author version is never dressed as an ordinary upstream deployment.
    expect(item.pricing).not.toHaveProperty('rates.input');
    expect(JSON.stringify(item)).not.toMatch(/markup|egress|provider|token_envelope/i);
  });

  it('reprices an author version on a policy change while keeping its deployment identity', async () => {
    const before = (await read({ transaction: runner({ models: [authorModel()], candidates: [] }) })).data[0]!;
    const repriced = (await read({
      transaction: runner({ models: [authorModel({ author_price_microcredits: '4000' })], candidates: [] }),
    })).data[0]!;
    expect(repriced.model.id).toBe(before.model.id);
    if (before.pricing === null || repriced.pricing === null) throw new Error('expected available');
    expect(repriced.deployment?.configurationRevision).toBe(before.deployment?.configurationRevision);
    expect(repriced.pricing.revision).not.toBe(before.pricing.revision);
    expect(repriced.pricing.rates.request.amount).toBe('4000');
  });

  it.each([
    ['author chat disabled', runtime({ authorChatEnabled: false }), 'runtime_contract_unavailable'],
    ['endpoint key missing', runtime({ authorEndpointKeyConfigured: false }), 'service_configuration_unavailable'],
    ['legacy execution', runtime({ executionMode: 'legacy' }), 'runtime_contract_unavailable'],
    ['frozen', runtime(), 'model_frozen'],
  ] as const)('author version stays unadvertised when %s', async (_name, capture, reason) => {
    const modelRow = _name === 'frozen' ? authorModel({ status: 'frozen' }) : authorModel();
    const result = await read({ runtime: capture, transaction: runner({ models: [modelRow], candidates: [] }) });
    expect(result.data[0]!.availability).toMatchObject({ state: 'unavailable', reason });
  });

  it.each([
    ['whitelist', { ...key(), model_whitelist: ['other'] } as AuthenticatedApiKey],
    ['ru-only key', key({ default_mode: 'ru-only' })],
    ['ru-residency-only key', { ...key(), ru_residency_only: true } as AuthenticatedApiKey],
    ['blocked author provider', key({ blocked_providers: ['author'] })],
    ['allowed providers without author', key({ allowed_providers: ['openrouter'] })],
  ] as const)('author version is key-policy excluded for %s', async (_name, apiKey) => {
    const result = await read({ key: apiKey, transaction: runner({ models: [authorModel()], candidates: [] }) });
    expect(result.data[0]!.availability).toMatchObject({ state: 'unavailable', reason: 'key_policy_excludes_model' });
  });

  it('fails closed on a malformed author identity or a zero price', async () => {
    for (const overrides of [
      { author_manifest_digest: 'not-a-digest' },
      { author_policy_digest: 'not-a-digest' },
      { author_price_microcredits: '0' },
      { author_version_id: 'not-a-uuid' },
    ]) {
      await expect(
        read({ transaction: runner({ models: [authorModel(overrides)], candidates: [] }) }),
      ).rejects.toMatchObject({ kind: 'catalog_unavailable' });
    }
  });

  it('never lets an author version advertise a non-chat operation', async () => {
    // `AuthorManifestV1` pins `model.type` to the literal "chat" (zod), so an
    // admitted author version can never be an STT/transcription deployment; the
    // catalog projector refuses every other type regardless of the DB row.
    for (const type of ['embedding', 'audio', 'image', 'video', 'completion']) {
      const result = await read({
        transaction: runner({ models: [authorModel({ type })], candidates: [] }),
      });
      expect(result.data[0]!.availability).toMatchObject({ state: 'unavailable', reason: 'no_admitted_deployment' });
    }
  });

  it('folds author admission facts into the catalog revision so cursors cannot outlive a policy change', async () => {
    const models = [
      authorModel(),
      authorModel({ id: '10000000-0000-4000-8000-000000000009', slug: 'author/next' }),
    ];
    const first = await read({ limit: 1, transaction: runner({ authorRevision: '1|||0|0', models }) });
    const cursor = decodeCatalogCursor(first.page.nextCursor!);
    await expect(
      read({ limit: 1, cursor, transaction: runner({ authorRevision: '2|||0|0', models }) }),
    ).rejects.toMatchObject({ kind: 'revision_changed' });
  });

  it('accepts exactly 16 raw candidates but rejects 17 before malformed pricing projection', async () => {
    const sixteen = Array.from({ length: CATALOG_MAX_CANDIDATES_PER_MODEL }, (_, index) => candidate({
      model_upstream_id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      candidate_enabled: index !== 0,
    }));
    expect((await read({ transaction: runner({ candidates: sixteen }) })).data).toHaveLength(1);
    const seventeen = [...sixteen, candidate({
      model_upstream_id: '20000000-0000-4000-8000-000000000017',
      price_per_1k_input: 'not-a-price',
    })];
    await expect(read({ transaction: runner({ candidates: seventeen }) })).rejects.toMatchObject({ kind: 'catalog_unavailable' });
  });

  it('rejects page row 513 and arbitrarily large injected fan-out as one bounded failure', async () => {
    const boundedModels = Array.from({ length: 32 }, (_, index) => model({
      id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    }));
    const boundedRows = boundedModels.flatMap((modelRow, modelIndex) =>
      Array.from({ length: CATALOG_MAX_CANDIDATES_PER_MODEL }, (_, candidateIndex) => candidate({
        model_id: modelRow.id,
        model_upstream_id: `20000000-0000-4000-8000-${String(modelIndex * CATALOG_MAX_CANDIDATES_PER_MODEL + candidateIndex + 1).padStart(12, '0')}`,
        candidate_enabled: candidateIndex === 0,
      })),
    );
    expect(boundedRows).toHaveLength(CATALOG_MAX_CANDIDATES_PER_PAGE);
    expect((await read({ limit: 32, transaction: runner({ models: boundedModels, candidates: boundedRows }) })).data).toHaveLength(32);
    const rows = Array.from({ length: CATALOG_MAX_CANDIDATES_PER_PAGE + 1 }, (_, index) => candidate({
      model_upstream_id: `20000000-0000-4000-${(0x8000 + Math.floor(index / 10)).toString(16)}-${String(index + 1).padStart(12, '0')}`,
      model_id: `10000000-0000-4000-8000-${String(Math.floor(index / 16) + 1).padStart(12, '0')}`,
    }));
    await expect(read({ transaction: runner({ candidates: rows }) })).rejects.toBeInstanceOf(PublicCatalogError);
    await expect(read({ transaction: runner({ candidates: Array.from({ length: 5000 }, (_, index) => rows[index % rows.length]!) }) })).rejects.toMatchObject({ kind: 'catalog_unavailable' });
  });

  it('fails ambiguous quote candidates instead of blending deployments', async () => {
    const result = await read({ transaction: runner({ candidates: [candidate(), candidate({ model_upstream_id: '20000000-0000-4000-8000-000000000002', priority: 101 })] }) });
    expect(result.data[0]!.availability).toMatchObject({ state: 'unavailable', reason: 'runtime_contract_unavailable' });
  });

  it.each([
    ['frozen', key(), runtime(), model({ status: 'frozen' }), candidate(), 'model_frozen'],
    ['legacy', key(), runtime({ executionMode: 'legacy' }), model(), candidate(), 'runtime_contract_unavailable'],
    ['whitelist', { ...key(), model_whitelist: ['other'] } as AuthenticatedApiKey, runtime(), model(), candidate(), 'key_policy_excludes_model'],
    ['unconfigured', key(), runtime({ getAdapter: () => ({ chat: adapter().chat }) }), model(), candidate(), 'service_configuration_unavailable'],
    ['unreviewed', key(), runtime(), model(), candidate({ upstream_model_id: 'invented/from-metadata' }), 'no_admitted_deployment'],
    ['all-zero shared quote', key(), runtime(), model(), candidate({ price_per_1k_input: '0', price_per_1k_output: '0' }), 'no_admitted_deployment'],
    ['maximum overflow', key(), runtime(), model(), candidate({ price_per_1k_input: '1000000000000000' }), 'retail_pricing_unavailable'],
  ] as const)('%s uses fixed reason precedence', async (_name, apiKey, capture, modelRow, candidateRow, reason) => {
    const result = await read({ key: apiKey, runtime: capture, transaction: runner({ models: [modelRow], candidates: [candidateRow] }) });
    expect(result.data[0]!.availability).toMatchObject({ state: 'unavailable', reason });
  });

  it.each([
    { price_per_1k_input: '0', price_per_1k_output: '0.6' },
    { price_per_1k_input: '0.15', price_per_1k_output: '0' },
  ])('keeps an individually zero rate available when the shared maximum is positive: %j', async (prices) => {
    const result = await read({
      transaction: runner({ candidates: [candidate(prices)] }),
    });
    expect(result.data[0]!.availability.state).toBe('available');
  });

  it('runtime readiness and force-mock alter revision, secret rotation does not', async () => {
    let secret = 'first-secret-value';
    const captureConfigured = () => runtime({ getAdapter: () => { void secret; return adapter(); } });
    const configuredA = captureConfigured();
    secret = 'rotated-secret-value';
    const configuredB = captureConfigured();
    const missing = runtime({ getAdapter: () => { throw new Error('missing'); } });
    const forced = runtime({ forceMock: true, getAdapter: () => adapter() });
    expect(configuredA.runtimeProjectionRevision).toBe(configuredB.runtimeProjectionRevision);
    expect(missing.runtimeProjectionRevision).not.toBe(configuredA.runtimeProjectionRevision);
    expect(forced.runtimeProjectionRevision).not.toBe(missing.runtimeProjectionRevision);
    const first = await read({ limit: 1, runtime: configuredA, transaction: runner({ models: [model(), model({ id: '10000000-0000-4000-8000-000000000002', slug: 'z' })] }) });
    const cursor = decodeCatalogCursor(first.page.nextCursor!);
    await expect(read({ limit: 1, cursor, runtime: missing })).rejects.toMatchObject({ kind: 'revision_changed' });
  });

  it('uses immutable runtime capture after mutable readiness changes', async () => {
    let ready = true;
    const captured = runtime({ getAdapter: () => ready ? adapter() : (() => { throw new Error('missing'); })() });
    ready = false;
    const result = await read({ runtime: captured });
    expect(result.data[0]!.availability.state).toBe('available');
  });

  it('preserves identities/config revision for price-only changes and reflects lifecycle changes truthfully', async () => {
    const beforeResponse = await read({ transaction: runner({ revision: '10' }) });
    const priceResponse = await read({ transaction: runner({ revision: '11', candidates: [candidate({ price_per_1k_input: '0.2' })] }) });
    const configResponse = await read({ transaction: runner({ revision: '12', candidates: [candidate({ ru_residency: false })] }) });
    const recreatedResponse = await read({ transaction: runner({ revision: '13', candidates: [candidate({ model_upstream_id: '20000000-0000-4000-8000-000000000099' })] }) });
    const before = beforeResponse.data[0]!;
    const price = priceResponse.data[0]!;
    const configChange = configResponse.data[0]!;
    const recreated = recreatedResponse.data[0]!;
    assertAvailable(before);
    assertAvailable(price);
    assertAvailable(configChange);
    assertAvailable(recreated);
    expect(price.model.id).toBe(before.model.id);
    expect(price.deployment.id).toBe(before.deployment.id);
    expect(price.deployment.configurationRevision).toBe(before.deployment.configurationRevision);
    expect(price.pricing.revision).not.toBe(before.pricing.revision);
    expect(configChange.deployment.id).toBe(before.deployment.id);
    expect(configChange.deployment.configurationRevision).not.toBe(before.deployment.configurationRevision);
    expect(recreated.deployment.id).not.toBe(before.deployment.id);
    expect(new Set([before.model.artifact.version, price.model.artifact.digest, recreated.model.artifact.version])).toEqual(new Set([null]));
    expect(new Set([
      beforeResponse.catalogRevision,
      priceResponse.catalogRevision,
      configResponse.catalogRevision,
      recreatedResponse.catalogRevision,
    ])).toHaveLength(4);
  });

  it('changes catalog revision for DB and normalized key-policy facts and stales cursors', async () => {
    const models = [model(), model({ id: '10000000-0000-4000-8000-000000000002', slug: 'z' })];
    const first = await read({ limit: 1, transaction: runner({ revision: '20', models }) });
    const cursor = decodeCatalogCursor(first.page.nextCursor!);
    await expect(read({ limit: 1, cursor, transaction: runner({ revision: '21', models }) })).rejects.toMatchObject({ kind: 'revision_changed' });
    await expect(read({ limit: 1, cursor, key: key({ default_mode: 'fastest' }), transaction: runner({ revision: '20', models }) })).rejects.toMatchObject({ kind: 'revision_changed' });
  });

  it('fails closed on invalid revision/model/candidate/policy shapes and ignores descriptive extras', async () => {
    await expect(read({ transaction: runner({ revision: '0' }) })).rejects.toMatchObject({ kind: 'catalog_unavailable' });
    await expect(read({ transaction: runner({ models: [model({ type: 'invented' })] }) })).rejects.toMatchObject({ kind: 'catalog_unavailable' });
    await expect(read({ transaction: runner({ candidates: [candidate({ markup: '1e0' })] }) })).rejects.toMatchObject({ kind: 'catalog_unavailable' });
    await expect(read({ key: key({ unknown: true }) })).rejects.toMatchObject({ kind: 'key_policy_unavailable' });
    expect(() => runtime({ executionMode: 'invalid' as 'legacy' })).toThrow('CATALOG_UNAVAILABLE');
    const withMetadata = { ...candidate(), metadata: { capability: 'tools', version: 'invented' } };
    const result = await read({ transaction: runner({ candidates: [withMetadata] }) });
    expect(result.data[0]!.availability.state).toBe('available');
    expect(JSON.stringify(result)).not.toContain('invented');
  });
});
