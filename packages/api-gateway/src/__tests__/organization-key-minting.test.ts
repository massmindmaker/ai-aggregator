/**
 * POST /v1/organization/keys — S2S minting of an org-scoped gateway key.
 *
 * The security properties this file exists to pin:
 *  1. The plaintext key is returned EXACTLY ONCE, at creation. Nothing in the
 *     codebase may re-read it, and no log/audit row may contain it or its hash.
 *  2. Only the HASH is persisted. A DB dump must not yield a usable key.
 *  3. The new key belongs to the CALLER's org, never to an org named in the
 *     request body. Trusting a body org_id would be a total tenant takeover.
 *  4. Limits cannot be escalated past the minting key's own limits — otherwise
 *     a narrow agent key becomes a way to mint an unlimited one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const ORG = '40000000-0000-4000-8000-0000000000aa';
const ISSUER_KEY_ID = '30000000-0000-4000-8000-0000000000cc';
const VICTIM_ORG = '40000000-0000-4000-8000-0000000000bb';

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

import { requireApiKey, setApiKeyResolver } from '../middleware/auth-plan04';
import { applyAiagErrorHandler } from '../lib/errors';
import { organizationKeys } from '../routes/v1/organization-keys';
import { KEY_PREFIX_REGEX, hashKey } from '../lib/api-key';

const ISSUER = 'sk_aiag_live_cccccccccccccccccccc';

type IssuerOverrides = Record<string, unknown>;

function issuer(overrides: IssuerOverrides = {}) {
  return {
    id: ISSUER_KEY_ID,
    org_id: ORG,
    policies: { s2s_key_minting: true },
    rpm_limit: 60,
    batch_rpm_limit: 10,
    daily_usd_cap: null,
    cost_limit_monthly_rub: 100,
    model_whitelist: ['deepseek/deepseek-chat', 'qwen/qwen3-coder'],
    ru_residency_only: false,
    ...overrides,
  };
}

function mount(key = ISSUER, overrides: IssuerOverrides = {}) {
  setApiKeyResolver(async (candidate) => (candidate === key ? issuer(overrides) : null));
  const app = new Hono();
  applyAiagErrorHandler(app);
  app.use('/v1/organization/*', requireApiKey);
  app.route('/v1/organization', organizationKeys);
  return app;
}

const post = (body: unknown, key = ISSUER) =>
  mount(key).request('/v1/organization/keys', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** The INSERT ... RETURNING row the fake DB replays. */
function insertedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    name: 'agent-runner',
    key_prefix: 'sk_aiag_live_zzzz',
    model_whitelist: ['deepseek/deepseek-chat'],
    cost_limit_monthly_rub: '10',
    ru_residency_only: false,
    rpm_limit: 60,
    batch_rpm_limit: 10,
    created_at: '2026-09-30T10:00:00.000000Z',
    ...overrides,
  };
}

const validBody = {
  name: 'agent-runner',
  model_whitelist: ['deepseek/deepseek-chat'],
  cost_limit_monthly_rub: 10,
};

beforeEach(() => {
  db.statements.length = 0;
  db.results.length = 0;
  db.sql.mockClear();
  setApiKeyResolver(null);
});

