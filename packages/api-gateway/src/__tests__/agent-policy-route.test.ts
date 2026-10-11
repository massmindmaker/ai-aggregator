/**
 * GET/PUT /v1/agent/policy — agent routing-policy + opt-in quota
 * self-service route (Task 8). The unit under test is the ROUTE; the
 * @aiag/database seam is mocked. Pinned properties:
 *  1. AUTH: mounted behind requireApiKey — no key, no policy (401).
 *  2. GET: 200 {policies, model_whitelist, quotas} with rail flags (kind,
 *     s2s_key_minting) never echoed and quota integers as decimal strings.
 *  3. PUT routing-only: zod-validated PATCH reaches the seam; quota numbers
 *     are stringified; null clears; unknown body fields → 400 BEFORE the
 *     seam (and before the Redis window consumes a slot is not pinned —
 *     only "before any state change" is).
 *  4. PUT quotas: the seam receives the resolved patch — the auth-scoped
 *     key id, never anything from the body.
 *  5. Empty body {} → 400 (a PUT that changes nothing has no contract).
 *  6. Seam codes: AGENT_NOT_AUTHORIZED → 403, AGENT_QUOTA_OUT_OF_RANGE →
 *     400, AGENT_POLICY_UNAVAILABLE → 503, unexpected → 500 without
 *     internals.
 *  7. 30/min window: after 30 calls in the window the 31st is a 429 with
 *     Retry-After.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import IORedisMock from 'ioredis-mock';

const ORG = '41000000-0000-4000-8000-0000000000a1';
const KEY_ID = '55555555-5555-4555-8555-5555555555aa';
const FOREIGN_KEY_ID = '77777777-7777-4777-8777-7777777777bb';

// ── Service mock (the unit under test is the ROUTE) ─────────────────────────
const service = vi.hoisted(() => ({ read: vi.fn(), update: vi.fn() }));
vi.mock('@aiag/database', () => {
  class AgentPolicyError extends Error {
    constructor(readonly code: string) {
      super(code);
      this.name = 'AgentPolicyError';
    }
  }
  return {
    AgentPolicyError,
    readAgentPolicy: service.read,
    updateAgentPolicy: service.update,
  };
});

// ── pg fake: the route's adapter wraps sql.begin; with the seam mocked it is
// never driven, but the import must resolve (same as agent-keys-route.test).
const db = vi.hoisted(() => {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  const tx = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    statements.push({ text: strings.join('?'), values });
    return Promise.resolve([]);
  });
  const sql = Object.assign(tx, {
    json: (value: unknown) => JSON.stringify(value),
    begin: async (work: (client: typeof tx) => unknown) => work(tx),
  });
  return { statements, sql };
});
vi.mock('../lib/db', () => ({ sql: db.sql }));

import { applyAiagErrorHandler } from '../lib/errors';
import { requireApiKey, setApiKeyResolver } from '../middleware/auth-plan04';
import { setRedisFactory } from '../lib/redis';
import { agentPolicy } from '../routes/v1/agent-policy';

const KEY = 'sk_aiag_live_aaaaaaaaaaaaaaaaaaaa';

function setupRedis(): void {
  const instance = new (IORedisMock as any)();
  void instance.flushall();
  setRedisFactory(() => instance as any);
}

function mount(): Hono {
  const app = new Hono();
  applyAiagErrorHandler(app);
  // Same assembly the real server uses (server.ts): auth ahead of the route.
  app.use('/v1/agent/policy', requireApiKey);
  app.use('/v1/agent/policy/*', requireApiKey);
  app.route('/v1/agent', agentPolicy);
  return app;
}

const get = (path = '/v1/agent/policy', key = KEY, app = mount()) =>
  app.request(`http://gw.example${path}`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });

const put = (
  body: unknown,
  key = KEY,
  app = mount(),
  path = '/v1/agent/policy',
) =>
  app.request(`http://gw.example${path}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    // Raw strings pass through untouched so malformed-JSON bodies stay malformed.
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });

function stateFixture() {
  return {
    orgId: ORG,
    policies: { kind: 'agent', s2s_key_minting: true, default_mode: 'auto' },
    modelWhitelist: ['gpt-x'],
    quotas: { sessionMicrocredits: '1500', monthlyCredits: '15000', dailyOrgUsdMicro: null },
  };
}

beforeEach(() => {
  service.read.mockReset();
  service.update.mockReset();
  setupRedis();
  setApiKeyResolver(async () => ({
    id: KEY_ID,
    org_id: ORG,
    policies: {},
    rpm_limit: 60,
    batch_rpm_limit: 10,
    daily_usd_cap: null,
  }));
});

describe('auth boundary', () => {
  it.each([
    ['GET /v1/agent/policy', () => get('/v1/agent/policy', '')],
    ['PUT /v1/agent/policy', () => put({ default_mode: 'auto' }, '')],
  ])('401 without an Authorization header: %s', async (_label, run) => {
    const res = await run();
    expect(res.status).toBe(401);
    expect(service.read).not.toHaveBeenCalled();
    expect(service.update).not.toHaveBeenCalled();
  });

  it('401 with an unknown key', async () => {
    setApiKeyResolver(async () => null);
    const res = await get('/v1/agent/policy', 'sk_aiag_live_cccccccccccccccccccc');
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/agent/policy', () => {
  it('200 with policies/model_whitelist/quotas; rail flags never echoed; quotas as strings', async () => {
    service.read.mockResolvedValue(stateFixture());

    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');

    const body = (await res.json()) as {
      policies: Record<string, unknown>;
      model_whitelist: string[];
      quotas: Record<string, unknown>;
    };
    // Only the routing subset: kind/s2s_key_minting must not leak.
    expect(body.policies).toEqual({ default_mode: 'auto' });
    expect(body.model_whitelist).toEqual(['gpt-x']);
    expect(body.quotas).toEqual({
      session_micro: '1500',
      monthly_credits: '15000',
      daily_org_usd_micro: null,
    });

    // Auth-scoped: the service sees the authenticated key id.
    expect(service.read).toHaveBeenCalledTimes(1);
    expect(service.read.mock.calls[0]![1]).toEqual({ keyId: KEY_ID });
  });

  it('403 when the live key has no active agent principal', async () => {
    const { AgentPolicyError } = await import('@aiag/database');
    service.read.mockRejectedValue(new AgentPolicyError('AGENT_NOT_AUTHORIZED'));
    const res = await get();
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('AGENT_NOT_AUTHORIZED');
  });

  it('503 without internals on a malformed rail result', async () => {
    const { AgentPolicyError } = await import('@aiag/database');
    service.read.mockRejectedValue(new AgentPolicyError('AGENT_POLICY_UNAVAILABLE'));
    const res = await get();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('503 without internals when the policy read fails at the database', async () => {
    service.read.mockRejectedValue(new Error('relation "gateway_quota_key_policies" does not exist'));
    const res = await get();
    expect(res.status).toBe(503);
    const raw = await res.text();
    expect(raw).not.toContain('gateway_quota_key_policies');
    expect(raw).not.toContain('relation');
  });
});

describe('PUT /v1/agent/policy — routing only', () => {
  it('200 with the merged state; the seam receives the zod-validated patch', async () => {
    service.update.mockResolvedValue(stateFixture());

    const res = await put({
      default_mode: 'ru-only',
      allowed_providers: [' openai ', 'openai'],
      forbid_non_ru: null,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');

    const body = (await res.json()) as { policies: Record<string, unknown> };
    expect(body.policies).toEqual({ default_mode: 'auto' }); // projection of the fixture

    expect(service.update).toHaveBeenCalledTimes(1);
    const [dbArg, input] = service.update.mock.calls[0]! as [unknown, { keyId: string; patch: Record<string, unknown> }];
    expect(dbArg).toBeDefined();
    expect(input.keyId).toBe(KEY_ID);
    // Providers trimmed + deduped before the seam; null removal travels as null.
    expect(input.patch).toEqual({
      default_mode: 'ru-only',
      allowed_providers: ['openai'],
      forbid_non_ru: null,
    });
  });

  it.each([
    ['unknown field', { default_mode: 'auto', per_session_budget_cap_rub: 5 }],
    ['bad mode', { default_mode: 'turbo' }],
    ['provider not a string', { allowed_providers: [7] }],
    ['empty provider entry after trim is rejected by zod', { blocked_providers: [''] }],
    ['whitelist not an array', { model_whitelist: 'gpt-x' }],
    ['non-integer quota', { session_micro_limit: 1.5 }],
    ['negative quota', { monthly_credits_limit: -1 }],
    ['quota above ceiling', { monthly_credits_limit: 100_000_000 }],
    ['boolean for quota', { daily_org_usd_micro_limit: true }],
    ['malformed JSON string', 'not json{{'],
  ])('400 for body %s — seam never called', async (_label, body) => {
    const res = await put(body);
    expect(res.status).toBe(400);
    expect(service.update).not.toHaveBeenCalled();
  });

  it('400 for an entirely empty object body', async () => {
    const res = await put({});
    expect(res.status).toBe(400);
    expect(service.update).not.toHaveBeenCalled();
  });

  it('400 for a missing JSON body', async () => {
    const res = await put(undefined);
    expect(res.status).toBe(400);
    expect(service.update).not.toHaveBeenCalled();
  });
});

describe('PUT /v1/agent/policy — quotas', () => {
  it('stringifies quota integers and passes explicit null through (clear)', async () => {
    service.update.mockResolvedValue(stateFixture());

    const res = await put({
      session_micro_limit: 1500,
      monthly_credits_limit: null,
      daily_org_usd_micro_limit: 25000,
    });
    expect(res.status).toBe(200);

    const input = service.update.mock.calls[0]![1] as { keyId: string; patch: Record<string, unknown> };
    expect(input.keyId).toBe(KEY_ID);
    expect(input.patch).toEqual({
      session_micro_limit: '1500',
      monthly_credits_limit: null,
      daily_org_usd_micro_limit: '25000',
    });
  });

  it('403 when the 0108 writer refuses the caller (AGENT_NOT_AUTHORIZED)', async () => {
    const { AgentPolicyError } = await import('@aiag/database');
    service.update.mockRejectedValue(new AgentPolicyError('AGENT_NOT_AUTHORIZED'));
    const res = await put({ session_micro_limit: 1500 });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('AGENT_NOT_AUTHORIZED');
  });

  it('400 on AGENT_QUOTA_OUT_OF_RANGE', async () => {
    const { AgentPolicyError } = await import('@aiag/database');
    service.update.mockRejectedValue(new AgentPolicyError('AGENT_QUOTA_OUT_OF_RANGE'));
    const res = await put({ monthly_credits_limit: 42 });
    expect(res.status).toBe(400);
  });

  it('503 on AGENT_POLICY_UNAVAILABLE', async () => {
    const { AgentPolicyError } = await import('@aiag/database');
    service.update.mockRejectedValue(new AgentPolicyError('AGENT_POLICY_UNAVAILABLE'));
    const res = await put({ default_mode: 'auto' });
    expect(res.status).toBe(503);
  });

  it('500 INTERNAL without internals on an unexpected service error', async () => {
    service.update.mockRejectedValue(new Error('deadlock detected'));
    const res = await put({ default_mode: 'auto' });
    expect(res.status).toBe(500);
    const raw = await res.text();
    expect(raw).not.toContain('deadlock');
  });
});

describe('auth scoping', () => {
  it('a different authenticated key reaches only its own policy — the seam sees THAT key id', async () => {
    service.read.mockResolvedValue(stateFixture());
    setApiKeyResolver(async () => ({
      id: FOREIGN_KEY_ID,
      org_id: '41000000-0000-4000-8000-0000000000ff',
      policies: {},
      rpm_limit: 60,
      batch_rpm_limit: 10,
      daily_usd_cap: null,
    }));

    const res = await get();
    expect(res.status).toBe(200);
    expect(service.read.mock.calls[0]![1]).toEqual({ keyId: FOREIGN_KEY_ID });
    // The other org's id is not part of any call — org always derives from the key.
    expect(JSON.stringify(service.read.mock.calls)).not.toContain(ORG);
  });
});

describe('30/min coarse window', () => {
  it('429 with Retry-After on the 31st call inside the window', async () => {
    service.read.mockResolvedValue(stateFixture());
    const app = mount();
    for (let i = 0; i < 30; i++) {
      const res = await get('/v1/agent/policy', KEY, app);
      expect(res.status).toBe(200);
    }
    const limited = await get('/v1/agent/policy', KEY, app);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBeTruthy();
    const body = (await limited.json()) as { error: { code: string } };
    expect(body.error.code).toBe('RATE_LIMITED');
  });
});
