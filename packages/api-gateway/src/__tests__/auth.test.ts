import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { generateApiKey, hashKey } from '../lib/api-key';
import { AiagError } from '../lib/errors';

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

const redis = vi.hoisted(() => ({
  value: { get: vi.fn(), setex: vi.fn() },
}));

vi.mock('../lib/db', () => ({ sql: db.sql }));
vi.mock('../lib/redis', () => ({ makeRedis: () => redis.value }));

import { requireApiKey, setApiKeyResolver } from '../middleware/auth-plan04';

const apiKey = (policies: Record<string, unknown> = {}) => ({
  id: '11111111-1111-1111-1111-111111111111',
  org_id: '22222222-2222-2222-2222-222222222222',
  policies,
  rpm_limit: 60,
  daily_usd_cap: null,
  batch_rpm_limit: 10,
  cost_limit_monthly_rub: null,
  model_whitelist: [],
  ru_residency_only: false,
});

beforeEach(() => {
  db.calls.splice(0);
  db.selectResults.splice(0);
  db.sql.mockClear();
  setApiKeyResolver(null);
  redis.value = { get: vi.fn(), setex: vi.fn() };
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
    const key = c.get('apiKey' as never) as
      | { policies: Record<string, unknown> }
      | undefined;
    return c.json({
      ok: true,
      policies: key?.policies,
      byok: c.get('byok' as never) ?? false,
      hasByokKey: Boolean(c.get('byokKey' as never)),
    });
  });
  return { app, calls };
}

function request(key: string, headers: Record<string, string> = {}) {
  return new Request('http://x/v1/ping', {
    headers: { Authorization: `Bearer ${key}`, ...headers },
  });
}

describe('requireApiKey middleware', () => {
  it('rejects warm Redis identity when the fresh lookup has no active row', async () => {
    const { key } = generateApiKey('test');
    const cache = { get: vi.fn(async () => JSON.stringify(apiKey())), setex: vi.fn() };
    redis.value = cache;
    const { app, calls } = build();

    const res = await app.fetch(request(key));

    expect(res.status).toBe(401);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
    expect(calls.downstream).toBe(0);
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.setex).not.toHaveBeenCalled();
    expect(db.calls.filter((call) => call.text.includes('SELECT'))).toHaveLength(1);
  });

  it('reads fresh policies for every default-resolver request', async () => {
    const { key } = generateApiKey('test');
    db.selectResults.push([apiKey({ default_mode: 'fastest' })]);
    db.selectResults.push([apiKey({ default_mode: 'cheapest' })]);
    const { app } = build();

    const first = await app.fetch(request(key));
    const second = await app.fetch(request(key));

    expect((await first.json() as { policies: { default_mode: string } }).policies.default_mode).toBe('fastest');
    expect((await second.json() as { policies: { default_mode: string } }).policies.default_mode).toBe('cheapest');
    const selects = db.calls.filter((call) => call.text.includes('SELECT'));
    expect(selects).toHaveLength(2);
    expect(selects[0]!.text).toContain('revoked_at IS NULL');
    expect(selects[0]!.text).toContain('disabled_at IS NULL');
    for (const field of ['policies', 'model_whitelist', 'ru_residency_only', 'rpm_limit']) expect(selects[0]!.text).toContain(field);
    expect(selects[0]!.values).toEqual([hashKey(key)]);
    expect(selects[0]!.values).not.toContain(key);
  });

  it.each(['disabled', 'revoked'])('observes %s before the next request', async () => {
    const { key } = generateApiKey('test');
    db.selectResults.push([apiKey()], []);
    const { app, calls } = build();

    expect((await app.fetch(request(key))).status).toBe(200);
    const rejected = await app.fetch(request(key));

    expect(rejected.status).toBe(401);
    expect(calls.downstream).toBe(1);
  });

  it.each([
    [undefined],
    ['Bearer sk_openai_xxx'],
    ['Bearer sk_aiag_test_bad extra'],
  ])('returns fixed 401 without downstream for malformed credentials', async (authorization) => {
    const { app, calls } = build();
    const headers: Record<string, string> = authorization
      ? { Authorization: authorization }
      : {};

    const res = await app.fetch(new Request('http://x/v1/ping', { headers }));

    expect(res.status).toBe(401);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
    expect(calls.downstream).toBe(0);
    expect(db.calls).toHaveLength(0);
  });

  it('returns a fixed 503 for default lookup failure without leaking details', async () => {
    const { key } = generateApiKey('test');
    db.selectResults.push(new Error(`database failure for ${key}`));
    const { app, calls } = build();

    const res = await app.fetch(request(key));
    const body = await res.json() as { error: { code: string; message: string } };

    expect(res.status).toBe(503);
    expect(body.error).toEqual({ code: 'SERVICE_UNAVAILABLE', message: 'Authentication unavailable' });
    expect(JSON.stringify(body)).not.toContain(key);
    expect(calls.downstream).toBe(0);
  });

  it('updates last-used with only the resolved id after default auth', async () => {
    const { key } = generateApiKey('test');
    db.selectResults.push([apiKey()]);
    const { app } = build();

    expect((await app.fetch(request(key))).status).toBe(200);
    await Promise.resolve();

    const update = db.calls.find((call) => call.text.includes('UPDATE'));
    expect(update?.values).toEqual([apiKey().id]);
    expect(update?.values).not.toContain(key);
    expect(update?.values).not.toContain(hashKey(key));
  });

  it('preserves resolver seam and BYOK context', async () => {
    const { key } = generateApiKey('test');
    setApiKeyResolver(async () => apiKey({ default_mode: 'balanced' }));
    const { app } = build();

    const res = await app.fetch(request(key, { 'X-Upstream-Key': 'sk-openai-real-xxxx' }));
    const body = await res.json() as {
      ok: boolean;
      policies: { default_mode: string };
      byok: boolean;
      hasByokKey: boolean;
    };

    expect(res.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      policies: { default_mode: 'balanced' },
      byok: true,
      hasByokKey: true,
    });
    expect(db.calls).toHaveLength(0);
  });

  it('returns fixed 503 when the injected resolver rejects', async () => {
    const { key } = generateApiKey('test');
    setApiKeyResolver(async () => {
      throw Error(`resolver failure for ${key}`);
    });
    const { app, calls } = build();

    const res = await app.fetch(request(key));

    expect(res.status).toBe(503);
    expect((await res.json() as { error: { message: string } }).error.message).toBe('Authentication unavailable');
    expect(calls.downstream).toBe(0);
  });
});