describe('POST /v1/organization/keys — authentication', () => {
  it('401 without a bearer key, and writes nothing', async () => {
    setApiKeyResolver(async () => null);
    const app = new Hono();
    applyAiagErrorHandler(app);
    app.use('/v1/organization/*', requireApiKey);
    app.route('/v1/organization', organizationKeys);
    const res = await app.request('/v1/organization/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(401);
    expect(db.statements).toHaveLength(0);
  });

  it('401 for a well-shaped key that resolves to nothing', async () => {
    // Same assembly, but the resolver knows no key at all: the "revoked or
    // unknown key" path. It must fail before the body is even parsed.
    setApiKeyResolver(async () => null);
    const app = new Hono();
    applyAiagErrorHandler(app);
    app.use('/v1/organization/*', requireApiKey);
    app.route('/v1/organization', organizationKeys);
    const res = await app.request('/v1/organization/keys', {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk_aiag_live_dddddddddddddddddddd',
        'content-type': 'application/json',
      },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(401);
    expect(db.statements).toHaveLength(0);
  });
});

describe('POST /v1/organization/keys — the key is shown once and stored hashed', () => {
  it('201 with a usable key exactly once, and persists only the hash', async () => {
    db.results.push([insertedRow()]);

    const res = await post(validBody);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, any>;

    expect(KEY_PREFIX_REGEX.test(body.key)).toBe(true);
    expect(body.key).toMatch(/^sk_aiag_live_/);
    expect(body.key_prefix).toBe('sk_aiag_live_zzzz');
    expect(body.id).toBe('55555555-5555-4555-8555-555555555555');

    const insert = db.statements.find((s) => /INSERT INTO gateway_api_keys/.test(s.text));
    expect(insert).toBeDefined();
    // The hash is stored...
    expect(insert!.values).toContain(hashKey(body.key));
    // ...and the plaintext is not, anywhere in the statement.
    expect(insert!.values).not.toContain(body.key);
    expect(insert!.text).not.toContain(body.key);
  });

  it('never writes the plaintext key or its hash into the audit row', async () => {
    db.results.push([insertedRow()]);
    const res = await post(validBody);
    const body = (await res.json()) as Record<string, any>;

    const audit = db.statements.find((s) => /INSERT INTO usage_events/.test(s.text));
    expect(audit).toBeDefined();
    const serialized = JSON.stringify(audit!.values);
    expect(serialized).not.toContain(body.key);
    expect(serialized).not.toContain(hashKey(body.key));
    // The audit still records that a key was minted, by whom, for which org.
    expect(serialized).toContain(ISSUER_KEY_ID);
    expect(serialized).toContain(ORG);
  });

  it('a second identical request mints a different key (no replayed secret)', async () => {
    db.results.push([insertedRow()]);
    const first = (await (await post(validBody)).json()) as Record<string, any>;
    db.results.push([insertedRow({ id: '66666666-6666-4666-8666-666666666666' })]);
    const second = (await (await post(validBody)).json()) as Record<string, any>;
    expect(first.key).not.toBe(second.key);
  });
});

describe('POST /v1/organization/keys — the new key is bound to the caller', () => {
  it('ignores an org_id supplied in the body', async () => {
    db.results.push([insertedRow()]);
    const res = await post({ ...validBody, org_id: VICTIM_ORG });
    expect(res.status).toBe(201);
    const insert = db.statements.find((s) => /INSERT INTO gateway_api_keys/.test(s.text))!;
    expect(insert.values).toContain(ORG);
    expect(insert.values).not.toContain(VICTIM_ORG);
  });

  it('501/403 for a key whose policy does not allow S2S minting', async () => {
    const app = mount(ISSUER, { policies: {} });
    const res = await app.request('/v1/organization/keys', {
      method: 'POST',
      headers: { authorization: `Bearer ${ISSUER}`, 'content-type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    expect([403, 501]).toContain(res.status);
    expect(db.statements).toHaveLength(0);
  });
});

describe('POST /v1/organization/keys — limits cannot exceed the issuer', () => {
  it('rejects a whitelist containing a model the issuer may not call', async () => {
    const res = await post({ ...validBody, model_whitelist: ['openai/gpt-4o'] });
    expect(res.status).toBe(400);
    expect(db.statements).toHaveLength(0);
  });

  it('rejects a cost limit above the issuer own monthly cap', async () => {
    const res = await post({ ...validBody, cost_limit_monthly_rub: 1000 });
    expect(res.status).toBe(400);
    expect(db.statements).toHaveLength(0);
  });

  it('rejects a cost limit the issuer has no cap for (unlimited issuer cannot be capped upward silently)', async () => {
    const app = mount(ISSUER, { cost_limit_monthly_rub: null });
    const res = await app.request('/v1/organization/keys', {
      method: 'POST',
      headers: { authorization: `Bearer ${ISSUER}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, cost_limit_monthly_rub: -1 }),
    });
    expect(res.status).toBe(400);
    expect(db.statements).toHaveLength(0);
  });

  it('cannot relax ru_residency_only that the issuer is bound by', async () => {
    const app = mount(ISSUER, { ru_residency_only: true });
    const res = await app.request('/v1/organization/keys', {
      method: 'POST',
      headers: { authorization: `Bearer ${ISSUER}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, ru_residency_only: false }),
    });
    expect(res.status).toBe(400);
    expect(db.statements).toHaveLength(0);
  });
});

describe('POST /v1/organization/keys — request validation', () => {
  it.each([
    ['missing name', { model_whitelist: [] }],
    ['empty name', { ...validBody, name: '  ' }],
    ['oversized name', { ...validBody, name: 'x'.repeat(101) }],
    ['non-string whitelist entry', { ...validBody, model_whitelist: [7] }],
    ['zero cost limit', { ...validBody, cost_limit_monthly_rub: 0 }],
    ['negative rpm', { ...validBody, rpm_limit: -1 }],
  ])('400 for %s, writing nothing', async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(db.statements).toHaveLength(0);
  });

  it('400 on a non-JSON body, writing nothing', async () => {
    const app = mount();
    const res = await app.request('/v1/organization/keys', {
      method: 'POST',
      headers: { authorization: `Bearer ${ISSUER}`, 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    expect(db.statements).toHaveLength(0);
  });

  it('503 when the insert fails — the caller is not told a key exists', async () => {
    db.results.push(new Error('deadlock detected'));
    const res = await post(validBody);
    expect(res.status).toBe(503);
    const raw = await res.text();
    expect(raw).not.toMatch(/deadlock/);
  });
});

describe('POST /v1/organization/keys — no read-back surface', () => {
  it('exposes no GET that could return key material', async () => {
    // Auth is mounted in front, so an unauthenticated GET is 401 — the point
    // is that no method other than POST is routed at all.
    const app = new Hono();
    applyAiagErrorHandler(app);
    app.route('/v1/organization', organizationKeys);
    const anonymous = await app.request('/v1/organization/keys');
    expect([404, 405]).toContain(anonymous.status);

    // And with a valid key it is still not routed: never a 200 with material.
    const authed = await mount().request('/v1/organization/keys', {
      headers: { authorization: `Bearer ${ISSUER}` },
    });
    expect([404, 405]).toContain(authed.status);
  });
});
