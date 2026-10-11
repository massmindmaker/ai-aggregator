/**
 * POST /v1/agent/challenge + /v1/agent/register — headless agent bootstrap.
 *
 * The properties this file exists to pin:
 *  1. PUBLIC by design: no Authorization header is ever required — the TON
 *     wallet proof is the authentication. Mounted ahead of the /v1 key chain.
 *  2. The FIRST gateway key is minted INSIDE the registration transaction
 *     (review wave T-a1): the route generates the plaintext locally, hands
 *     only its SHA-256 hash + prefix to the service, and returns the
 *     plaintext EXACTLY ONCE from its own local value. No DB write happens
 *     in the route itself — an org can never exist without its bootstrap
 *     key, and a mid-register failure rolls the whole registration back.
 *  3. Review Focus #1: a second registration of the same wallet is a 409 and
 *     mints nothing — one wallet, one org, one primary key.
 *  4. Service-layer errors map to HTTP without leaking SQL internals.
 *  5. Redis sliding-window limits: 6/5min per address, 60/min global.
 *  6. Challenge domain: AIAG_AGENT_PROOF_DOMAIN when set (production MUST
 *     set it), request Host otherwise (dev fallback).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import IORedisMock from 'ioredis-mock';

const ORG = '41000000-0000-4000-8000-0000000000a1';
const PRINCIPAL = '42000000-0000-4000-8000-0000000000a2';
const KEY_ID = '55555555-5555-4555-8555-5555555555aa';

// ── Task 3 service mock (the unit under test is the ROUTE, not the rail) ────
const service = vi.hoisted(() => ({
  issue: vi.fn(),
  consume: vi.fn(),
}));
vi.mock('@aiag/database', () => {
  class AgentAuthError extends Error {
    constructor(readonly code: string) {
      super(code);
      this.name = 'AgentAuthError';
    }
  }
  return {
    AgentAuthError,
    issueAgentChallenge: service.issue,
    consumeAgentRegister: service.consume,
  };
});

// ── pg fake for the key-mint INSERT (same shape as the org-keys test) ───────
const db = vi.hoisted(() => {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  const results: unknown[] = [];
  const tx = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    statements.push({ text, values });
    const next = results.shift();
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? []);
  });
  const sql = Object.assign(tx, {
    json: (value: unknown) => JSON.stringify(value),
    begin: async (work: (client: typeof tx) => unknown) => work(tx),
  });
  return { statements, results, sql };
});
vi.mock('../lib/db', () => ({ sql: db.sql }));

import { applyAiagErrorHandler } from '../lib/errors';
import { setRedisFactory } from '../lib/redis';
import { agentRegister } from '../routes/v1/agent-register';
import { KEY_PREFIX_REGEX, hashKey } from '../lib/api-key';

const ADDR = `0:${'a1'.repeat(32)}`;
const GW = 'http://gw.example';
const CHALLENGE = '31000000-0000-4000-8000-0000000000c1';
const CHALLENGE_2 = '31000000-0000-4000-8000-0000000000c2';
const PROOF = { proof: { /* opaque Ton Connect payload, verified by Task 3 */ } };

function setupRedis(): void {
  const instance = new (IORedisMock as any)();
  // ioredis-mock keeps one module-level keyspace shared by ALL instances, so
  // a fresh constructor alone does not isolate tests — flush explicitly.
  void instance.flushall();
  setRedisFactory(() => instance as any);
}

function mount(): Hono {
  const app = new Hono();
  applyAiagErrorHandler(app);
  app.route('/v1/agent', agentRegister);
  return app;
}

