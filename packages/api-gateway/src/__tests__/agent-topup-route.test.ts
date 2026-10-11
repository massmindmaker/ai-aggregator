/**
 * POST /v1/agent/topup + GET /v1/agent/invoices/:id — headless agent topup.
 *
 * The properties this file exists to pin:
 *  1. AUTH: mounted behind requireApiKey — no key, no invoices (401).
 *  2. Happy gram: 201 with the exact invoice card + a native-comment
 *     transferHint; timestamps are ISO, never raw PG text.
 *  3. Happy usdt: peg branch — jetton-forward-payload hint with the pinned
 *     mainnet master and a numeric minForwardAtomic.
 *  4. Minimum 100 credits and canonical decimal strings are rejected by the
 *     route schema with 400 BAD_REQUEST (the gateway has no 422 envelope —
 *     every other /v1 validation failure is BAD_REQUEST too).
 *  5. Idempotent replay: the same body returns the SAME invoiceId (the
 *     org-scoped idempotency of 0106 — a sibling key of the same org replays
 *     too; a DIFFERENT body under the same key is a 409 conflict).
 *  6. Rate limit: 13th topup per key within 5 minutes → 429 + Retry-After.
 *  7. Service error codes map to HTTP without leaking SQL internals.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import IORedisMock from 'ioredis-mock';

const ORG = '41000000-0000-4000-8000-0000000000a1';
const KEY_ID = '55555555-5555-4555-8555-5555555555aa';
const INVOICE = '66000000-0000-4000-8000-0000000000a3';

// ── Task 5 service mock (the unit under test is the ROUTE) ───────────────────
const service = vi.hoisted(() => ({
  create: vi.fn(),
  read: vi.fn(),
}));
vi.mock('@aiag/database', () => {
  class AgentTopupError extends Error {
    constructor(readonly code: string) {
      super(code);
      this.name = 'AgentTopupError';
    }
  }
  return {
    AgentTopupError,
    createAgentTopupInvoice: service.create,
    readAgentTopupInvoice: service.read,
  };
});

// ── pg fake for the admin_settings policy SELECT ─────────────────────────────
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

// ── USDT operator gate (review wave, T-a2): mutable per-test seam ────────────
// The route reads config.AIAG_AGENT_USDT_ENABLED at request time; the mock
// below exposes it as a getter over a hoisted holder so each test can flip
// the gate without re-importing the module graph.
const gate = vi.hoisted(() => ({ usdt: '0' }));
vi.mock('../config', async () => {
  const actual = await vi.importActual<typeof import('../config')>('../config');
  return {
    config: {
      ...actual.config,
      get AIAG_AGENT_USDT_ENABLED() {
        return gate.usdt;
      },
    },
  };
});

import { applyAiagErrorHandler } from '../lib/errors';
import { setRedisFactory } from '../lib/redis';
import { requireApiKey, setApiKeyResolver } from '../middleware/auth-plan04';
import { agentTopup } from '../routes/v1/agent-topup';

const KEY = 'sk_aiag_live_aaaaaaaaaaaaaaaaaaaa';
const RECIPIENT = `0:${'ab'.repeat(32)}`;
const USDT_MASTER = '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe';

/** Fresh, unexpired policy blob — the shape the worker persists to admin_settings. */
function policyRow(): { value: string } {
  const now = Date.now();
  return {
    value: JSON.stringify({
      revision: 'rev-2026-10-09',
      recipient: RECIPIENT,
      network: 'tvm:-3',
      finalityPolicyId: 'finality-v1',
      verifierVersion: 'verifier-v1',
      quoteLifetimeSeconds: 120,
      maxFxAgeSeconds: 60,
      fx: {
        numerator: '10000000000',
        denominator: '5200000',
        rounding: 'ceil',
        source: 'coingecko:the-open-network',
        observedAtMs: now - 1000,
        expiresAtMs: now + 60_000,
      },
      additionalFeeAtomic: '0',
      packages: [{ id: 'p1', label: 'Starter', grantMicrocredits: '1000000' }],
    }),
  };
}

/** Invoice card as the Task 5 service renders it (ISO timestamps already). */
function gramInvoice(): Record<string, unknown> {
  return {
    invoiceId: INVOICE,
    network: 'tvm:-3',
    asset: { network: 'tvm:-3', kind: 'native', decimals: 9 },
    amountAtomic: '1923076924',
    recipient: RECIPIENT,
    reference: 'aiag-ton:1b0f0f0e-0000-4000-8000-0000000000ff',
    grantMicrocredits: '100000',
    expiresAt: '2026-10-09T12:00:00.000Z',
    status: 'pending',
  };
}

