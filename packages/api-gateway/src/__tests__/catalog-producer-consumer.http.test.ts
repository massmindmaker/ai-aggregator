import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogResponseV1 } from '@aiag/shared/catalog-contract';
import {
  CatalogConsumerError,
  consumePublicCatalog,
  type CatalogConsumerFetch,
  type CatalogConsumeResult,
} from './fixtures/catalog-consumer';

/**
 * Producer-consumer proof over the real gateway assembly: the producer is the
 * actual readPublicCatalog projector behind the actual Hono route/auth chain
 * with controlled SQL/Redis/provider mechanics, and the consumer is the AG
 * fixture parsing the producer JSON strictly. No network, no paid providers.
 */

const state = vi.hoisted(() => ({
  revision: '7',
  authorRevision: '0|||0|0',
  models: [] as Array<Record<string, unknown>>,
  candidates: [] as Array<Record<string, unknown>>,
  keys: {} as Record<string, unknown | null>,
  failRevision: false,
  failCandidates: false,
  // Every query text the double is handed, in order (H-3: see the admission
  // branch below — the predicate arrives as its own invocation).
  queries: [] as string[],
  // Which branch handled each query. The admission fragment must be handled by
  // the `author_probe_operations` branch, not fall through to the throw.
  handled: [] as string[],
}));

vi.mock('../lib/db', () => {
  const tx = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(' ');
    state.queries.push(query);
    if (query.includes('aiag_read_gateway_catalog_revision_v1')) {
      if (state.failRevision) throw new Error('storage-diagnostic-secret');
      return [{ revision: state.revision }];
    }
    // Author-admission aggregates; matched before the model page query because
    // the model page itself joins `author_model_versions` in a lateral.
    if (query.includes('concat_ws')) {
      return [{ revision: state.authorRevision }];
    }
    if (query.includes('FROM models')) {
      // The page query interpolates the author-admission fragment first, so the
      // cursor parameters are the trailing non-fragment values.
      const parameters = values.filter((value) => typeof value === 'string' || value === null);
      const afterSlug = parameters[0] as string | null;
      const afterId = parameters[1] as string | null;
      const sorted = [...state.models].sort((a, b) => a.slug === b.slug ? a.id.localeCompare(b.id) : a.slug.localeCompare(b.slug));
      return sorted.filter(m => afterSlug === null || m.slug > afterSlug || (m.slug === afterSlug && m.id > afterId!)).slice(0, Number(values.at(-1)));
    }
    if (query.includes('FROM unnest')) {
      if (state.failCandidates) throw new Error('storage-diagnostic-secret');
      return state.candidates.filter(row => (values[0] as string[]).includes(row.model_id as string));
    }
    // H-3: this branch IS reachable, and the old comment here said the
    // opposite. postgres.js inlines a nested fragment into the parent
    // statement when the parent is finally sent — but the tagged template is
    // still *invoked* on its own to build that fragment, so this double is
    // called once with the admission predicate alone as its query text. That
    // text contains `FROM author_probe_operations` / `FROM users`, not
    // `FROM models`, so the check above does not swallow it and control really
    // does reach here. (The wave review claimed the opposite from substring
    // offsets; dropping the branch on that basis left 24 green tests and 14
    // unhandled rejections, because the discarded return value is never
    // awaited.) Its return value is discarded: postgres.js resolves the
    // fragment into the parent query, so there is no standalone result set.
    // The predicate's own clauses are covered by author-admission-predicate.test.ts.
    if (query.includes('author_probe_operations')) {
      state.handled.push('admission');
      return [];
    }
    state.handled.push('unexpected');
    throw new Error('Unexpected SQL in catalogue HTTP test');
  }, { array: (value: unknown) => value });
  return { sql: { begin: async (_isolation: string, work: (sql: typeof tx) => unknown) => work(tx) } };
});