const post = (path: string, body: unknown, app = mount(), origin = GW) =>
  app.request(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

beforeEach(() => {
  db.statements.length = 0;
  db.results.length = 0;
  db.sql.mockClear();
  service.issue.mockReset();
  service.consume.mockReset();
  // Fix 4 tests mutate this env var; every other test must see the dev
  // fallback (request Host), never a leftover configured domain.
  delete process.env.AIAG_AGENT_PROOF_DOMAIN;
  setupRedis();
});

describe('POST /v1/agent/challenge', () => {
  it('200 {challengeId, payload, expiresIn:120} — public, no Authorization header', async () => {
    service.issue.mockResolvedValue({
      challengeId: CHALLENGE,
      payload: 'aiag:agent:register:-3:deadbeef',
      expiresAt: '2026-10-09T10:02:00Z',
    });
    const res = await post('/v1/agent/challenge', { address: ADDR, network: '-3' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.challengeId).toBe(CHALLENGE);
    expect(body.payload).toBe('aiag:agent:register:-3:deadbeef');
    expect(body.expiresIn).toBe(120);
  });

  it('passes the request host down as the challenge domain', async () => {
    service.issue.mockResolvedValue({ challengeId: CHALLENGE, payload: 'p', expiresAt: 'x' });
    await post('/v1/agent/challenge', { address: ADDR, network: '-3' });
    expect(service.issue).toHaveBeenCalledTimes(1);
    expect(service.issue.mock.calls[0]![1]).toEqual({
      address: ADDR,
      network: '-3',
      domain: 'gw.example',
    });
  });

  it.each([
    ['wrong network', { address: ADDR, network: '1' }],
    ['malformed address', { address: 'EQAAAA…not-raw', network: '-3' }],
    ['missing address', { network: '-3' }],
  ])('400 for %s, service never called', async (_label, body) => {
    const res = await post('/v1/agent/challenge', body);
    expect(res.status).toBe(400);
    expect(service.issue).not.toHaveBeenCalled();
  });

  it('400 on a non-JSON body', async () => {
    const res = await post('/v1/agent/challenge', 'not json');
    expect(res.status).toBe(400);
    expect(service.issue).not.toHaveBeenCalled();
  });

  it('429 + Retry-After when the service reports AGENT_CHALLENGE_RATE_LIMIT', async () => {
    const { AgentAuthError } = await import('@aiag/database');
    service.issue.mockRejectedValue(new AgentAuthError('AGENT_CHALLENGE_RATE_LIMIT'));
    const res = await post('/v1/agent/challenge', { address: ADDR, network: '-3' });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toMatch(/^\d+$/);
  });

  // ── Review wave (T-a1 Fix 4): the proof domain is configuration, not Host ─
  // config.ts reads process.env at import time, so these tests re-import the
  // route module graph with the env set (vi.resetModules + dynamic import).
  // The re-imported graph gets its OWN lib/redis instance — the factory must
  // be re-wired there or the sliding-window guard would dial a real Redis.
  // The hoisted '@aiag/database'/'../lib/db' mocks keep serving the same fakes.
  describe('AIAG_AGENT_PROOF_DOMAIN (review wave T-a1)', () => {
    afterEach(() => {
      delete process.env.AIAG_AGENT_PROOF_DOMAIN;
      vi.resetModules();
    });

    async function mountFreshRoute(): Promise<Hono> {
      vi.resetModules();
      const [{ setRedisFactory: wireRedis }, { applyAiagErrorHandler: wireErrors }, route] =
        await Promise.all([
          import('../lib/redis'),
          import('../lib/errors'),
          import('../routes/v1/agent-register'),
        ]);
      const instance = new (IORedisMock as any)();
      void instance.flushall();
      wireRedis(() => instance as any);
      const app = new Hono();
      wireErrors(app);
      app.route('/v1/agent', route.agentRegister);
      return app;
    }

    it('uses the configured domain and ignores the request Host entirely', async () => {
      process.env.AIAG_AGENT_PROOF_DOMAIN = 'api.aiag-production.example';
      const app = await mountFreshRoute();
      service.issue.mockResolvedValue({ challengeId: CHALLENGE, payload: 'p', expiresAt: 'x' });

      const res = await app.request(`${GW}/v1/agent/challenge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: ADDR, network: '-3' }),
      });

      expect(res.status).toBe(200);
      expect(service.issue).toHaveBeenCalledTimes(1);
      expect(service.issue.mock.calls[0]![1]).toEqual({
        address: ADDR,
        network: '-3',
        domain: 'api.aiag-production.example', // NOT 'gw.example'
      });
    });

    it('falls back to the request Host when the env is unset (dev)', async () => {
      delete process.env.AIAG_AGENT_PROOF_DOMAIN;
      const app = await mountFreshRoute();
      service.issue.mockResolvedValue({ challengeId: CHALLENGE, payload: 'p', expiresAt: 'x' });

      await app.request(`${GW}/v1/agent/challenge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: ADDR, network: '-3' }),
      });
      expect(service.issue.mock.calls[0]![1]).toEqual({
        address: ADDR,
        network: '-3',
        domain: 'gw.example',
      });
    });
  });

  it('503 for AGENT_AUTH_UNAVAILABLE, without echoing internals', async () => {
    const { AgentAuthError } = await import('@aiag/database');
    service.issue.mockRejectedValue(new AgentAuthError('AGENT_AUTH_UNAVAILABLE'));
    const res = await post('/v1/agent/challenge', { address: ADDR, network: '-3' });
    expect(res.status).toBe(503);
  });

  it('500 INTERNAL without SQL text when the service throws an unexpected error', async () => {
    service.issue.mockRejectedValue(
      new Error('relation "agent_wallet_challenges" does not exist'),
    );
    const res = await post('/v1/agent/challenge', { address: ADDR, network: '-3' });
    expect(res.status).toBe(500);
    const raw = await res.text();
    expect(raw).not.toContain('agent_wallet_challenges');
    expect(raw).not.toContain('relation');
  });
});

