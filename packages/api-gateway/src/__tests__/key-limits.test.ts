import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import IORedisMock from 'ioredis-mock';
import { setRedisFactory } from '../lib/redis';
import { keyLimits, monthlyCostCounterKey } from '../middleware/key-limits';
import { AiagError } from '../lib/errors';
import type { AuthenticatedApiKey } from '../middleware/auth-plan04';

function buildApp(keyOverride: Partial<AuthenticatedApiKey> = {}): Hono {
  const key: AuthenticatedApiKey = {
    id: 'k1',
    org_id: 'org1',
    policies: {},
    rpm_limit: 60,
    daily_usd_cap: null,
    batch_rpm_limit: 10,
    ...keyOverride,
  };
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof AiagError) return c.json(err.toResponseBody(), err.status as any);
    return c.json({ error: { code: 'INTERNAL', message: String(err) } }, 500);
  });
  app.use('*', async (c, next) => {
    c.set('apiKey' as never, key as never);
    await next();
  });
  app.use('/v1/*', keyLimits);
  app.post('/v1/chat/completions', (c) => c.json({ ok: true }));
  return app;
}

describe('keyLimits middleware — model_whitelist', () => {
  beforeEach(() => setRedisFactory(() => new (IORedisMock as any)()));

  it('allows any model when whitelist is empty/unset (default = no restriction)', async () => {
    const app = buildApp({ model_whitelist: [] });
    const res = await app.fetch(
      new Request('http://x/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'anything-goes', messages: [] }),
      })
    );
    expect(res.status).toBe(200);
  });

  it('403s a model NOT in the whitelist', async () => {
    const app = buildApp({ model_whitelist: ['gpt-4o-mini'] });
    const res = await app.fetch(
      new Request('http://x/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-opus-4', messages: [] }),
      })
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('allows a model that IS in the whitelist', async () => {
    const app = buildApp({ model_whitelist: ['gpt-4o-mini'] });
    const res = await app.fetch(
      new Request('http://x/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o-mini', messages: [] }),
      })
    );
    expect(res.status).toBe(200);
  });
});

describe('keyLimits middleware — cost_limit_monthly_rub', () => {
  beforeEach(() => setRedisFactory(() => new (IORedisMock as any)()));

  it('passes through when no cap is set (NULL = unlimited, not 0)', async () => {
    const app = buildApp({ cost_limit_monthly_rub: null });
    const res = await app.fetch(
      new Request('http://x/v1/chat/completions', { method: 'POST' })
    );
    expect(res.status).toBe(200);
  });

  // Unit fix (2026-07-17): the counter is MICRO-credits (1 credit = 1000
  // micro = 1 US cent), the cap is ₽ — key-limits.ts now bridges the two via
  // the CBR rate (lib/cbr.ts), read from redis's daily cache. Seed that cache
  // so the test never makes a real network call, at a round rate (90) that
  // makes the fixture math exact: 100,000 micro = 100 credits = $1 = 90₽.

  it('passes when accumulated spend is below the cap', async () => {
    const mock: any = new (IORedisMock as any)();
    setRedisFactory(() => mock);
    await mock.set('cbr:usd_rub:today', '90');
    // 50,000 micro = 50 credits = $0.50 = 45₽ — below a 90₽ cap.
    await mock.set(monthlyCostCounterKey('k1'), '50000');
    const app = buildApp({ cost_limit_monthly_rub: 90 as any });
    const res = await app.fetch(
      new Request('http://x/v1/chat/completions', { method: 'POST' })
    );
    expect(res.status).toBe(200);
  });

  it('402s once accumulated spend reaches the cap', async () => {
    const mock: any = new (IORedisMock as any)();
    setRedisFactory(() => mock);
    await mock.set('cbr:usd_rub:today', '90');
    // 100,000 micro = 100 credits = $1 = 90₽ — exactly at a 90₽ cap.
    await mock.set(monthlyCostCounterKey('k1'), '100000');
    const app = buildApp({ cost_limit_monthly_rub: 90 as any });
    const res = await app.fetch(
      new Request('http://x/v1/chat/completions', { method: 'POST' })
    );
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PAYMENT_REQUIRED');
  });

  it('never touches CBR when nothing has been spent yet (no cache seed needed)', async () => {
    const mock: any = new (IORedisMock as any)();
    setRedisFactory(() => mock);
    // ioredis-mock shares its in-memory store across instances (verified),
    // so an earlier test's counter for the same key id + calendar month
    // would otherwise leak in here — use a fresh key id instead of relying
    // on isolation the mock doesn't provide.
    // No 'cbr:usd_rub:today' seeded, no counter set — if the middleware tried
    // a real CBR fetch this test would hang/fail on the network call.
    const app = buildApp({ id: 'k-fresh-no-spend', cost_limit_monthly_rub: 90 as any });
    const res = await app.fetch(
      new Request('http://x/v1/chat/completions', { method: 'POST' })
    );
    expect(res.status).toBe(200);
  });
});
