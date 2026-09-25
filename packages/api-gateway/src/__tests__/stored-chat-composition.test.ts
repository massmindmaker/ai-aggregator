import { beforeEach, expect, it, vi } from 'vitest';
const spies = vi.hoisted(() => ({
  read: vi.fn(),
  claim: vi.fn(),
  prepare: vi.fn(),
  resolve: vi.fn(),
  attempt: vi.fn(),
  run: vi.fn(),
  byokAttempt: vi.fn(),
  byokRun: vi.fn(),
  admit: vi.fn(),
  reject: vi.fn(),
  outcome: vi.fn(),
  legacy: vi.fn(),
  query: vi.fn(),
  eval: vi.fn(),
  spending: vi.fn(),
  catalog: vi.fn(),
  order: [] as string[],
  mode: 'stored_chat_only' as
    | 'stored_chat_only'
    | 'stored_chat_embeddings'
    | 'stored_chat_embeddings_completions'
    | 'stored_chat_embeddings_completions_stream',
}));
vi.mock('../config', async () => {
  const actual = await vi.importActual<typeof import('../config')>('../config');
  return {
    config: {
      ...actual.config,
      get GATEWAY_HTTP_EXECUTION_MODE() {
        return spies.mode;
      },
    },
  };
});
vi.mock('../lib/db', () => ({ sql: spies.query }));
vi.mock('../egress-executor', () => ({
  registerGatewayEgressExecutor: vi.fn(),
}));
vi.mock('../catalog/public-catalog', () => ({
  PublicCatalogError: class PublicCatalogError extends Error { constructor(readonly kind: string) { super(kind); } },
  readPublicCatalog: spies.catalog,
}));
vi.mock('../billing/http-storage', async () => ({
  ...(await vi.importActual<typeof import('../billing/http-storage')>(
    '../billing/http-storage',
  )),
  claimGatewayHttpRequest: spies.claim,
  recordGatewayHttpOutcome: spies.outcome,
}));
vi.mock('../billing/http-terminal-recovery', async () => ({
  ...(await vi.importActual<typeof import('../billing/http-terminal-recovery')>(
    '../billing/http-terminal-recovery',
  )),
  readGatewayHttpResultV2: spies.read,
  admitGatewayHttpCharge: spies.admit,
  rejectUnstartedGatewayHttpRequest: spies.reject,
}));
vi.mock('../billing/stored-chat-attempt', () => ({
  createStoredChatAttempt: spies.attempt,
}));
vi.mock('../billing/stored-chat-byok-attempt', () => ({
  createStoredChatByokAttempt: spies.byokAttempt,
}));
vi.mock('../billing/stored-chat-fresh-policy', async () => ({
  ...(await vi.importActual<
    typeof import('../billing/stored-chat-fresh-policy')
  >('../billing/stored-chat-fresh-policy')),
  prepareStoredChatFreshPolicy: spies.prepare,
}));
vi.mock('../routing/stored-chat-fresh-resolver', async () => ({
  ...(await vi.importActual<
    typeof import('../routing/stored-chat-fresh-resolver')
  >('../routing/stored-chat-fresh-resolver')),
  resolveStoredChatFreshModel: spies.resolve,
}));
vi.mock('../routes/v1/chat', async () => {
  const { Hono } = await import('hono');
  return {
    chat: new Hono().post('/completions', (c) => {
      spies.legacy();
      return c.json({ legacy: true });
    }),
  };
});
import { app } from '../server';
import {
  setApiKeyResolver,
  type AuthenticatedApiKey,
} from '../middleware/auth-plan04';
import { setRedisFactory } from '../lib/redis';
import {
  HttpStorageAccessError,
  HttpStorageConflictError,
} from '../billing/http-storage';
import { StoredChatFreshPolicyError } from '../billing/stored-chat-fresh-policy';
const uuid = '00000000-0000-4000-8000-000000000001';
const key: AuthenticatedApiKey = {
  id: uuid,
  org_id: '00000000-0000-4000-8000-000000000002',
  policies: {},
  rpm_limit: 100,
  batch_rpm_limit: 1,
  daily_usd_cap: 1,
  model_whitelist: [],
  ru_residency_only: false,
};
const pending = {
  contractVersion: 1,
  status: 'pending',
  billingRequestId: uuid,
};
const runResult = (kind = 'settled_success') => ({
  kind,
  billingRequestId: uuid,
  ...(kind === 'settled_success'
    ? {
        actualCostCredits: 0n,
        response: {},
        admission: { state: 'settled', billingRequestId: uuid },
      }
    : {}),
  ...(kind === 'rejected' ? { code: 'PAYMENT_REQUIRED' } : {}),
  ...(kind === 'replay' ? { state: 'held' } : {}),
});
const body = {
  model: 'openai/gpt-4o-mini',
  messages: [{ role: 'user', content: 'hi' }],
};
function request(
  path = '/v1/chat/completions',
  payload: unknown = body,
  headers: Record<string, string> = {},
) {
  return app.request(path, {
    method: 'POST',
    headers: {
      authorization: `Bearer sk_aiag_test_${'a'.repeat(32)}`,
      'content-type': 'application/json',
      'idempotency-key': 'unit-request',
      ...headers,
    },
    body: JSON.stringify(payload),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  spies.order.length = 0;
  spies.mode = 'stored_chat_only';
  spies.catalog.mockResolvedValue({
    schemaVersion: 1, object: 'catalog.list', catalogRevision: `sha256:${'a'.repeat(64)}`,
    data: [], page: { limit: 20, nextCursor: null },
  });
  setApiKeyResolver(async () => {
    spies.order.push('auth');
    return key;
  });
  spies.eval.mockImplementation(async () => {
    spies.order.push('rpm');
    return [1, 0];
  });
  spies.spending.mockImplementation(() => {
    throw new Error('legacy spending');
  });
  setRedisFactory(() => ({ eval: spies.eval, get: spies.spending }) as never);
  spies.query.mockResolvedValue([]);
  spies.read.mockImplementation(async () => {
    spies.order.push('read');
    return pending;
  });
  spies.resolve.mockImplementation(async () => {
    spies.order.push('resolve');
    return { slug: body.model, type: 'chat', candidates: [] };
  });
  spies.prepare.mockImplementation(() => {
    spies.order.push('policy');
    return {
      model: { slug: body.model, type: 'chat', candidates: [] },
      policy: {},
      requestedMode: 'auto',
    };
  });
  spies.attempt.mockImplementation(() => {
    spies.order.push('attempt');
    return { status: 'ready', billingRequestId: uuid, run: spies.run };
  });
  spies.byokAttempt.mockImplementation(() => {
    spies.order.push('byokAttempt');
    return { status: 'ready', billingRequestId: uuid, run: spies.byokRun };
  });
  spies.claim.mockImplementation(async () => {
    spies.order.push('claim');
    return { didClaim: true, billingRequestId: uuid };
  });
  spies.run.mockImplementation(async () => {
    spies.order.push('run');
    return runResult();
  });
  spies.byokRun.mockImplementation(async () => {
    spies.order.push('byokRun');
    return runResult();
  });
});
it.each(['/v1/catalog', '/v1/catalog/'])('stored_chat_only assembly copies catalog GET alias through its restricted read guard chain: %s', async (path) => {
  spies.spending.mockResolvedValue(null);
  const response = await app.request(path, {
    headers: { authorization: `Bearer sk_aiag_test_${'a'.repeat(32)}` },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ object: 'catalog.list' });
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('vary')).toBe('Authorization');
  expect(spies.order).toEqual(['auth', 'rpm']);
  expect(spies.catalog).toHaveBeenCalledOnce();
  expect(spies.resolve).not.toHaveBeenCalled();
  expect(spies.prepare).not.toHaveBeenCalled();
  expect(spies.admit).not.toHaveBeenCalled();
});
it('production assembly authenticates and applies only RPM before replay, with no fresh effects', async () => {
  const response = await request();
  expect(spies.order).toEqual(['auth', 'rpm', 'read']);
  expect(response.status).toBe(202);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('x-request-id')).toMatch(/^req_/);
  expect(spies.order).toEqual(['auth', 'rpm', 'read']);
  expect(spies.prepare).not.toHaveBeenCalled();
  expect(spies.resolve).not.toHaveBeenCalled();
  expect(spies.spending).not.toHaveBeenCalled();
  expect(spies.legacy).not.toHaveBeenCalled();
});
it('fresh path binds SQL identity and mandatory writers, claims once and projects only durable read', async () => {
  spies.read.mockResolvedValueOnce({ contractVersion: 1, status: 'not_found' });
  const response = await request();
  expect(response.status).toBe(202);
  expect(spies.order).toEqual([
    'auth',
    'rpm',
    'resolve',
    'policy',
    'attempt',
    'claim',
    'run',
    'read',
  ]);
  const [args, deps] = spies.attempt.mock.calls[0]!;
  expect(args.declaredSessionId).toBeNull();
  expect(args.cachingDiscount).toBe('0.5');
  expect(Date.parse(args.preDispatchDeadlineAt) - Date.now()).toBeGreaterThan(
    29000,
  );
  expect(spies.claim.mock.calls[0]![0]).toMatchObject({
    apiKeyId: key.id,
    orgId: key.org_id,
    billingRequestId: uuid,
    routeKind: 'chat',
    billingMode: 'stored',
  });
  await deps.admitAttempt({ billingRequestId: uuid });
  await deps.rejectUnstarted({ billingRequestId: uuid });
  await deps.persistOutcome({ response: {} });
  expect(spies.admit.mock.calls[0]![0]).toMatchObject({
    apiKeyId: key.id,
    orgId: key.org_id,
    billingRequestId: uuid,
  });
  expect(spies.reject.mock.calls[0]![0]).toMatchObject({
    idempotencyKeyDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(spies.outcome).toHaveBeenCalledOnce();
  expect(spies.run).toHaveBeenCalledOnce();
});
it('losing claim discards prepared handle without run', async () => {
  spies.read.mockResolvedValueOnce({ status: 'not_found' });
  spies.claim.mockResolvedValueOnce({
    didClaim: false,
    billingRequestId: uuid,
  });
  expect((await request()).status).toBe(202);
  expect(spies.run).not.toHaveBeenCalled();
});
it.each(['settled_success', 'rejected', 'replay', 'cancelled_no_charge'])(
  'run %s always reads original durable facts',
  async (kind) => {
    spies.read.mockResolvedValueOnce({ status: 'not_found' });
    spies.run.mockResolvedValueOnce(runResult(kind));
    expect((await request()).status).toBe(202);
    expect(spies.read).toHaveBeenCalledTimes(2);
  },
);
it.each(['reconciliation_required', 'not_started', 'unknown', null])(
  'uncertain run %s is fixed 503 without guessed projection',
  async (kind) => {
    spies.read.mockResolvedValueOnce({ status: 'not_found' });
    spies.run.mockResolvedValueOnce(kind === null ? null : { kind });
    const response = await request();
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('2');
    expect(response.headers.get('x-aiag-billing-request-id')).toBeNull();
    expect(spies.read).toHaveBeenCalledOnce();
  },
);
it.each(['read', 'claim', 'run'] as const)(
  '%s throw gives sanitized 503 without another attempt',
  async (stage) => {
    if (stage !== 'read')
      spies.read.mockResolvedValueOnce({ status: 'not_found' });
    spies[stage].mockRejectedValueOnce(
      new Error('private upstream diagnostic'),
    );
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private');
    if (stage === 'claim') expect(spies.run).not.toHaveBeenCalled();
  },
);
it.each([
  [new HttpStorageAccessError(), 401],
  [new HttpStorageConflictError(), 409],
] as const)('direct read/claim classification %s', async (error, status) => {
  spies.read.mockRejectedValueOnce(error);
  expect((await request()).status).toBe(status);
});
it('auth failures and Redis errors retain early no-store, before durable read', async () => {
  setApiKeyResolver(async () => null);
  const denied = await request();
  expect(denied.status).toBe(401);
  expect(denied.headers.get('cache-control')).toBe('private, no-store');
  setApiKeyResolver(async () => key);
  spies.eval.mockRejectedValueOnce(new Error('secret'));
  const failure = await request();
  expect(failure.status).toBe(503);
  expect(await failure.text()).not.toContain('secret');
  expect(spies.read).not.toHaveBeenCalled();
});
it('RPM replay refusal leaves result untouched', async () => {
  spies.eval.mockResolvedValueOnce([0, 9]);
  const response = await request();
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('9');
  expect(spies.read).not.toHaveBeenCalled();
  expect(spies.claim).not.toHaveBeenCalled();
});
it.each([
  '/v1/completions',
  '/v1/embeddings',
  '/v1/images/generations',
  '/v1/video/generations',
  '/v1/audio/speech',
  '/v1/audio/transcriptions',
  '/v1/batches',
])('gates %s and trailing alias without identity requirement', async (path) => {
  for (const suffix of ['', '/']) {
    const response = await request(
      path + suffix,
      {},
      { 'idempotency-key': '' },
    );
    expect(response.status).toBe(501);
  }
  expect(spies.claim).not.toHaveBeenCalled();
  expect(spies.query).not.toHaveBeenCalled();
  expect(spies.legacy).not.toHaveBeenCalled();
});
it.each([
  'stored_chat_only',
  'stored_chat_embeddings',
  'stored_chat_embeddings_completions',
] as const)('keeps stream:true unavailable in pre-stream execution mode %s', async (mode) => {
  spies.mode = mode;
  const response = await request('/v1/chat/completions', { ...body, stream: true });
  expect(response.status).toBe(501);
  expect(await response.json()).toMatchObject({
    error: { code: 'UNSUPPORTED_EXECUTION_CONTRACT' },
  });
  expect(spies.read).not.toHaveBeenCalled();
  expect(spies.resolve).not.toHaveBeenCalled();
  expect(spies.claim).not.toHaveBeenCalled();
});

it.each([
  { stream: true },
  { tools: [] },
  { functions: [] },
  { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] },
])('gates unsupported body %j before read', async (feature) => {
  expect(
    (await request('/v1/chat/completions', { ...body, ...feature })).status,
  ).toBe(501);
  expect(spies.read).not.toHaveBeenCalled();
});
it('keeps empty BYOK header unavailable before durable state', async () => {
  expect(
    (await request(undefined, body, { 'x-upstream-key': '' })).status,
  ).toBe(501);
  expect(spies.read).not.toHaveBeenCalled();
});

it('newest mode runs non-stream BYOK through durable v3 identity and fixed-fee attempt', async () => {
  spies.mode = 'stored_chat_embeddings_completions_stream';
  let byokReads = 0;
  spies.read.mockImplementation(async () => {
    spies.order.push('read');
    byokReads += 1;
    return byokReads === 1
      ? { contractVersion: 3, status: 'not_found' }
      : { contractVersion: 3, status: 'pending', billingRequestId: uuid };
  });
  spies.byokRun.mockImplementationOnce(async () => {
    spies.order.push('byokRun');
    return { ...runResult(), actualCostCredits: 1000n };
  });
  const response = await request(undefined, body, { 'x-upstream-key': 'caller-provider-secret' });
  expect(response.status).toBe(202);
  expect(spies.order).toEqual([
    'auth', 'rpm', 'read', 'resolve', 'policy', 'byokAttempt', 'claim', 'byokRun', 'read',
  ]);
  expect(spies.byokAttempt).toHaveBeenCalledOnce();
  expect(spies.attempt).not.toHaveBeenCalled();
  expect(spies.byokAttempt.mock.calls[0]![0]).toMatchObject({
    orgId: key.org_id,
    apiKeyId: key.id,
    byokKey: 'caller-provider-secret',
    feeCreditsExact: '1',
  });
  expect(spies.claim.mock.calls[0]![0]).toMatchObject({
    routeKind: 'chat',
    billingMode: 'byok_fee',
    contractVersion: 3,
  });
});

it.each(['stored_chat_only','stored_chat_embeddings','stored_chat_embeddings_completions'] as const)(
  'keeps non-stream BYOK unavailable in older stored mode %s',
  async (mode) => {
    spies.mode = mode;
    const response = await request(undefined, body, { 'x-upstream-key': 'caller-provider-secret' });
    expect(response.status).toBe(501);
    expect(spies.read).not.toHaveBeenCalled();
    expect(spies.byokAttempt).not.toHaveBeenCalled();
  },
);

it('keeps stream+BYOK unavailable without durable claim', async () => {
  spies.mode = 'stored_chat_embeddings_completions_stream';
  const response = await request(undefined, { ...body, stream: true }, {
    'x-upstream-key': 'caller-provider-secret',
  });
  expect([400, 501]).toContain(response.status);
  expect(spies.read).not.toHaveBeenCalled();
  expect(spies.byokAttempt).not.toHaveBeenCalled();
});
it('unknown fields stay B2 invalid; no fresh preparation on malformed identity', async () => {
  expect(
    (await request(undefined, { ...body, billingRequestId: uuid })).status,
  ).toBe(400);
  expect(spies.resolve).not.toHaveBeenCalled();
});
it('fresh policy denial is fixed pre-claim', async () => {
  spies.read.mockResolvedValueOnce({ status: 'not_found' });
  spies.prepare.mockImplementationOnce(() => {
    throw new StoredChatFreshPolicyError('model_not_allowed');
  });
  const response = await request();
  expect(response.status).toBe(403);
  expect(spies.claim).not.toHaveBeenCalled();
});
it('missing routes and methods remain absent while health stays available', async () => {
  expect((await request('/v1/unknown')).status).toBe(404);
  expect((await app.request('/health')).status).toBe(200);
});

it.each([
  { kind: 'settled_success' },
  { kind: 'rejected', billingRequestId: uuid, code: 'invented' },
  { kind: 'replay', billingRequestId: uuid, state: 'invented' },
  { kind: 'cancelled_no_charge', billingRequestId: 'other' },
])('malformed known run variant %j is unavailable', async (value) => {
  spies.read.mockResolvedValueOnce({ status: 'not_found' });
  spies.run.mockResolvedValueOnce(value);
  expect((await request()).status).toBe(503);
  expect(spies.read).toHaveBeenCalledOnce();
});
it('ready/rejected replays use original receipt/body despite fresh policy changes', async () => {
  const saved = {
    ...pending,
    status: 'ready',
    httpStatus: 200,
    contentType: 'application/json',
    response: { id: 'saved' },
    actualCostCredits: 10014900000000000n,
  };
  spies.read.mockResolvedValue(saved);
  key.policies = { unknown: 'denied' };
  const response = await request();
  expect(response.status).toBe(200);
  expect(response.headers.get('x-aiag-charged-microcredits')).toBe(
    '10014900000000000',
  );
  expect(response.headers.get('x-aiag-charged-usd-micro')).toBe(
    '100149000000000000',
  );
  expect(response.headers.get('x-aiag-upstream-cost-usd-micro')).toBeNull();
  expect(await response.json()).toEqual(saved.response);
  spies.read.mockResolvedValue({
    ...pending,
    status: 'rejected',
    httpStatus: 402,
    response: { error: { code: 'PAYMENT_REQUIRED' } },
  });
  const rejected = await request();
  expect(rejected.status).toBe(402);
  expect(rejected.headers.get('x-aiag-charged-microcredits')).toBeNull();
  expect(spies.prepare).not.toHaveBeenCalled();
  expect(spies.resolve).not.toHaveBeenCalled();
  key.policies = {};
});
it('retained read contracts authenticate, retain guards and scope batch lookup to owner', async () => {
  spies.spending.mockResolvedValue('0');
  const headers = { authorization: `Bearer sk_aiag_test_${'a'.repeat(32)}` };
  const response = await app.request('/v1/batches/owned-id', { headers });
  expect(response.status).toBe(404);
  const [parts, ...params] = spies.query.mock.calls[0]!;
  expect(parts.join('')).toContain('AND org_id = ');
  expect(params).toEqual(['owned-id', key.org_id]);
  expect(spies.claim).not.toHaveBeenCalled();
  expect(spies.eval).toHaveBeenCalledOnce();
  setApiKeyResolver(async () => null);
  spies.query.mockClear();
  expect((await app.request('/v1/models', { headers })).status).toBe(401);
  expect(spies.query).not.toHaveBeenCalled();
});
it.each(['PUT', 'PATCH', 'DELETE'])(
  'recognized unsupported %s mutations are gated without creating work',
  async (method) => {
    const response = await app.request('/v1/batches/', {
      method,
      headers: { authorization: `Bearer sk_aiag_test_${'a'.repeat(32)}` },
    });
    expect(response.status).toBe(501);
    expect(spies.query).not.toHaveBeenCalled();
    expect(spies.claim).not.toHaveBeenCalled();
  },
);

it.each([
  ['bad_request', 400],
  ['unavailable', 503],
] as const)('attempt %s fails before claim', async (status, expected) => {
  spies.read.mockResolvedValueOnce({ status: 'not_found' });
  spies.attempt.mockReturnValueOnce({ status });
  expect((await request()).status).toBe(expected);
  expect(spies.claim).not.toHaveBeenCalled();
  expect(spies.run).not.toHaveBeenCalled();
});
it('retained models and balance work, including legacy daily spending refusal', async () => {
  const headers = { authorization: `Bearer sk_aiag_test_${'a'.repeat(32)}` };
  spies.spending.mockResolvedValue('0');
  expect((await app.request('/v1/models/', { headers })).status).toBe(200);
  spies.query.mockResolvedValueOnce([
    {
      subscription_credits: '1000',
      payg_credits: '2000',
      subscription_credits_expires_at: null,
    },
  ]);
  const balance = await app.request('/v1/balance', { headers });
  expect(balance.status).toBe(200);
  expect(await balance.json()).toMatchObject({ total_credits: 3 });
  spies.spending.mockResolvedValue('10');
  const denied = await app.request('/v1/balance', { headers });
  expect(denied.status).toBe(429);
  expect(await denied.json()).toMatchObject({
    error: { message: 'Daily USD cap reached' },
  });
  expect(spies.claim).not.toHaveBeenCalled();
});