describe('POST /v1/agent/register — happy path', () => {
  it('201 {principal_id, org_id, key, key_prefix}; key plaintext shown exactly once, minted in the service tx', async () => {
    service.consume.mockResolvedValue({
      principalId: PRINCIPAL,
      orgId: ORG,
      primaryKey: { id: KEY_ID, prefix: 'sk_aiag_live_aaaa' },
    });

    const res = await post('/v1/agent/register', {
      challengeId: CHALLENGE,
      address: ADDR,
      proof: PROOF,
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');

    const body = (await res.json()) as Record<string, string>;
    expect(body.principal_id).toBe(PRINCIPAL);
    expect(body.org_id).toBe(ORG);
    expect(body.key_prefix).toBe('sk_aiag_live_aaaa');
    expect(KEY_PREFIX_REGEX.test(body.key!)).toBe(true);

    // The route generates the key BEFORE the service call and passes only the
    // hash + prefix (+name) down — the mint INSERT happens inside the
    // service's registration transaction, so the route writes nothing itself.
    expect(service.consume).toHaveBeenCalledTimes(1);
    const input = service.consume.mock.calls[0]![1] as {
      challengeId: string;
      address: string;
      proof: unknown;
      primaryKey: { hash: string; prefix: string; name: string };
    };
    expect(input.challengeId).toBe(CHALLENGE);
    expect(input.address).toBe(ADDR);
    expect(input.proof).toEqual(PROOF);
    expect(input.primaryKey).toEqual({
      hash: hashKey(body.key!),
      prefix: body.key!.slice(0, 20),
      name: 'agent-primary',
    });
    // The plaintext never crosses the service boundary.
    expect(JSON.stringify(input)).not.toContain(body.key);
    // And the route performs no DB writes of its own.
    expect(db.statements).toHaveLength(0);
  });

  it('a failed mint fails the WHOLE registration — 503, nothing claimed to exist, retry possible', async () => {
    const { AgentAuthError } = await import('@aiag/database');
    // The mint now lives inside consumeAgentRegister's transaction: its
    // failure surfaces as AGENT_AUTH_UNAVAILABLE after the tx rolled back —
    // org and principal included, so the wallet can simply register again
    // (this was the keyless lock-out the review wave closed).
    service.consume.mockRejectedValue(new AgentAuthError('AGENT_AUTH_UNAVAILABLE'));
    const res = await post('/v1/agent/register', {
      challengeId: CHALLENGE,
      address: ADDR,
      proof: PROOF,
    });
    expect(res.status).toBe(503);
    const raw = await res.text();
    expect(raw).not.toMatch(/deadlock/);
    expect(raw).not.toMatch(/INSERT|UPDATE|SELECT/);
    expect(db.statements).toHaveLength(0);
  });
});

describe('POST /v1/agent/register — Review Focus #1: idempotent wallet identity', () => {
  it('a second registration of the same wallet is 409 and mints NOTHING', async () => {
    const { AgentAuthError } = await import('@aiag/database');
    service.consume.mockRejectedValue(new AgentAuthError('AGENT_ALREADY_REGISTERED'));

    const res = await post('/v1/agent/register', {
      challengeId: CHALLENGE_2,
      address: ADDR,
      proof: PROOF,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('AGENT_ALREADY_REGISTERED');
    // No second org's worth of writes: the key INSERT never runs.
    expect(db.statements.filter((s) => /INSERT INTO gateway_api_keys/.test(s.text))).toHaveLength(0);
    expect(db.statements).toHaveLength(0);
  });
});

describe('POST /v1/agent/register — service error mapping', () => {
  it.each([
    ['proof garbage → 400 AGENT_PROOF_INVALID', 'AGENT_PROOF_INVALID', 400],
    ['wrong challenge → 400 AGENT_CHALLENGE_INVALID', 'AGENT_CHALLENGE_INVALID', 400],
    ['consumed/stale challenge → 410 AGENT_CHALLENGE_EXPIRED', 'AGENT_CHALLENGE_EXPIRED', 410],
    ['DB down → 503 AGENT_AUTH_UNAVAILABLE', 'AGENT_AUTH_UNAVAILABLE', 503],
    ['unknown rail code → 400, fail-closed generic', 'AGENT_AUTH_INVALID', 400],
  ])('%s', async (_label, code, status) => {
    const { AgentAuthError } = await import('@aiag/database');
    service.consume.mockRejectedValue(new AgentAuthError(code));
    const res = await post('/v1/agent/register', {
      challengeId: CHALLENGE,
      address: ADDR,
      proof: PROOF,
    });
    expect(res.status).toBe(status);
    expect(db.statements).toHaveLength(0);
  });

  it('500 INTERNAL without SQL text on an unexpected service error', async () => {
    service.consume.mockRejectedValue(new Error('syntax error at or near "SELECT"'));
    const res = await post('/v1/agent/register', {
      challengeId: CHALLENGE,
      address: ADDR,
      proof: PROOF,
    });
    expect(res.status).toBe(500);
    const raw = await res.text();
    expect(raw).not.toContain('SELECT');
  });

  it.each([
    ['missing challengeId', { address: ADDR, proof: PROOF }],
    ['malformed address', { challengeId: CHALLENGE, address: 'nope', proof: PROOF }],
    ['non-uuid challengeId', { challengeId: 'zz', address: ADDR, proof: PROOF }],
  ])('400 for %s, service never called', async (_label, body) => {
    const res = await post('/v1/agent/register', body);
    expect(res.status).toBe(400);
    expect(service.consume).not.toHaveBeenCalled();
  });
});

describe('registration rate limits (Redis sliding window)', () => {
  it('7th challenge for the same address within 5 minutes → 429 + Retry-After', async () => {
    service.issue.mockResolvedValue({ challengeId: CHALLENGE, payload: 'p', expiresAt: 'x' });
    const app = mount();
    for (let i = 0; i < 6; i++) {
      const r = await post('/v1/agent/challenge', { address: ADDR, network: '-3' }, app);
      expect(r.status).toBe(200);
    }
    const seventh = await post('/v1/agent/challenge', { address: ADDR, network: '-3' }, app);
    expect(seventh.status).toBe(429);
    expect(seventh.headers.get('Retry-After')).toMatch(/^\d+$/);
    expect(service.issue).toHaveBeenCalledTimes(6);
  });

  it('per-address buckets are independent', async () => {
    service.issue.mockResolvedValue({ challengeId: CHALLENGE, payload: 'p', expiresAt: 'x' });
    const app = mount();
    const other = `0:${'b2'.repeat(32)}`;
    for (let i = 0; i < 6; i++)
      await post('/v1/agent/challenge', { address: ADDR, network: '-3' }, app);
    const stranger = await post('/v1/agent/challenge', { address: other, network: '-3' }, app);
    expect(stranger.status).toBe(200);
  });

  it('the register route shares the same per-address bucket', async () => {
    service.consume.mockResolvedValue({
      principalId: PRINCIPAL,
      orgId: ORG,
      primaryKey: { id: KEY_ID, prefix: 'sk_aiag_live_aaaa' },
    });
    const app = mount();
    for (let i = 0; i < 6; i++)
      await post('/v1/agent/register', { challengeId: CHALLENGE, address: ADDR, proof: PROOF }, app);
    const seventh = await post('/v1/agent/register', { challengeId: CHALLENGE, address: ADDR, proof: PROOF }, app);
    expect(seventh.status).toBe(429);
    expect(service.consume).toHaveBeenCalledTimes(6);
  });

  it('global bucket: 60/min across ALL addresses', async () => {
    service.issue.mockResolvedValue({ challengeId: CHALLENGE, payload: 'p', expiresAt: 'x' });
    const app = mount();
    for (let i = 0; i < 60; i++) {
      const address = `0:${'c3'.repeat(31)}${i.toString(16).padStart(2, '0')}`;
      const r = await post('/v1/agent/challenge', { address, network: '-3' }, app);
      expect(r.status).toBe(200);
    }
    const overflow = await post('/v1/agent/challenge', { address: `0:${'d4'.repeat(32)}`, network: '-3' }, app);
    expect(overflow.status).toBe(429);
  });

  it('fails closed with 503 when Redis is unavailable', async () => {
    setRedisFactory(() => ({ eval: async () => { throw new Error('secret Redis diagnostic'); } }) as any);
    const res = await post('/v1/agent/challenge', { address: ADDR, network: '-3' });
    expect(res.status).toBe(503);
    expect(service.issue).not.toHaveBeenCalled();
    const raw = await res.text();
    expect(raw).not.toContain('secret');
  });
});
