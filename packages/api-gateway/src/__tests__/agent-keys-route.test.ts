/**
 * GET /v1/agent/keys + POST /v1/agent/keys/:id/rotate|revoke + POST
 * /v1/agent/revoke — agent key lifecycle route (Task 7).
 *
 * The properties this file exists to pin:
 *  1. AUTH: mounted behind requireApiKey — no key, no lifecycle (401).
 *  2. LIST: org-scoped inventory WITHOUT plaintext or key_hash — the SELECT
 *     itself never mentions key_hash, and every item carries exactly the
 *     seven public fields.
 *  3. ROTATE (Review Focus #6): one guarded UPDATE carries the NEW hash in
 *     its values — the old plaintext dies in the same statement that births
 *     the new one; meta.rotated_from_hash preserves the superseded hash;
 *     guards id+org_id+revoked_at IS NULL+disabled_at IS NULL; audit row in
 *     the SAME transaction; self-rotate of the calling key is allowed.
 *  4. ROTATE/REVOKE of a foreign or dead key id → 404, indistinguishable.
 *  5. REVOKE KEY: guarded UPDATE revoked_at+disabled_at, audit row, 404 on
 *     zero rows.
 *  6. PRINCIPAL REVOKE: service receives the authenticated key id; body {}
 *     / {confirm:true} / empty all accepted; {confirm:false} and extra
 *     fields → 400; AGENT_NOT_AUTHORIZED → 403; state conflict → 409;
 *     unexpected errors → 500 without internals.
 *  7. PRINCIPAL GATE (review wave T-a1): list/rotate/revoke first prove the
 *     key's org has an ACTIVE agent_principals row (0106-0108 predicate);
 *     a human org's live key → 403 AGENT_NOT_AUTHORIZED, no other statement.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const ORG = '41000000-0000-4000-8000-0000000000a1';
const KEY_ID = '55555555-5555-4555-8555-5555555555aa';
const OTHER_KEY_ID = '77777777-7777-4777-8777-7777777777bb';
const PRINCIPAL = '88000000-0000-4000-8000-0000000000cc';

// ── Service mock (the unit under test is the ROUTE) ─────────────────────────
const service = vi.hoisted(() => ({ revoke: vi.fn() }));
vi.mock('@aiag/database', () => {
  class AgentAuthError extends Error {
    constructor(readonly code: string) {
      super(code);
      this.name = 'AgentAuthError';
    }
  }
  return {
    AgentAuthError,
    revokeAgentPrincipal: service.revoke,
  };
});

// ── pg fake: scripted rows in call order, statements captured ────────────────
// A queued result may be a plain array, an Error to reject with, or a function
// (text, values) => rows — the function form lets a scripted RETURNING row
// echo material the route itself generated (the rotate prefix), which no
// static fixture could know in advance.
const db = vi.hoisted(() => {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  const results: unknown[] = [];
  const tx = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    statements.push({ text, values });
    const next = results.shift();
    if (next instanceof Error) return Promise.reject(next);
    const rows = typeof next === 'function' ? next(text, values) : (next ?? []);
    return Promise.resolve(rows);
  });
  const sql = Object.assign(tx, {
    json: (value: unknown) => JSON.stringify(value),
    begin: async (work: (client: typeof tx) => unknown) => work(tx),
  });
  return { statements, results, sql };
});
vi.mock('../lib/db', () => ({ sql: db.sql }));

import { applyAiagErrorHandler } from '../lib/errors';
import { hashKey } from '../lib/api-key';
import { requireApiKey, setApiKeyResolver } from '../middleware/auth-plan04';
import { agentKeys } from '../routes/v1/agent-keys';

const KEY = 'sk_aiag_live_aaaaaaaaaaaaaaaaaaaa';

function mount(): Hono {
  const app = new Hono();
  applyAiagErrorHandler(app);
  // Same assembly the real server uses (server.ts): auth ahead of the route.
  app.use('/v1/agent/keys', requireApiKey);
  app.use('/v1/agent/keys/*', requireApiKey);
  app.use('/v1/agent/revoke', requireApiKey);
  app.route('/v1/agent', agentKeys);
  return app;
}

const post = (path: string, body?: unknown, key = KEY, app = mount()) =>
  app.request(`http://gw.example${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    // Raw strings pass through untouched so malformed-JSON bodies stay malformed.
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });

const get = (path: string, key = KEY, app = mount()) =>
  app.request(`http://gw.example${path}`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });

beforeEach(() => {
  db.statements.length = 0;
  db.results.length = 0;
  db.sql.mockClear();
  service.revoke.mockReset();
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
    ['GET /v1/agent/keys', () => get('/v1/agent/keys', '')],
    ['POST rotate', () => post(`/v1/agent/keys/${OTHER_KEY_ID}/rotate`, {}, '')],
    ['POST key revoke', () => post(`/v1/agent/keys/${OTHER_KEY_ID}/revoke`, {}, '')],
    ['POST principal revoke', () => post('/v1/agent/revoke', {}, '')],
  ])('401 without an Authorization header: %s', async (_label, run) => {
    const res = await run();
    expect(res.status).toBe(401);
    expect(db.statements).toHaveLength(0);
    expect(service.revoke).not.toHaveBeenCalled();
  });

  it('401 with an unknown key', async () => {
    setApiKeyResolver(async () => null);
    const res = await get('/v1/agent/keys', 'sk_aiag_live_cccccccccccccccccccc');
    expect(res.status).toBe(401);
  });
});

// ── Review wave (T-a1 Fix 1): the agent rail is for agent orgs only ─────────
// Every lifecycle op must first prove the key's org belongs to an ACTIVE
// agent principal (0106-0108 predicate). A human org's live key must get
// 403 AGENT_NOT_AUTHORIZED — not a listing, and above all not the rotate
// feature, which exists nowhere else and would let a leaked dashboard key
// self-heal its credentials through the agent rail.
describe('principal gate: human orgs cannot use the agent key lifecycle', () => {
  const GATE_NO = [{ ok: false }];
  const GATE_YES = [{ ok: true }];

  it('gate statement is the 0106-0108 predicate against agent_principals', async () => {
    db.results.push(GATE_YES, []); // gate, then inventory
    await get('/v1/agent/keys');
    const gate = db.statements[0]!;
    expect(gate.text).toContain('agent_principals');
    expect(gate.text).toContain("status = 'active'");
    expect(gate.text).toContain('EXISTS');
    expect(gate.values).toContain(ORG);
  });

  it.each([
    ['GET /v1/agent/keys (list)', () => get('/v1/agent/keys'), GATE_NO],
    [
      'POST /keys/:id/rotate',
      () => post(`/v1/agent/keys/${OTHER_KEY_ID}/rotate`),
      GATE_NO,
    ],
    [
      'POST /keys/:id/revoke',
      () => post(`/v1/agent/keys/${OTHER_KEY_ID}/revoke`),
      GATE_NO,
    ],
  ])('403 AGENT_NOT_AUTHORIZED for a human org on %s', async (_label, run, gateRows) => {
    db.results.push(gateRows);
    const res = await run();
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('AGENT_NOT_AUTHORIZED');
    // The gate is the ONLY statement: no inventory read, no UPDATE, no audit.
    expect(db.statements).toHaveLength(1);
    expect(db.statements.find((s) => /UPDATE gateway_api_keys/.test(s.text))).toBeUndefined();
    expect(db.statements.find((s) => /INSERT INTO usage_events/.test(s.text))).toBeUndefined();
  });

  it('fails closed (403) when the gate row itself is missing', async () => {
    // ok:false is the explicit human-org verdict; a LOST gate row (empty
    // result) must not be readable as "no principal information = allow".
    db.results.push([]); // gate SELECT returns nothing
    const res = await get('/v1/agent/keys');
    expect(res.status).toBe(403);
    expect(db.statements).toHaveLength(1);
  });
});

describe('GET /v1/agent/keys — inventory without secrets', () => {
  it('200 with the org-scoped list; the SELECT never mentions key_hash', async () => {
    db.results.push(
      [{ ok: true }], // principal gate (review wave Fix 1)
      [
        {
          id: OTHER_KEY_ID,
          name: 'agent-primary',
          key_prefix: 'sk_aiag_live_abcd',
          expires_at: null,
          created_at: '2026-10-09T10:00:00.000000Z',
          last_used_at: null,
          revoked_at: null,
        },
      ],
    );

    const res = await get('/v1/agent/keys');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');

    const body = (await res.json()) as { object: string; data: unknown[] };
    expect(body.object).toBe('list');
    expect(body.data).toHaveLength(1);
    expect(Object.keys(body.data[0] as object).sort()).toEqual(
      ['created_at', 'expires_at', 'id', 'key_prefix', 'last_used_at', 'name', 'revoked_at'].sort(),
    );
    // No plaintext anywhere in the payload.
    expect(JSON.stringify(body)).not.toMatch(/sk_aiag_live_[A-Za-z0-9_-]{20,}/);

    // Org scoping is in the statement itself, with the org as a value.
    const select = db.statements.find((s) => /FROM gateway_api_keys/.test(s.text))!;
    expect(select).toBeDefined();
    expect(select.text).toContain('WHERE org_id =');
    expect(select.values).toContain(ORG);
    // The secret columns are not even selected.
    expect(select.text).not.toContain('key_hash');
    expect(select.text).not.toContain('policies');
  });

  it('503 without internals when the inventory read fails', async () => {
    db.results.push([{ ok: true }], new Error('relation "gateway_api_keys" does not exist'));
    const res = await get('/v1/agent/keys');
    expect(res.status).toBe(503);
    const raw = await res.text();
    expect(raw).not.toContain('relation');
    expect(raw).not.toContain('gateway_api_keys');
  });
});

describe('POST /v1/agent/keys/:id/rotate — atomic credential replacement', () => {
  // The guarded UPDATE's parameter order: [0] new hash, [1] new prefix,
  // [2] key id, [3] org id. Echoing values[1] makes the RETURNING row carry
  // the prefix of the key the route actually generated.
  function rotationRows(keyId = OTHER_KEY_ID) {
    return (_text: string, values: unknown[]) => [
      { id: keyId, key_prefix: values[1] },
    ];
  }

  it('200 {id,key,key_prefix}; new hash replaces the old one in ONE guarded UPDATE', async () => {
    db.results.push([{ ok: true }], rotationRows(), []); // gate, UPDATE RETURNING, audit INSERT

    const res = await post(`/v1/agent/keys/${OTHER_KEY_ID}/rotate`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');

    const body = (await res.json()) as { id: string; key: string; key_prefix: string };
    expect(body.id).toBe(OTHER_KEY_ID);
    expect(body.key).toMatch(/^sk_aiag_live_[A-Za-z0-9_-]{32}$/);
    expect(body.key_prefix).toBe(body.key.slice(0, 20));

    // Review Focus #6: the UPDATE statement carries the NEW hash as a value —
    // the old plaintext is dead from this statement on; no second statement
    // touches key_hash, so there is no window where both verify.
    const update = db.statements.find((s) => /UPDATE gateway_api_keys/.test(s.text))!;
    expect(update).toBeDefined();
    // The tagged-template text keeps its source indentation: this pins that the
    // statement IS the guarded UPDATE (not an audit row mentioning the table).
    expect(update.text).toMatch(/^\s*UPDATE gateway_api_keys/);
    expect(update.text).toContain('SET key_hash =');
    expect(update.text).toContain('jsonb_set(meta, \'{rotated_from_hash}\', to_jsonb(key_hash), true)');
    // Guards: own org + live key only.
    expect(update.text).toContain('AND org_id =');
    expect(update.text).toContain('AND revoked_at IS NULL');
    expect(update.text).toContain('AND disabled_at IS NULL');
    expect(update.values).toContain(OTHER_KEY_ID);
    expect(update.values).toContain(ORG);
    // The new material: plaintext hash and prefix of the response key.
    expect(update.values).toContain(hashKey(body.key));
    expect(update.values).toContain(body.key_prefix);

    // Audit row in the SAME transaction, ids/prefixes only.
    const audit = db.statements.find((s) => /gateway_key_rotated/.test(s.text))!;
    expect(audit).toBeDefined();
    expect(audit.text).toContain('INSERT INTO usage_events');
    expect(audit.text).toContain("'gateway_key_rotated'");
    expect(JSON.stringify(audit.values)).not.toContain(body.key);
    expect(JSON.stringify(audit.values)).not.toContain(hashKey(body.key));
  });

  it('self-rotate of the calling key is allowed and succeeds', async () => {
    db.results.push([{ ok: true }], rotationRows(KEY_ID), []);
    const res = await post(`/v1/agent/keys/${KEY_ID}/rotate`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe(KEY_ID);
    // After this response the current bearer is dead by design — pinned by
    // the UPDATE having replaced key_hash above; here: the guarded UPDATE
    // really targeted the authenticated key id.
    const update = db.statements.find((s) => /UPDATE gateway_api_keys/.test(s.text))!;
    expect(update.values).toContain(KEY_ID);
  });

  it('404 for a foreign or already-dead key id (indistinguishable)', async () => {
    db.results.push([{ ok: true }], [], []); // gate, guarded UPDATE matches zero rows
    const res = await post(`/v1/agent/keys/${OTHER_KEY_ID}/rotate`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
    // No audit row was written for a no-op.
    expect(db.statements.find((s) => /gateway_key_rotated/.test(s.text))).toBeUndefined();
  });

  it('400 for a non-uuid id', async () => {
    const res = await post('/v1/agent/keys/not-a-uuid/rotate');
    expect(res.status).toBe(400);
    expect(db.statements).toHaveLength(0);
  });

  it('503 without internals (and without the new hash) when the UPDATE fails', async () => {
    db.results.push([{ ok: true }], new Error('deadlock detected'));
    const res = await post(`/v1/agent/keys/${OTHER_KEY_ID}/rotate`);
    expect(res.status).toBe(503);
    const raw = await res.text();
    expect(raw).not.toContain('deadlock');
    expect(raw).not.toMatch(/sk_aiag_live_[A-Za-z0-9_-]{32}/);
  });
});

describe('POST /v1/agent/keys/:id/revoke — retire one key', () => {
  it('200 {id,revoked_at} with the guarded UPDATE and an audit row', async () => {
    db.results.push(
      [{ ok: true }], // principal gate
      [{ id: OTHER_KEY_ID, revoked_at: '2026-10-09T12:00:00.000000Z' }],
      [], // audit INSERT
    );

    const res = await post(`/v1/agent/keys/${OTHER_KEY_ID}/revoke`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; revoked_at: string };
    expect(body.id).toBe(OTHER_KEY_ID);
    expect(body.revoked_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);

    const update = db.statements.find((s) => /UPDATE gateway_api_keys/.test(s.text))!;
    expect(update.text).toContain('SET revoked_at = now()');
    expect(update.text).toContain('disabled_at = now()');
    expect(update.text).toContain('AND org_id =');
    expect(update.text).toContain('AND revoked_at IS NULL');
    expect(update.values).toContain(OTHER_KEY_ID);
    expect(update.values).toContain(ORG);

    const audit = db.statements.find((s) => /gateway_key_revoked/.test(s.text))!;
    expect(audit).toBeDefined();
    expect(audit.text).toContain("'gateway_key_revoked'");
  });

  it('self-revoke of the calling key is allowed', async () => {
    db.results.push(
      [{ ok: true }],
      [{ id: KEY_ID, revoked_at: '2026-10-09T12:00:00.000000Z' }],
      [],
    );
    const res = await post(`/v1/agent/keys/${KEY_ID}/revoke`);
    expect(res.status).toBe(200);
  });

  it('404 for a foreign id — guarded UPDATE matches zero rows', async () => {
    db.results.push([{ ok: true }], [], []);
    const res = await post(`/v1/agent/keys/${OTHER_KEY_ID}/revoke`);
    expect(res.status).toBe(404);
    expect(db.statements.find((s) => /gateway_key_revoked/.test(s.text))).toBeUndefined();
  });

  it('400 for a non-uuid id', async () => {
    const res = await post('/v1/agent/keys/not-a-uuid/revoke');
    expect(res.status).toBe(400);
    expect(db.statements).toHaveLength(0);
  });
});

describe('POST /v1/agent/revoke — principal + every org key (§3 C1)', () => {
  it('200 {principal_id,revoked_at,keys_revoked}; service gets the authenticated key id', async () => {
    service.revoke.mockResolvedValue({
      principalId: PRINCIPAL,
      revokedAt: '2026-10-09T12:00:00.123Z',
      keysRevoked: 3,
    });

    const res = await post('/v1/agent/revoke', { confirm: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const body = (await res.json()) as {
      principal_id: string;
      revoked_at: string;
      keys_revoked: number;
    };
    expect(body.principal_id).toBe(PRINCIPAL);
    expect(body.revoked_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(body.keys_revoked).toBe(3);
    expect(service.revoke).toHaveBeenCalledTimes(1);
    expect(service.revoke.mock.calls[0]![1]).toEqual({ keyId: KEY_ID });
  });

  it.each([
    ['empty object {}', {}],
    ['confirm:true', { confirm: true }],
    ['fully empty body', undefined],
  ])('accepts body %s', async (_label, body) => {
    service.revoke.mockResolvedValue({
      principalId: PRINCIPAL,
      revokedAt: '2026-10-09T12:00:00.123Z',
      keysRevoked: 1,
    });
    const res = await post('/v1/agent/revoke', body);
    expect(res.status).toBe(200);
  });

  it.each([
    ['confirm:false', { confirm: false }],
    ['unknown extra field', { extra: 1 }],
    ['malformed JSON string', 'not json{{'],
  ])('400 for body %s, service never called', async (_label, body) => {
    const res = await post('/v1/agent/revoke', body);
    expect(res.status).toBe(400);
    expect(service.revoke).not.toHaveBeenCalled();
  });

  it('403 when the live key does not belong to an agent principal', async () => {
    const { AgentAuthError } = await import('@aiag/database');
    service.revoke.mockRejectedValue(new AgentAuthError('AGENT_NOT_AUTHORIZED'));
    const res = await post('/v1/agent/revoke', {});
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('AGENT_NOT_AUTHORIZED');
  });

  it('409 on an agent principal state conflict', async () => {
    const { AgentAuthError } = await import('@aiag/database');
    service.revoke.mockRejectedValue(new AgentAuthError('AGENT_PRINCIPAL_STATE_CONFLICT'));
    const res = await post('/v1/agent/revoke', {});
    expect(res.status).toBe(409);
  });

  it('503 when the 0107 entrypoint returns a malformed shape (AGENT_REVOKE_UNAVAILABLE)', async () => {
    const { AgentAuthError } = await import('@aiag/database');
    service.revoke.mockRejectedValue(new AgentAuthError('AGENT_REVOKE_UNAVAILABLE'));
    const res = await post('/v1/agent/revoke', {});
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('400 generic for an unmapped rail code', async () => {
    const { AgentAuthError } = await import('@aiag/database');
    service.revoke.mockRejectedValue(new AgentAuthError('AGENT_SOMETHING_ELSE'));
    const res = await post('/v1/agent/revoke', {});
    expect(res.status).toBe(400);
  });

  it('500 INTERNAL without SQL text on an unexpected service error', async () => {
    service.revoke.mockRejectedValue(new Error('relation "agent_principals" does not exist'));
    const res = await post('/v1/agent/revoke', {});
    expect(res.status).toBe(500);
    const raw = await res.text();
    expect(raw).not.toContain('agent_principals');
    expect(raw).not.toContain('relation');
  });

  it('repeated revoke is idempotent: 200 with the stored fact and keys_revoked 0', async () => {
    service.revoke.mockResolvedValue({
      principalId: PRINCIPAL,
      revokedAt: '2026-10-09T11:00:00.000Z',
      keysRevoked: 0,
    });
    const res = await post('/v1/agent/revoke', {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys_revoked: number };
    expect(body.keys_revoked).toBe(0);
  });
});
