import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import IORedisMock from 'ioredis-mock';
import { setRedisFactory } from '../lib/redis';
import { rateLimit } from '../middleware/rate-limit-plan04';
import { AiagError } from '../lib/errors';
import type { AuthenticatedApiKey } from '../middleware/auth-plan04';

function setupRedis(): void {
  const instance = new (IORedisMock as any)();
  setRedisFactory(() => instance as any);
}

function buildApp(keyOverride: Partial<AuthenticatedApiKey> = {}): Hono {
  const key: AuthenticatedApiKey = {
    id: 'k1',
    org_id: 'org1',
    policies: {},
    rpm_limit: 3,
    daily_usd_cap: null,
    batch_rpm_limit: 2,
    ...keyOverride,
  };
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof AiagError)
      return c.json(err.toResponseBody(), err.status as any, {
        'Retry-After': c.res.headers.get('Retry-After') ?? '',
      });
    return c.json({ error: { code: 'INTERNAL' } }, 500);
  });
  app.use('*', async (c, next) => {
    c.set('apiKey' as never, key as never);
    await next();
  });
  app.use('/v1/*', rateLimit);
  app.get('/v1/chat/x', (c) => c.json({ ok: true }));
  app.get('/v1/batches/x', (c) => c.json({ ok: true }));
  return app;
}

describe('rate-limit middleware — per-key RPM', () => {
  beforeEach(setupRedis);

  it('allows up to rpm_limit, rejects N+1 with 429 + Retry-After', async () => {
    const app = buildApp({ rpm_limit: 3 });
    for (let i = 0; i < 3; i++) {
      const r = await app.fetch(new Request('http://x/v1/chat/x'));
      expect(r.status).toBe(200);
    }
    const r4 = await app.fetch(new Request('http://x/v1/chat/x'));
    expect(r4.status).toBe(429);
    expect(r4.headers.get('Retry-After')).toMatch(/^\d+$/);
  });

  it('batch path uses separate bucket batch_rpm_limit', async () => {
    const app = buildApp({ rpm_limit: 100, batch_rpm_limit: 2 });
    const r1 = await app.fetch(new Request('http://x/v1/batches/x'));
    const r2 = await app.fetch(new Request('http://x/v1/batches/x'));
    const r3 = await app.fetch(new Request('http://x/v1/batches/x'));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
  });

  it('daily USD cap: blocks when cumulative ≥ cap', async () => {
    setupRedis();
    const app = buildApp({ daily_usd_cap: '0.10' as any });
    // pre-seed redis key directly through the same instance
    const IORedisModule: any = IORedisMock;
    // grab shared mock factory
    // actually the factory returns a single instance — fetch from middleware
    // via a throwaway call first, then overwrite. Simplest: set a fresh instance
    // and pre-seed directly by calling SET through rate-limit'd redis.
    const today = new Date().toISOString().slice(0, 10);
    const mock: any = new IORedisModule();
    setRedisFactory(() => mock);
    await mock.set(`usd_day:org1:${today}`, '0.10');
    const r = await app.fetch(new Request('http://x/v1/chat/x'));
    expect(r.status).toBe(429);
  });
});
