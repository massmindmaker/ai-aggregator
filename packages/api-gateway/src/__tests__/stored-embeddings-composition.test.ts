import { beforeEach, expect, it, vi } from 'vitest';
const spies = vi.hoisted(() => ({
  read: vi.fn(), claim: vi.fn(), resolve: vi.fn(), policy: vi.fn(), attempt: vi.fn(), run: vi.fn(),
  admit: vi.fn(), reject: vi.fn(), outcome: vi.fn(), query: vi.fn(), rpm: vi.fn(), catalog: vi.fn(),
  order: [] as string[],
}));
vi.mock('../config', async () => ({
  config: { ...(await vi.importActual<typeof import('../config')>('../config')).config, GATEWAY_HTTP_EXECUTION_MODE: 'stored_chat_embeddings' },
}));
vi.mock('../lib/db', () => ({ sql: spies.query }));
vi.mock('../egress-executor', () => ({ registerGatewayEgressExecutor: vi.fn() }));
vi.mock('../catalog/public-catalog', () => ({
  PublicCatalogError: class PublicCatalogError extends Error { constructor(readonly kind: string) { super(kind); } },
  readPublicCatalog: spies.catalog,
}));
vi.mock('../billing/http-storage', async () => ({
  ...(await vi.importActual<typeof import('../billing/http-storage')>('../billing/http-storage')),
  claimGatewayHttpRequest: spies.claim, recordGatewayHttpOutcome: spies.outcome,
}));
vi.mock('../billing/http-terminal-recovery', async () => ({
  ...(await vi.importActual<typeof import('../billing/http-terminal-recovery')>('../billing/http-terminal-recovery')),
  readGatewayHttpResultV2: spies.read, admitGatewayHttpCharge: spies.admit,
  rejectUnstartedGatewayHttpRequest: spies.reject,
}));
vi.mock('../billing/stored-embeddings-attempt', () => ({ createStoredEmbeddingsAttempt: spies.attempt }));
vi.mock('../billing/stored-embeddings-fresh-policy', async () => ({
  ...(await vi.importActual<typeof import('../billing/stored-embeddings-fresh-policy')>('../billing/stored-embeddings-fresh-policy')),
  prepareStoredEmbeddingsFreshPolicy: spies.policy,
}));
vi.mock('../routing/stored-embeddings-fresh-resolver', async () => ({
  ...(await vi.importActual<typeof import('../routing/stored-embeddings-fresh-resolver')>('../routing/stored-embeddings-fresh-resolver')),
  resolveStoredEmbeddingsFreshModel: spies.resolve,
}));
import { app } from '../server';
import { setApiKeyResolver, type AuthenticatedApiKey } from '../middleware/auth-plan04';
import { setRedisFactory } from '../lib/redis';

const uuid = '00000000-0000-4000-8000-000000000001';
const key: AuthenticatedApiKey = {
  id: uuid, org_id: '00000000-0000-4000-8000-000000000002', policies: {}, rpm_limit: 100,
  batch_rpm_limit: 1, daily_usd_cap: null, model_whitelist: [], ru_residency_only: false,
};
const body = { model: 'openai/text-embedding-3-small', input: ['a', 'b'] };
const request = (path = '/v1/embeddings', payload: unknown = body, headers: Record<string, string> = {}) => app.request(path, {
  method: 'POST', headers: {
    authorization: `Bearer sk_aiag_test_${'a'.repeat(32)}`, 'content-type': 'application/json',
    'idempotency-key': 'embedding-request', ...headers,
  }, body: JSON.stringify(payload),
});

beforeEach(() => {
  vi.clearAllMocks(); spies.order.length = 0;
  setApiKeyResolver(async () => { spies.order.push('auth'); return key; });
  spies.rpm.mockImplementation(async () => { spies.order.push('rpm'); return [1, 0]; });
  setRedisFactory(() => ({ eval: spies.rpm, get: vi.fn() }) as never);
  spies.query.mockResolvedValue([]);
  spies.read.mockImplementation(async () => { spies.order.push('read'); return { contractVersion: 1, status: 'pending', billingRequestId: uuid }; });
  spies.resolve.mockImplementation(async () => { spies.order.push('resolve'); return { slug: body.model, type: 'embedding', candidates: [] }; });
  spies.policy.mockImplementation(() => { spies.order.push('policy'); return { model: { slug: body.model, type: 'embedding', candidates: [] }, policy: {}, requestedMode: 'auto' }; });
  spies.attempt.mockImplementation(() => { spies.order.push('attempt'); return { status: 'ready', billingRequestId: uuid, run: spies.run }; });
  spies.claim.mockImplementation(async () => { spies.order.push('claim'); return { didClaim: true, billingRequestId: uuid }; });
  spies.run.mockImplementation(async () => { spies.order.push('run'); return {
    kind: 'settled_success', billingRequestId: uuid, actualCostCredits: 3n, response: {},
    admission: { state: 'settled', billingRequestId: uuid },
  }; });
});

it('mounts embeddings with auth+RPM and performs replay before fresh resolution', async () => {
  const response = await request();
  expect(response.status).toBe(202);
  expect(spies.order).toEqual(['auth', 'rpm', 'read']);
  expect(spies.resolve).not.toHaveBeenCalled();
  expect(response.headers.get('cache-control')).toBe('private, no-store');
});

it('binds fresh attempt and all durable writers to the embeddings scope', async () => {
  spies.read.mockResolvedValueOnce({ contractVersion: 1, status: 'not_found' });
  const response = await request('/v1/embeddings/');
  expect(response.status).toBe(202);
  expect(spies.order).toEqual(['auth', 'rpm', 'resolve', 'policy', 'attempt', 'claim', 'run', 'read']);
  const [args, deps] = spies.attempt.mock.calls[0]!;
  expect(args).toMatchObject({ body: { input: ['a', 'b'], encoding_format: 'float', dimensions: 1536 }, declaredSessionId: null });
  expect(spies.claim.mock.calls[0]![0]).toMatchObject({ routeKind: 'embeddings', billingMode: 'stored', orgId: key.org_id, apiKeyId: key.id });
  await deps.admitAttempt({ billingRequestId: uuid });
  await deps.rejectUnstarted({ billingRequestId: uuid });
  await deps.persistOutcome({ response: {} });
  expect(spies.admit.mock.calls[0]![0]).toMatchObject({ routeKind: 'embeddings' });
  expect(spies.reject.mock.calls[0]![0]).toMatchObject({ routeKind: 'embeddings' });
  expect(spies.outcome.mock.calls[0]![0]).toMatchObject({ idempotencyKeyDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
});

it('rejects BYOK and non-POST methods before any state writer', async () => {
  expect((await request(undefined, body, { 'x-upstream-key': '' })).status).toBe(501);
  expect((await app.request('/v1/embeddings', { method: 'PUT', headers: { authorization: `Bearer sk_aiag_test_${'a'.repeat(32)}` } })).status).toBe(501);
  expect(spies.read).not.toHaveBeenCalled();
  expect(spies.claim).not.toHaveBeenCalled();
});

it('keeps stored chat mounted and other write routes unavailable in combined mode', async () => {
  expect((await request('/v1/images/generations', {})).status).toBe(501);
  expect((await request('/v1/chat/completions', { model: 'x', messages: [] })).status).not.toBe(404);
  expect((await app.request('/health')).status).toBe(200);
});