function usdtInvoice(): Record<string, unknown> {
  return {
    invoiceId: INVOICE,
    network: 'tvm:-1',
    asset: { network: 'tvm:-1', kind: 'jetton', masterAddress: USDT_MASTER, decimals: 6 },
    amountAtomic: '1000000',
    recipient: RECIPIENT,
    reference: 'aiag-ton:1b0f0f0e-0000-4000-8000-0000000000ff',
    grantMicrocredits: '100000',
    expiresAt: '2026-10-09T12:00:00.000Z',
    status: 'pending',
  };
}

function setupRedis(): void {
  const instance = new (IORedisMock as any)();
  // ioredis-mock shares one module-level keyspace across instances — flush.
  void instance.flushall();
  setRedisFactory(() => instance as any);
}

function mount(): Hono {
  const app = new Hono();
  applyAiagErrorHandler(app);
  // Same assembly the real server uses (server.ts): auth ahead of the route.
  app.use('/v1/agent/topup', requireApiKey);
  app.use('/v1/agent/topup/*', requireApiKey);
  app.use('/v1/agent/invoices/*', requireApiKey);
  app.route('/v1/agent', agentTopup);
  return app;
}

const post = (path: string, body: unknown, key = KEY, app = mount()) =>
  app.request(`http://gw.example${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const get = (path: string, key = KEY, app = mount()) =>
  app.request(`http://gw.example${path}`, { headers: { authorization: `Bearer ${key}` } });

beforeEach(() => {
  db.statements.length = 0;
  db.results.length = 0;
  db.sql.mockClear();
  service.create.mockReset();
  service.read.mockReset();
  delete process.env.TON_CHECKOUT_POLICY;
  gate.usdt = '0';
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

describe('POST /v1/agent/topup — happy gram', () => {
  it('201 with invoice card + native-comment transferHint; ISO timestamps only', async () => {
    db.results.push([policyRow()]);
    service.create.mockResolvedValue(gramInvoice());

    const res = await post('/v1/agent/topup', {
      asset: 'gram',
      credits: '100',
      idempotencyKey: 'topup-1',
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.invoiceId).toBe(INVOICE);
    expect(body.network).toBe('tvm:-3');
    expect(body.asset).toEqual({ network: 'tvm:-3', kind: 'native', decimals: 9 });
    expect(body.recipient).toBe(RECIPIENT);
    expect(body.amountAtomic).toBe('1923076924');
    expect(body.reference).toMatch(/^aiag-ton:[0-9a-f-]{36}$/);
    expect(body.grantMicrocredits).toBe('100000');
    // ISO-8601 with ms + Z — a raw PG text timestamp must never leak through.
    expect(body.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(body.transferHint).toEqual({ mode: 'native-comment' });
  });

  it('passes the authenticated key id + org id and the parsed policy to the service', async () => {
    db.results.push([policyRow()]);
    service.create.mockResolvedValue(gramInvoice());

    await post('/v1/agent/topup', {
      asset: 'gram',
      credits: '250',
      idempotencyKey: 'topup-2',
    });

    expect(service.create).toHaveBeenCalledTimes(1);
    const [, input, policy] = service.create.mock.calls[0]!;
    expect(input).toEqual({
      keyId: KEY_ID,
      orgId: ORG,
      asset: 'gram',
      credits: '250',
      idempotencyKey: 'topup-2',
    });
    // The policy supplier hands the service the admin_settings values it read.
    const supplied = policy();
    expect(supplied.revision).toBe('rev-2026-10-09');
    expect(supplied.recipient).toBe(RECIPIENT);
    expect(supplied.quoteLifetimeSeconds).toBe(120);
    expect(supplied.fx.numerator).toBe('10000000000');
    expect(supplied.additionalFeeAtomic).toBe('0');
  });
});

describe('POST /v1/agent/topup — happy usdt (peg, operator gate ON)', () => {
  it('201 with jetton-forward-payload hint carrying the pinned mainnet master', async () => {
    gate.usdt = '1';
    db.results.push([policyRow()]);
    service.create.mockResolvedValue(usdtInvoice());

    const res = await post('/v1/agent/topup', {
      asset: 'usdt',
      credits: '100',
      idempotencyKey: 'topup-usdt-1',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.invoiceId).toBe(INVOICE);
    expect(body.network).toBe('tvm:-1');
    expect(body.amountAtomic).toBe('1000000'); // 100 credits = 1.000000 USDT
    expect(body.transferHint).toEqual({
      mode: 'jetton-forward-payload',
      masterAddress: USDT_MASTER,
      minForwardAtomic: expect.stringMatching(/^[1-9][0-9]*$/),
    });
    expect(service.create.mock.calls[0]![1].asset).toBe('usdt');
  });
});

describe('POST /v1/agent/topup — USDT operator gate (AIAG_AGENT_USDT_ENABLED, default off)', () => {
  it('gate off + usdt → 503 AGENT_USDT_DISABLED; no invoice, no SQL, no service call', async () => {
    gate.usdt = '0';
    const res = await post('/v1/agent/topup', {
      asset: 'usdt',
      credits: '100',
      idempotencyKey: 'usdt-gate-off',
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('AGENT_USDT_DISABLED');
    // Static message, no internals.
    expect(typeof body.error.message).toBe('string');
    // The gate fires before the policy SELECT and before the service tx.
    expect(db.sql.mock.calls.length).toBe(0);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('gate off does not touch gram (still 201)', async () => {
    gate.usdt = '0';
    db.results.push([policyRow()]);
    service.create.mockResolvedValue(gramInvoice());

    const res = await post('/v1/agent/topup', {
      asset: 'gram',
      credits: '100',
      idempotencyKey: 'gram-gate-off',
    });
    expect(res.status).toBe(201);
    expect(service.create).toHaveBeenCalledTimes(1);
    expect(service.create.mock.calls[0]![1].asset).toBe('gram');
  });

  it('gate on + usdt → the gate stops interfering (201 covered above); a bad usdt body is still 400, not 503', async () => {
    gate.usdt = '1';
    const res = await post('/v1/agent/topup', {
      asset: 'usdt',
      credits: '99',
      idempotencyKey: 'k',
    });
    expect(res.status).toBe(400);
    expect(service.create).not.toHaveBeenCalled();
  });
});

describe('POST /v1/agent/topup — schema (400 BAD_REQUEST — the gateway validation envelope)', () => {
  it.each([
    ['credits below the 100 minimum', { asset: 'gram', credits: '99', idempotencyKey: 'k' }],
    ['non-canonical leading zero', { asset: 'gram', credits: '0100', idempotencyKey: 'k' }],
    ['credits as number, not string', { asset: 'gram', credits: 100, idempotencyKey: 'k' }],
    ['unknown asset', { asset: 'notcoin', credits: '100', idempotencyKey: 'k' }],
    ['fractional credits', { asset: 'gram', credits: '100.5', idempotencyKey: 'k' }],
    ['bad idempotencyKey charset', { asset: 'gram', credits: '100', idempotencyKey: 'не-ключ' }],
    ['missing idempotencyKey', { asset: 'gram', credits: '100' }],
    ['unknown extra field', { asset: 'gram', credits: '100', idempotencyKey: 'k', extra: 1 }],
  ])('400 for %s, service never called', async (_label, body) => {
    db.results.push([policyRow()]);
    const res = await post('/v1/agent/topup', body);
    expect(res.status).toBe(400);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('400 on a non-JSON body', async () => {
    const res = await post('/v1/agent/topup', 'not json');
    expect(res.status).toBe(400);
    expect(service.create).not.toHaveBeenCalled();
  });
});

describe('POST /v1/agent/topup — idempotency (org-scoped, 0106)', () => {
  it('the same body replays the SAME invoiceId', async () => {
    db.results.push([policyRow()], [policyRow()]);
    service.create.mockResolvedValue(gramInvoice());

    const body = { asset: 'gram', credits: '100', idempotencyKey: 'replay-1' };
    const first = await post('/v1/agent/topup', body);
    const second = await post('/v1/agent/topup', body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const a = (await first.json()) as { invoiceId: string };
    const b = (await second.json()) as { invoiceId: string };
    expect(b.invoiceId).toBe(a.invoiceId);
    expect(a.invoiceId).toBe(INVOICE);
  });

  it('a different body under the same idempotencyKey is a 409 conflict', async () => {
    const { AgentTopupError } = await import('@aiag/database');
    db.results.push([policyRow()]);
    service.create.mockRejectedValue(new AgentTopupError('TON_IDEMPOTENCY_CONFLICT'));

    const res = await post('/v1/agent/topup', {
      asset: 'gram',
      credits: '100',
      idempotencyKey: 'replay-1',
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('TON_IDEMPOTENCY_CONFLICT');
  });
});

describe('POST /v1/agent/topup — policy source', () => {
  it('reads ton_checkout_policy from admin_settings', async () => {
    db.results.push([policyRow()]);
    service.create.mockResolvedValue(gramInvoice());
    await post('/v1/agent/topup', { asset: 'gram', credits: '100', idempotencyKey: 'k' });
    const select = db.statements.find((s) => /admin_settings/.test(s.text))!;
    expect(select).toBeDefined();
    expect(select.values).toContain('ton_checkout_policy');
  });

  it('falls back to TON_CHECKOUT_POLICY env when admin_settings is empty', async () => {
    db.results.push([]);
    process.env.TON_CHECKOUT_POLICY = policyRow().value;
    service.create.mockResolvedValue(gramInvoice());
    const res = await post('/v1/agent/topup', { asset: 'gram', credits: '100', idempotencyKey: 'k' });
    expect(res.status).toBe(201);
  });

  it('503 when no policy is configured anywhere', async () => {
    db.results.push([]);
    const res = await post('/v1/agent/topup', { asset: 'gram', credits: '100', idempotencyKey: 'k' });
    expect(res.status).toBe(503);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('503 when admin_settings is unreachable and env is unset (no internals leak)', async () => {
    db.results.push(new Error('connection refused'));
    const res = await post('/v1/agent/topup', { asset: 'gram', credits: '100', idempotencyKey: 'k' });
    expect(res.status).toBe(503);
    const raw = await res.text();
    expect(raw).not.toContain('connection refused');
    expect(service.create).not.toHaveBeenCalled();
  });
});

describe('POST /v1/agent/topup — service error mapping', () => {
  it.each([
    ['key without an active agent principal → 403', 'AGENT_NOT_AUTHORIZED', 403],
    ['USDT not allowlisted yet → 503', 'TON_ASSET_NOT_ALLOWLISTED', 503],
    ['stale FX → 503', 'TON_CHECKOUT_FX_STALE', 503],
    ['expired quote → 503', 'TON_QUOTE_EXPIRED', 503],
    ['org refund debt → 409', 'TON_REFUND_BLOCKED', 409],
    ['grant above the compatibility limit → 400', 'TON_BALANCE_COMPATIBILITY_LIMIT', 400],
    ['unknown rail code → 400 generic', 'AGENT_SOMETHING_ELSE', 400],
  ])('%s', async (_label, code, status) => {
    const { AgentTopupError } = await import('@aiag/database');
    db.results.push([policyRow()]);
    service.create.mockRejectedValue(new AgentTopupError(code));
    const res = await post('/v1/agent/topup', { asset: 'gram', credits: '100', idempotencyKey: 'k' });
    expect(res.status).toBe(status);
  });

  it('500 INTERNAL without SQL text on an unexpected service error', async () => {
    db.results.push([policyRow()]);
    service.create.mockRejectedValue(new Error('relation "ton_invoices" does not exist'));
    const res = await post('/v1/agent/topup', { asset: 'gram', credits: '100', idempotencyKey: 'k' });
    expect(res.status).toBe(500);
    const raw = await res.text();
    expect(raw).not.toContain('ton_invoices');
    expect(raw).not.toContain('relation');
  });
});

describe('POST /v1/agent/topup — rate limit (12 / 5 min per key)', () => {
  it('13th request within 5 minutes → 429 + Retry-After', async () => {
    for (let i = 0; i < 13; i++) db.results.push([policyRow()]);
    service.create.mockResolvedValue(gramInvoice());
    const app = mount();

    for (let i = 0; i < 12; i++) {
      const r = await post(
        '/v1/agent/topup',
        { asset: 'gram', credits: '100', idempotencyKey: `k-${i}` },
        KEY,
        app,
      );
      expect(r.status).toBe(201);
    }
    const thirteenth = await post(
      '/v1/agent/topup',
      { asset: 'gram', credits: '100', idempotencyKey: 'k-overflow' },
      KEY,
      app,
    );
    expect(thirteenth.status).toBe(429);
    expect(thirteenth.headers.get('Retry-After')).toMatch(/^\d+$/);
    expect(service.create).toHaveBeenCalledTimes(12);
  });

  it('buckets are per key', async () => {
    for (let i = 0; i < 13; i++) db.results.push([policyRow()]);
    service.create.mockResolvedValue(gramInvoice());
    setApiKeyResolver(async (candidate) =>
      candidate === KEY
        ? { id: KEY_ID, org_id: ORG, policies: {}, rpm_limit: 60, batch_rpm_limit: 10, daily_usd_cap: null }
        : { id: '77777777-7777-4777-8777-7777777777aa', org_id: ORG, policies: {}, rpm_limit: 60, batch_rpm_limit: 10, daily_usd_cap: null },
    );
    const app = mount();
    for (let i = 0; i < 12; i++)
      await post('/v1/agent/topup', { asset: 'gram', credits: '100', idempotencyKey: `k-${i}` }, KEY, app);
    const other = await post(
      '/v1/agent/topup',
      { asset: 'gram', credits: '100', idempotencyKey: 'k-other' },
      'sk_aiag_live_bbbbbbbbbbbbbbbbbbbb',
      app,
    );
    expect(other.status).toBe(201);
  });

  it('fails closed with 503 when Redis is unavailable', async () => {
    setRedisFactory(() => ({ eval: async () => { throw new Error('secret Redis diagnostic'); } }) as any);
    const res = await post('/v1/agent/topup', { asset: 'gram', credits: '100', idempotencyKey: 'k' });
    expect(res.status).toBe(503);
    expect(service.create).not.toHaveBeenCalled();
    const raw = await res.text();
    expect(raw).not.toContain('secret');
  });
});

describe('auth boundary', () => {
  it('401 without an Authorization header, service never called', async () => {
    const res = await mount().request('http://gw.example/v1/agent/topup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ asset: 'gram', credits: '100', idempotencyKey: 'k' }),
    });
    expect(res.status).toBe(401);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('401 with an unknown key', async () => {
    setApiKeyResolver(async () => null);
    const res = await post('/v1/agent/topup', { asset: 'gram', credits: '100', idempotencyKey: 'k' }, 'sk_aiag_live_cccccccccccccccccccc');
    expect(res.status).toBe(401);
    expect(service.create).not.toHaveBeenCalled();
  });
});

describe('GET /v1/agent/invoices/:id', () => {
  it('200 {invoiceId, status, grantMicrocredits, settledAt} for a settled invoice', async () => {
    service.read.mockResolvedValue({
      invoiceId: INVOICE,
      status: 'settled',
      grantMicrocredits: '100000',
      settledAt: '2026-10-09T11:59:59.000Z',
    });
    const res = await get(`/v1/agent/invoices/${INVOICE}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.invoiceId).toBe(INVOICE);
    expect(body.status).toBe('settled');
    expect(body.grantMicrocredits).toBe('100000');
    expect(body.settledAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(service.read).toHaveBeenCalledWith(
      expect.anything(),
      { keyId: KEY_ID, invoiceId: INVOICE },
    );
  });

  it('omits settledAt while the invoice is still pending', async () => {
    service.read.mockResolvedValue({
      invoiceId: INVOICE,
      status: 'pending',
      grantMicrocredits: '100000',
      settledAt: null,
    });
    const res = await get(`/v1/agent/invoices/${INVOICE}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('pending');
    expect('settledAt' in body).toBe(false);
  });

  it('404 for a foreign or unknown invoice (indistinguishable)', async () => {
    const { AgentTopupError } = await import('@aiag/database');
    service.read.mockRejectedValue(new AgentTopupError('AGENT_TOPUP_NOT_FOUND'));
    const res = await get('/v1/agent/invoices/99000000-0000-4000-8000-0000000000ff');
    expect(res.status).toBe(404);
  });

  it('400 for a non-uuid id', async () => {
    const res = await get('/v1/agent/invoices/not-a-uuid');
    expect(res.status).toBe(400);
    expect(service.read).not.toHaveBeenCalled();
  });

  it('401 without a key', async () => {
    const res = await mount().request(`http://gw.example/v1/agent/invoices/${INVOICE}`);
    expect(res.status).toBe(401);
    expect(service.read).not.toHaveBeenCalled();
  });
});
