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

  // Blocker 2 fix (Opus review, 2026-07-17): migration 0061 converted
  // `cost_limit_monthly_rub` from a genuine ₽ figure to CREDITS (1 credit =
  // 1 US cent), the same unit chat.ts's INCR already accumulates
  // (MICRO-credits, 1000 = 1 credit). key-limits.ts now compares the two
  // directly — no CBR rate, no network call, ever, on this path.
  //
  // These tests DELIBERATELY do NOT seed 'cbr:usd_rub:today' or mock
  // lib/cbr.ts — that's the point. The PREVIOUS version of this file seeded
  // the CBR cache to keep the "below cap" / "at cap" tests off the network,
  // which is exactly how a cold-cache prod outage (up to ~88s of blocking
  // per request, cbr.ru 2 URLs x 3 retries, no fail-open) went untested:
  // every green run had quietly warmed the branch it needed to prove was
  // safe. If key-limits.ts ever re-imports fetchUsdRubRate, these tests will
  // hang/fail on the real network call instead of silently passing.

  it('passes when accumulated spend is below the cap', async () => {
    const mock: any = new (IORedisMock as any)();
    setRedisFactory(() => mock);
    // 50,000 micro = 50 credits — below a 100-credit cap.
    await mock.set(monthlyCostCounterKey('k1'), '50000');
    const app = buildApp({ cost_limit_monthly_rub: 100 as any });
    const res = await app.fetch(
      new Request('http://x/v1/chat/completions', { method: 'POST' })
    );
    expect(res.status).toBe(200);
  });

  it('402s once accumulated spend reaches the cap', async () => {
    const mock: any = new (IORedisMock as any)();
    setRedisFactory(() => mock);
    // 100,000 micro = 100 credits — exactly at a 100-credit cap.
    await mock.set(monthlyCostCounterKey('k1'), '100000');
    const app = buildApp({ cost_limit_monthly_rub: 100 as any });
    const res = await app.fetch(
      new Request('http://x/v1/chat/completions', { method: 'POST' })
    );
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PAYMENT_REQUIRED');
  });

  it('never touches the network when nothing has been spent yet', async () => {
    const mock: any = new (IORedisMock as any)();
    setRedisFactory(() => mock);
    // ioredis-mock shares its in-memory store across instances (verified),
    // so an earlier test's counter for the same key id + calendar month
    // would otherwise leak in here — use a fresh key id instead of relying
    // on isolation the mock doesn't provide.
    const app = buildApp({ id: 'k-fresh-no-spend', cost_limit_monthly_rub: 100 as any });
    const res = await app.fetch(
      new Request('http://x/v1/chat/completions', { method: 'POST' })
    );
    expect(res.status).toBe(200);
  });

  it('a cold CBR cache cannot block this route — no fetchUsdRubRate call exists on this path', async () => {
    // Regression guard for the outage itself: even with spend present and no
    // CBR-related key of any kind in redis, the request resolves
    // synchronously (fast, deterministic) rather than hanging on a fetch.
    const mock: any = new (IORedisMock as any)();
    setRedisFactory(() => mock);
    await mock.set(monthlyCostCounterKey('k-cold-cbr'), '10000'); // 10 credits, well under cap
    const start = Date.now();
    const app = buildApp({ id: 'k-cold-cbr', cost_limit_monthly_rub: 100 as any });
    const res = await app.fetch(
      new Request('http://x/v1/chat/completions', { method: 'POST' })
    );
    expect(res.status).toBe(200);
    expect(Date.now() - start).toBeLessThan(1000); // no retry/backoff schedule ran
  });
});
