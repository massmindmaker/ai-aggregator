import { beforeEach, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({
  read: vi.fn(), claim: vi.fn(), resolve: vi.fn(), policy: vi.fn(), attempt: vi.fn(), run: vi.fn(),
  admit: vi.fn(), reject: vi.fn(), outcome: vi.fn(), query: vi.fn(), rpm: vi.fn(), catalog: vi.fn(),
  order: [] as string[],
}));
vi.mock('../config', async () => ({
  config: { ...(await vi.importActual<typeof import('../config')>('../config')).config, GATEWAY_HTTP_EXECUTION_MODE: 'stored_chat_embeddings_completions' },
}));
vi.mock('../lib/db', () => ({ sql: spies.query }));
vi.mock('../egress-executor', () => ({ registerGatewayEgressExecutor: vi.fn() }));
vi.mock('../catalog/public-catalog', () => ({
  PublicCatalogError: class PublicCatalogError extends Error { constructor(readonly kind: string) { super(kind); } },
  readPublicCatalog: spies.catalog,
}));
vi.mock('../billing/http-storage', async () => ({
  ...(await vi.importActual<typeof import('../billing/http-storage')>('../billing/http-storage')),
  claimGatewayHttpRequest: spies.claim,
  recordGatewayHttpOutcome: spies.outcome,
}));
vi.mock('../billing/http-terminal-recovery', async () => ({
  ...(await vi.importActual<typeof import('../billing/http-terminal-recovery')>('../billing/http-terminal-recovery')),
  readGatewayHttpResultV2: spies.read,
  admitGatewayHttpCharge: spies.admit,
  rejectUnstartedGatewayHttpRequest: spies.reject,
}));
vi.mock('../billing/stored-chat-attempt', () => ({ createStoredChatAttempt: spies.attempt }));
vi.mock('../billing/stored-chat-fresh-policy', async () => ({
  ...(await vi.importActual<typeof import('../billing/stored-chat-fresh-policy')>('../billing/stored-chat-fresh-policy')),
  prepareStoredChatFreshPolicy: spies.policy,
}));
vi.mock('../routing/stored-chat-fresh-resolver', async () => ({
  ...(await vi.importActual<typeof import('../routing/stored-chat-fresh-resolver')>('../routing/stored-chat-fresh-resolver')),
  resolveStoredChatFreshModel: spies.resolve,
}));

import { app } from '../server';
import { setApiKeyResolver, type AuthenticatedApiKey } from '../middleware/auth-plan04';
import { setRedisFactory } from '../lib/redis';

const uuid = '00000000-0000-4000-8000-000000000001';
const key: AuthenticatedApiKey = {
  id: uuid, org_id: '00000000-0000-4000-8000-000000000002', policies: {}, rpm_limit: 100,
  batch_rpm_limit: 1, daily_usd_cap: null, model_whitelist: [], ru_residency_only: false,
};
const body = { model: 'openai/gpt-4o-mini', prompt: '  hello  ', max_tokens: 10 };
const request = (payload: unknown = body, headers: Record<string, string> = {}) => app.request('/v1/completions', {
  method: 'POST',
  headers: { authorization: `Bearer sk_aiag_test_${'a'.repeat(32)}`, 'content-type': 'application/json', 'idempotency-key': 'completion-request', ...headers },
  body: JSON.stringify(payload),
});

beforeEach(() => {
  vi.clearAllMocks(); spies.order.length = 0;
  setApiKeyResolver(async () => { spies.order.push('auth'); return key; });
  spies.rpm.mockImplementation(async () => { spies.order.push('rpm'); return [1, 0]; });
  setRedisFactory(() => ({ eval: spies.rpm, get: vi.fn() }) as never);
  spies.query.mockResolvedValue([]);
  spies.read.mockImplementation(async () => { spies.order.push('read'); return { contractVersion: 1, status: 'pending', billingRequestId: uuid }; });
  spies.resolve.mockImplementation(async () => { spies.order.push('resolve'); return { slug: body.model, type: 'chat', candidates: [] }; });
  spies.policy.mockImplementation(() => { spies.order.push('policy'); return { model: { slug: body.model, type: 'chat', candidates: [] }, policy: {}, requestedMode: 'auto' }; });
  spies.attempt.mockImplementation(() => { spies.order.push('attempt'); return { status: 'ready', billingRequestId: uuid, run: spies.run }; });
  spies.claim.mockImplementation(async () => { spies.order.push('claim'); return { didClaim: true, billingRequestId: uuid }; });
  spies.run.mockImplementation(async () => { spies.order.push('run'); return { kind: 'settled_success', billingRequestId: uuid, actualCostCredits: 3n, response: {}, admission: { state: 'settled', billingRequestId: uuid } }; });
});

it('authenticates and applies RPM before authoritative replay', async () => {
  const response = await request();
  expect(response.status).toBe(202);
  expect(spies.order).toEqual(['auth', 'rpm', 'read']);
  expect(spies.resolve).not.toHaveBeenCalled();
});

it('converts one scalar prompt and binds all writers to completions', async () => {
  spies.read.mockResolvedValueOnce({ contractVersion: 1, status: 'not_found' });
  expect((await request()).status).toBe(202);
  expect(spies.order).toEqual(['auth', 'rpm', 'resolve', 'policy', 'attempt', 'claim', 'run', 'read']);
  const [args, deps] = spies.attempt.mock.calls[0]!;
  expect(args.body).toEqual({ model: body.model, messages: [{ role: 'user', content: '  hello  ' }], stream: false, max_tokens: 10 });
  expect(deps.admissionRouteKind).toBe('completions');
  expect(spies.claim.mock.calls[0]![0]).toMatchObject({ routeKind: 'completions', billingMode: 'stored' });
  await deps.admitAttempt({ billingRequestId: uuid });
  await deps.rejectUnstarted({ billingRequestId: uuid });
  await deps.persistOutcome({ response: {
    id: 'chat-1', object: 'chat.completion', created: 1, model: body.model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'answer' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  } });
  expect(spies.admit.mock.calls[0]![0]).toMatchObject({ routeKind: 'completions' });
  expect(spies.outcome.mock.calls[0]![0].response).toMatchObject({
    id: 'chat-1', object: 'text_completion', choices: [{ text: 'answer', index: 0, logprobs: null, finish_reason: 'stop' }],
  });
});

it.each([
  { model: body.model, prompt: ['a'] },
  { model: body.model, prompt: 'p', temperature: 0 },
])('rejects unsupported input before durable read: %j', async (payload) => {
  expect((await request(payload)).status).toBe(400);
  expect(spies.read).not.toHaveBeenCalled();
});

it('rejects BYOK and non-POST methods before state writers', async () => {
  expect((await request(body, { 'x-upstream-key': '' })).status).toBe(501);
  expect((await app.request('/v1/completions', { method: 'PUT', headers: { authorization: `Bearer sk_aiag_test_${'a'.repeat(32)}` } })).status).toBe(501);
  expect(spies.read).not.toHaveBeenCalled();
});
