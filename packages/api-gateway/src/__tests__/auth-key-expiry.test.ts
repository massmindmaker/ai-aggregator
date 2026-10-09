import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { Hono } from 'hono';
import { generateApiKey, hashKey } from '../lib/api-key';
import { AiagError } from '../lib/errors';
import type { AuthenticatedApiKey } from '../middleware/auth-plan04';

// Import-time guard identical to auth.test.ts: lib/db builds a postgres client
// from config on import; unit tests must never reach it.
const db = vi.hoisted(() => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const selectResults: Array<unknown> = [];
  const sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    calls.push({ text, values });
    if (text.includes('SELECT')) {
      const next = selectResults.shift();
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? []);
    }
    return Promise.resolve([]);
  });
  return { calls, selectResults, sql };
});

vi.mock('../lib/db', () => ({ sql: db.sql }));

import { requireApiKey, setApiKeyResolver } from '../middleware/auth-plan04';

const baseKey: AuthenticatedApiKey = {
  id: '11111111-1111-1111-1111-111111111111',
  org_id: '22222222-2222-2222-2222-222222222222',
  policies: {},
  rpm_limit: 60,
  daily_usd_cap: null,
  batch_rpm_limit: 10,
};

// Frozen clock: the expiry boundary (`expires_at <= now` rejects) must be
// deterministic, not a race between test setup and middleware execution.
const NOW = Date.parse('2027-01-15T12:00:00.000Z');
let nowSpy: MockInstance<() => number>;

beforeEach(() => {
  db.calls.splice(0);
  db.selectResults.splice(0);
  db.sql.mockClear();
  setApiKeyResolver(null);
  nowSpy = vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  nowSpy.mockRestore();
  setApiKeyResolver(null);
});

function build(): { app: Hono; calls: { downstream: number } } {
  const app = new Hono();
  const calls = { downstream: 0 };
  app.onError((err, c) => {
    if (err instanceof AiagError)
      return c.json(err.toResponseBody(), err.status as 401 | 503);
    return c.json({ error: { code: 'INTERNAL', message: String(err) } }, 500);
  });
  app.use('/v1/*', requireApiKey);
  app.get('/v1/ping', (c) => {
    calls.downstream += 1;
    return c.json({ ok: true });
  });
  return { app, calls };
}

function request(key: string): Request {
  return new Request('http://x/v1/ping', {
    headers: { Authorization: `Bearer ${key}` },
  });
}

describe('requireApiKey key expiry (0105)', () => {
  it('admits a key whose expires_at is in the future', async () => {
    const { key } = generateApiKey('test');
    const seen: string[] = [];
    setApiKeyResolver(async (keyPlain) => {
      seen.push(keyPlain);
      return { ...baseKey, expires_at: '2027-01-15T12:00:00.001Z' };
    });
    const { app, calls } = build();

    const res = await app.fetch(request(key));

    expect(res.status).toBe(200);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);
    expect(calls.downstream).toBe(1);
    expect(seen).toEqual([key]);
  });

  it('admits a key whose expires_at is NULL (no TTL)', async () => {
    const { key } = generateApiKey('test');
    setApiKeyResolver(async () => ({ ...baseKey, expires_at: null }));
    const { app, calls } = build();

    const res = await app.fetch(request(key));

    expect(res.status).toBe(200);
    expect(calls.downstream).toBe(1);
  });

  it('admits a legacy resolver payload without an expires_at field', async () => {
    const { key } = generateApiKey('test');
    setApiKeyResolver(async () => ({ ...baseKey }));
    const { app, calls } = build();

    const res = await app.fetch(request(key));

    expect(res.status).toBe(200);
    expect(calls.downstream).toBe(1);
  });

  it.each([
    ['strictly past', '2027-01-15T11:59:59.999Z'],
    ['exactly now (inclusive boundary)', '2027-01-15T12:00:00.000Z'],
  ])('rejects with 401 KEY_EXPIRED when expires_at is %s', async (_label, expiresAt) => {
    const { key } = generateApiKey('test');
    setApiKeyResolver(async () => ({ ...baseKey, expires_at: expiresAt as string }));
    const { app, calls } = build();

    const res = await app.fetch(request(key));
    const body = await res.json() as { error: { code: string; message: string } };

    expect(res.status).toBe(401);
    // Body follows the standard AiagError {error:{code,message}} envelope.
    expect(body.error).toEqual({ code: 'KEY_EXPIRED', message: 'API key expired' });
    expect(calls.downstream).toBe(0);
  });

  it('keeps unrelated 401s on the default UNAUTHORIZED code', async () => {
    const { key } = generateApiKey('test');
    setApiKeyResolver(async () => null);
    const { app, calls } = build();

    const res = await app.fetch(request(key));

    expect(res.status).toBe(401);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
    expect(calls.downstream).toBe(0);
  });

  it('selects expires_at as an ISO-8601 UTC string on the fresh lookup', async () => {
    const { key } = generateApiKey('test');
    db.selectResults.push([{ ...baseKey, expires_at: null }]);
    const { app } = build();

    expect((await app.fetch(request(key))).status).toBe(200);

    const select = db.calls.find((call) => call.text.includes('SELECT'));
    expect(select?.text).toContain('expires_at');
    expect(select?.text).toContain(`AT TIME ZONE 'UTC'`);
    expect(select?.values).toEqual([hashKey(key)]);
  });
});