vi.mock('../egress-executor', () => ({ registerGatewayEgressExecutor: vi.fn() }));
vi.mock('../middleware/rate-limit-plan04', () => ({
  rateLimit: async (_c: unknown, next: () => Promise<void>) => { await next(); },
  rpmOnly: vi.fn(),
}));
vi.mock('../middleware/key-limits', () => ({
  keyLimits: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));
vi.mock('../middleware/pii-filter', () => ({
  piiFilter: async (_c: unknown, next: () => Promise<void>) => { await next(); },
  // server.ts wires the resolver seam at boot (F-3); the mock must mirror it.
  setPiiResolveModel: vi.fn(),
}));
vi.mock('../middleware/model-status-check', () => ({
  modelStatusMiddleware: () => async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));
// Controlled provider mechanics: the reviewed openrouter profile resolves to a
// locally configured adapter that must never execute (catalog is advisory).
vi.mock('../upstreams/registry', () => ({
  getUpstream: () => ({
    admittedChat: {
      contract: 'openrouter-pinned-provider-chat-v1',
      execute: async () => { throw new Error('must not execute'); },
    },
    chat: async () => { throw new Error('must not execute'); },
  }),
}));

type ServerApp = { fetch(input: string, init?: RequestInit): Promise<Response> };

const validKey = 'sk_aiag_test_producerconsumer000000000000';
const apiKeyRow = {
  id: '30000000-0000-4000-8000-000000000001',
  org_id: '40000000-0000-4000-8000-000000000001',
  policies: {},
  rpm_limit: 10,
  batch_rpm_limit: 1,
  daily_usd_cap: null,
  model_whitelist: [],
  ru_residency_only: false,
};

const modelId = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const deploymentId = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const model = (n: number, slug: string) => ({
  id: modelId(n), slug, type: 'chat', status: 'live',
  author_version_id: null, author_manifest_digest: null,
  author_price_microcredits: null, author_policy_digest: null,
});

const candidate = (n: number, slugRowId: string) => ({
  model_id: slugRowId,
  model_upstream_id: deploymentId(n),
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
});

/** An admitted author version. It has no `model_upstreams` row in production. */
const authorModel = (n: number, slug: string) => ({
  ...model(n, slug),
  author_version_id: `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  author_manifest_digest: `sha256:${'a'.repeat(64)}`,
  author_price_microcredits: '2500',
  author_policy_digest: `sha256:${'b'.repeat(64)}`,
});

function seedTwoModels(): void {
  state.models = [model(1, 'openai/gpt-4o-mini'), model(2, 'zeta/second-model')];
  state.candidates = [candidate(1, modelId(1)), candidate(2, modelId(2))];
}

// This hook imports the full real server graph. Give only boot a60s budget;
// provider and HTTP contract timeouts remain unchanged.
async function boot(
  mode: 'legacy' | 'stored_chat_only',
  authorChat: { enabled: boolean; key: boolean } = { enabled: false, key: false },
): Promise<ServerApp> {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('GATEWAY_HTTP_EXECUTION_MODE', mode);
  vi.stubEnv('AUTHOR_CHAT_ENABLED', authorChat.enabled ? '1' : '0');
  vi.stubEnv('AUTHOR_ENDPOINT_KEK', authorChat.key ? 'test-author-kek' : '');
  const auth = await import('../middleware/auth-plan04');
  auth.setApiKeyResolver(async (plain) => (state.keys[plain] as typeof apiKeyRow | undefined) ?? null);
  const { app } = await import('../server');
  return { fetch: async (input, init) => app.request(input, init) };
}

function consumerFetch(app: ServerApp): CatalogConsumerFetch & { requests: Array<{ url: string; init: RequestInit }> } {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn: CatalogConsumerFetch = (url, init) => {
    requests.push({ url, init: init ?? {} });
    return app.fetch(url, init);
  };
  return Object.assign(fetchFn, { requests });
}

describe('public catalog producer-consumer over the real HTTP chain', () => {
  beforeEach(() => {
    state.revision = '7';
    state.keys = { [validKey]: apiKeyRow };
    state.failRevision = false;
    state.failCandidates = false;
    state.queries = [];
    state.handled = [];
    seedTwoModels();
  });

  describe('admission predicate reaches this double as its own invocation (H-3)', () => {
    it('the predicate is invoked standalone, so the author_probe_operations branch is live', async () => {
      const app = await boot('stored_chat_only');
      await app.fetch('http://gateway.test/v1/catalog?limit=20', {
        headers: { authorization: `Bearer ${validKey}` },
      });

      // The wave review read this double's source and concluded the
      // `author_probe_operations` branch below was unreachable, because
      // postgres.js supposedly inlines the fragment into the parent query. It
      // does inline it — into the statement that is finally SENT — but the
      // tagged template is still invoked on its own to build the fragment, and
      // that invocation lands here with the predicate as the whole query text.
      // Asserted here so the claim cannot be re-derived from offsets and used to
      // delete a reachable branch again.
      //
      // `probe.state` identifies the admission fragment; the revision aggregate
      // also mentions author_probe_operations but is matched earlier, by
      // `concat_ws`.
      const fragment = state.queries.filter((q) => q.includes('probe.state'));
      expect(fragment.length).toBeGreaterThan(0);
      // ...and it is a separate invocation, not the page query: no `FROM models`
      // in it, which is why the earlier check does not match it.
      expect(fragment[0]).not.toContain('FROM models');
      expect(fragment[0]).toContain('author_probe_operations probe');
      // Control reaches the admission branch rather than falling through to the
      // `Unexpected SQL` throw. Without this, deleting the branch leaves the
      // suite green (the fragment's return value is never awaited, so the
      // rejection surfaces only as an unhandled error).
      expect(state.handled).toContain('admission');
      expect(state.handled).not.toContain('unexpected');
    });
  });

  describe('stored_chat_only: available producer output parses strictly in the consumer', () => {
    let app: ServerApp;
    beforeAll(async () => { app = await boot('stored_chat_only'); }, 60_000);

    it('consumes one bounded page with an available advisory item and a synthetic bearer key', async () => {
      const fetchFn = consumerFetch(app);
      const result = await consumePublicCatalog({ baseUrl: 'http://gateway.test', apiKey: validKey, fetch: fetchFn, pageLimit: 20 });
      expect(fetchFn.requests).toHaveLength(1);
      expect(fetchFn.requests[0]!.init.method).toBe('GET');
      expect(String(fetchFn.requests[0]!.url)).toBe('http://gateway.test/v1/catalog?limit=20');
      expect((fetchFn.requests[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${validKey}`);
      expect(result.pages).toBe(1);
      const item = result.items[0]!;
      expect(item.availability).toMatchObject({ state: 'available', reason: null });
      if (item.pricing === null) throw new Error('expected available producer item');
      expect(item.pricing.rates.input.amount).toBe('0.27');
      expect(item.pricing.settlementUnit).toBe('microcredit');
      expect(item.invocation!.path).toBe('/v1/chat/completions');
    });

    it('paginates through producer cursors within bounded inputs and parses every page', async () => {
      const fetchFn = consumerFetch(app);
      const result = await consumePublicCatalog({ baseUrl: 'http://gateway.test', apiKey: validKey, fetch: fetchFn, pageLimit: 1, maxPages: 3 });
      expect(result.pages).toBe(2);
      expect(result.items).toHaveLength(2);
      expect(result.items.map((item) => item.model.slug)).toEqual(['openai/gpt-4o-mini', 'zeta/second-model']);
      const secondUrl = new URL(String(fetchFn.requests[1]!.url));
      expect(secondUrl.searchParams.get('cursor')).toBeTruthy();
      expect(result.preflight.availability).toBe('mixed');
      expect(result.preflight.modes).toEqual(['auto', 'fastest', 'cheapest', 'balanced', 'ru-only']);
      expect(result.preflight.settlementUnit).toBe('microcredit');
      expect(result.preflight.revision).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(result.preflight.revisionVerified).toBe(true);
    });

    it('maps a stale producer revision to a safe 409 consumer failure without internals', async () => {
      let first = true;
      const stalking: CatalogConsumerFetch = async (url, init) => {
        if (!first) state.revision = '8';
        first = false;
        return app.fetch(url, init);
      };
      const attempt = consumePublicCatalog({ baseUrl: 'http://gateway.test', apiKey: validKey, fetch: stalking, pageLimit: 1, maxPages: 3 });
      await expect(attempt).rejects.toBeInstanceOf(CatalogConsumerError);
      const error = await attempt.then(unexpectedSuccess, catalogFailure);
      expect(error.kind).toBe('http');
      expect(error.status).toBe(409);
      expect(error.code).toBe('CATALOG_REVISION_CHANGED');
      expect(error.message).not.toMatch(/sha256|storage|secret/i);
    });

    it('keeps the producer envelope free of forbidden serialization', async () => {
      const response = await app.fetch('http://gateway.test/v1/catalog?limit=20', { headers: { authorization: `Bearer ${validKey}` } });
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(text).not.toMatch(/provider|markup|metadata|egress|secret|key_hash/i);
      const parsed = JSON.parse(text) as CatalogResponseV1;
      expect(parsed.object).toBe('catalog.list');
    });
  });

  describe('stored_chat_only with author chat: author versions are purchasable over HTTP', () => {
    let app: ServerApp;
    beforeAll(async () => {
      app = await boot('stored_chat_only', { enabled: true, key: true });
    }, 60_000);
    beforeEach(() => {
      state.models = [authorModel(3, 'author/cool-model')];
      state.candidates = [];
    });

    it('parses an author-owned available item strictly in the consumer', async () => {
      const result = await consumePublicCatalog({
        baseUrl: 'http://gateway.test', apiKey: validKey,
        fetch: consumerFetch(app), pageLimit: 20,
      });
      expect(result.pages).toBe(1);
      const item = result.items[0]!;
      expect(item.availability.state).toBe('available');
      if (!('ownedBy' in item)) throw new Error('expected an author item');
      expect(item.ownedBy).toBe('author');
      expect(item.deployment).toMatchObject({ contract: 'stored-author-chat-v1' });
      expect(item.pricing?.rates).toEqual({ request: { amount: '2500', unit: 'microcredit_per_request' } });
      expect(result.preflight.invocationPath).toBe('/v1/chat/completions');
      expect(result.preflight.settlementUnit).toBe('microcredit');
    });
  });

  describe('stored_chat_only with author chat disabled: the same version is not purchasable', () => {
    let app: ServerApp;
    beforeAll(async () => {
      app = await boot('stored_chat_only', { enabled: false, key: true });
    }, 60_000);
    beforeEach(() => {
      state.models = [authorModel(3, 'author/cool-model')];
      state.candidates = [];
    });

    it('advertises the author version as unavailable with no pricing', async () => {
      const result = await consumePublicCatalog({
        baseUrl: 'http://gateway.test', apiKey: validKey,
        fetch: consumerFetch(app), pageLimit: 20,
      });
      const item = result.items[0]!;
      expect(item.availability).toMatchObject({ state: 'unavailable', reason: 'runtime_contract_unavailable' });
      expect(item.pricing).toBeNull();
      expect(item.deployment).toBeNull();
    });
  });

  describe('legacy mode: advertised unavailable output parses strictly', () => {
    let app: ServerApp;
    beforeAll(async () => { app = await boot('legacy'); }, 60_000);

    it('consumes unavailable advisory items with fixed reasons and no pricing', async () => {
      const result = await consumePublicCatalog({ baseUrl: 'http://gateway.test', apiKey: validKey, fetch: consumerFetch(app), pageLimit: 20 });
      expect(result.items).toHaveLength(2);
      for (const item of result.items) {
        expect(item.availability).toMatchObject({ state: 'unavailable', reason: 'runtime_contract_unavailable', liveUpstreamHealthChecked: false });
        expect(item.pricing).toBeNull();
        expect(item.deployment).toBeNull();
      }
      expect(result.preflight.availability).toBe('all_unavailable');
      expect(result.preflight.modes).toEqual([]);
      expect(result.preflight.settlementUnit).toBeNull();
    });
  });

  describe('fixed safe failure handling over the real chain', () => {
    let app: ServerApp;
    beforeAll(async () => { app = await boot('stored_chat_only'); }, 60_000);

    it('maps 401 from the real auth chain to a safe consumer failure', async () => {
      const intruder = consumePublicCatalog({ baseUrl: 'http://gateway.test', apiKey: 'sk_aiag_test_wrong', fetch: consumerFetch(app), pageLimit: 20 });
      const error = await intruder.then(unexpectedSuccess, catalogFailure);
      expect(error).toBeInstanceOf(CatalogConsumerError);
      expect(error.kind).toBe('http');
      expect(error.status).toBe(401);
      expect(error.code).toBe('UNAUTHORIZED');
    });

    it('maps 503 producer storage failure safely and leaks no diagnostics', async () => {
      state.failCandidates = true;
      const attempt = consumePublicCatalog({ baseUrl: 'http://gateway.test', apiKey: validKey, fetch: consumerFetch(app), pageLimit: 20 });
      const error = await attempt.then(unexpectedSuccess, catalogFailure);
      expect(error).toBeInstanceOf(CatalogConsumerError);
      expect(error.kind).toBe('http');
      expect(error.status).toBe(503);
      expect(error.code).toBe('CATALOG_UNAVAILABLE');
      expect(error.retryAfter).toBe('2');
      expect(JSON.stringify(error)).not.toContain('storage-diagnostic-secret');
    });

    it('treats transport-level rejection as a network failure', async () => {
      const broken: CatalogConsumerFetch = async () => { throw new Error('socket exploded'); };
      const error = await consumePublicCatalog({ baseUrl: 'http://gateway.test', apiKey: validKey, fetch: broken, pageLimit: 20 })
        .then(unexpectedSuccess, catalogFailure);
      expect(error).toBeInstanceOf(CatalogConsumerError);
      expect(error.kind).toBe('network');
      expect(error.message).not.toContain('socket exploded');
    });
  });

  describe('strict consumer parsing of malformed and unknown producer fields', () => {
    const okEnvelope = (): Record<string, unknown> => ({
      schemaVersion: 1,
      object: 'catalog.list',
      catalogRevision: `sha256:${'a'.repeat(64)}`,
      data: [],
      page: { limit: 20, nextCursor: null },
    });
    const okFetch = (body: unknown | string): CatalogConsumerFetch => async () => new Response(
      typeof body === 'string' ? body : JSON.stringify(body),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

    it('rejects unknown top-level response fields', async () => {
      const body = { ...okEnvelope(), debug: { internal: true } };
      const error = await consumePublicCatalog({ baseUrl: 'http://x', apiKey: validKey, fetch: okFetch(body), pageLimit: 20 })
        .then(unexpectedSuccess, catalogFailure);
      expect(error.kind).toBe('schema');
      expect(JSON.stringify(error)).not.toContain('internal');
    });

    it('rejects malformed JSON bodies', async () => {
      const error = await consumePublicCatalog({ baseUrl: 'http://x', apiKey: validKey, fetch: okFetch('<html>gateway boom</html>'), pageLimit: 20 })
        .then(unexpectedSuccess, catalogFailure);
      expect(error.kind).toBe('schema');
    });

    it('rejects unknown fields inside a catalog item', async () => {
      const item = {
        object: 'catalog.model',
        model: { id: modelId(1), slug: 'openai/gpt-4o-mini', type: 'chat', artifact: { attestation: 'unattested', version: null, digest: null } },
        availability: { state: 'unavailable', scope: 'advertised_contract', reason: 'model_frozen', liveUpstreamHealthChecked: false },
        deployment: null,
        invocation: null,
        capabilities: [],
        pricing: null,
        runtimeHint: 'internal-only',
      };
      const error = await consumePublicCatalog({ baseUrl: 'http://x', apiKey: validKey, fetch: okFetch({ ...okEnvelope(), data: [item] }), pageLimit: 20 })
        .then(unexpectedSuccess, catalogFailure);
      expect(error.kind).toBe('schema');
    });

    it('enforces bounded pagination inputs before any request is made', async () => {
      for (const pageLimit of [0, 101, Number.NaN]) {
        const error = await consumePublicCatalog({ baseUrl: 'http://x', apiKey: validKey, fetch: okFetch(okEnvelope()), pageLimit })
          .then(unexpectedSuccess, catalogFailure);
        expect(error.kind).toBe('input');
      }
    });

    it('stops at the bounded page budget instead of following endless cursors', async () => {
      const app = await boot('stored_chat_only');
      const error = await consumePublicCatalog({ baseUrl: 'http://gateway.test', apiKey: validKey, fetch: consumerFetch(app), pageLimit: 1, maxPages: 1 })
        .then(unexpectedSuccess, catalogFailure);
      expect(error.kind).toBe('exhausted');
    });

    it('preflight stays advisory: no price, amount, budget or lock fields exist', async () => {
      const result: CatalogConsumeResult = await consumePublicCatalog({ baseUrl: 'http://x', apiKey: validKey, fetch: okFetch(okEnvelope()), pageLimit: 20 });
      expect(Object.keys(result.preflight).join('|')).not.toMatch(/price|amount|budget|cost|lock|charge/i);
    });
  });

  describe('controller regression review: safe multi-page client', () => {
    it('rejects a silently changed revision even when both HTTP responses are 200', async () => {
      const app = await boot('stored_chat_only');
      let calls = 0;
      const fetchFn: CatalogConsumerFetch = async (url, init) => {
        const response = await app.fetch(url, init);
        const body = await response.json() as CatalogResponseV1;
        return new Response(JSON.stringify(++calls === 2 ? { ...body, catalogRevision: `sha256:${'b'.repeat(64)}` } : body), { status: 200 });
      };
      const error = await consumePublicCatalog({ baseUrl: 'http://gateway.test', apiKey: validKey, fetch: fetchFn, pageLimit: 1 })
        .then(unexpectedSuccess, catalogFailure);
      expect(error.kind).toBe('schema');
    });

    it('rejects replayed pages instead of returning duplicate models', async () => {
      const app = await boot('stored_chat_only');
      const first = await app.fetch('http://gateway.test/v1/catalog?limit=1', { headers: { authorization: `Bearer ${validKey}` } });
      const body = await first.text();
      const repeated: CatalogConsumerFetch = async () => new Response(body, { status: 200 });
      const error = await consumePublicCatalog({ baseUrl: 'http://gateway.test', apiKey: validKey, fetch: repeated, pageLimit: 1, maxPages: 3 })
        .then(unexpectedSuccess, catalogFailure);
      expect(error.kind).toBe('schema');
    });

    it('sanitizes unrecognized error codes and invalid retry headers', async () => {
      const unsafe: CatalogConsumerFetch = async () => new Response(JSON.stringify({ error: { code: 'secret-provider-diagnostic' } }), {
        status: 503, headers: { 'retry-after': 'secret-token' },
      });
      const error = await consumePublicCatalog({ baseUrl: 'http://gateway.test', apiKey: validKey, fetch: unsafe })
        .then(unexpectedSuccess, catalogFailure);
      expect(error.kind).toBe('http');
      expect(error.code).toBeNull();
      expect(error.retryAfter).toBeNull();
      expect(JSON.stringify(error)).not.toContain('secret');
    });

    it.each(['not a URL', 'file:///tmp/private', 'https://user:password@gateway.test'])('rejects invalid or credential-bearing base URL %s before transport', async (baseUrl) => {
      const transport = vi.fn(async () => new Response('{}'));
      const error = await consumePublicCatalog({ baseUrl, apiKey: validKey, fetch: transport })
        .then(unexpectedSuccess, catalogFailure);
      expect(error.kind).toBe('input');
      expect(transport).not.toHaveBeenCalled();
    });

    it('rejects a page limit that differs from the requested bound', async () => {
      const transport: CatalogConsumerFetch = async () => new Response(JSON.stringify({
        schemaVersion: 1, object: 'catalog.list', catalogRevision: `sha256:${'a'.repeat(64)}`,
        data: [], page: { limit: 20, nextCursor: null },
      }), { status: 200 });
      const error = await consumePublicCatalog({ baseUrl: 'http://gateway.test', apiKey: validKey, fetch: transport, pageLimit: 1 })
        .then(unexpectedSuccess, catalogFailure);
      expect(error.kind).toBe('schema');
    });
  });

  describe('consumer fixture hygiene', () => {
    it('imports only the shared catalog contract and never internal/db/provider modules', () => {
      const source = readFileSync(new URL('./fixtures/catalog-consumer.ts', import.meta.url), 'utf8');
      const imports = [...source.matchAll(/(?:^|\n)\s*(?:import|export)[^'"]*from\s+'([^']+)'/g)].map((m) => m[1]!);
      expect(imports.length).toBeGreaterThan(0);
      for (const specifier of imports) expect(specifier).toBe('@aiag/shared/catalog-contract');
      expect(source).not.toMatch(/postgres|readPublicCatalog|lib\/db|public-catalog|upstreams|@aiag\/database|requireApiKey|gateway_api_keys|\bsql\b|await import\(|require\(/);
    });
  });
});

function unexpectedSuccess(): never { throw new Error('Expected catalog consumer to reject'); }
function catalogFailure(error: unknown): CatalogConsumerError {
  expect(error).toBeInstanceOf(CatalogConsumerError);
  return error as CatalogConsumerError;
}
