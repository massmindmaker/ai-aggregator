import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { AiagError, errors } from '../lib/errors';
import { requestIdMiddleware } from '../middleware/request-id';

/**
 * Lightweight server-shape test that doesn't import ../server.ts (which wires
 * the full middleware stack — those are tested individually). We verify the
 * boot-time pieces: request-id passthrough + AiagError serialization.
 */
function build(): Hono {
  const app = new Hono();
  app.use('*', requestIdMiddleware());
  app.onError((err, c) => {
    if (err instanceof AiagError)
      return c.json(err.toResponseBody(), err.status as any);
    return c.json({ error: { code: 'INTERNAL' } }, 500);
  });
  app.get('/health', (c) =>
    c.json({
      ok: true,
      runtime: `node ${process.version}`,
      uptime_s: 0,
    })
  );
  app.get('/boom', () => {
    throw errors.paymentRequired();
  });
  return app;
}

describe('gateway server shape', () => {
  it('GET /health → 200 + json body with runtime + uptime', async () => {
    const app = build();
    const r = await app.fetch(new Request('http://x/health'));
    expect(r.status).toBe(200);
    const j = (await r.json()) as {
      ok: boolean;
      runtime: string;
      uptime_s: number;
    };
    expect(j.ok).toBe(true);
    expect(j.runtime).toMatch(/node|bun/);
    expect(typeof j.uptime_s).toBe('number');
  });

  it('requestIdMiddleware echoes custom X-Request-Id', async () => {
    const app = build();
    const r = await app.fetch(
      new Request('http://x/health', {
        headers: { 'X-Request-Id': 'req-abc-123' },
      })
    );
    expect(r.headers.get('X-Request-Id')).toBe('req-abc-123');
  });

  it('requestIdMiddleware generates one when absent', async () => {
    const app = build();
    const r = await app.fetch(new Request('http://x/health'));
    expect(r.headers.get('X-Request-Id')).toMatch(/^req_/);
  });

  it('AiagError rendered with code + status', async () => {
    const app = build();
    const r = await app.fetch(new Request('http://x/boom'));
    expect(r.status).toBe(402);
    const j = (await r.json()) as { error: { code: string } };
    expect(j.error.code).toBe('PAYMENT_REQUIRED');
  });
});


const legacyOrder = vi.hoisted(() => [] as string[]);
const catalogRead = vi.hoisted(() => vi.fn());
vi.mock('../config', async () => ({ ...(await vi.importActual<typeof import('../config')>('../config')) }));
vi.mock('../egress-executor', () => ({ registerGatewayEgressExecutor: vi.fn() }));
vi.mock('../middleware/auth-plan04', () => ({ requireApiKey: async (c: any, next: () => Promise<void>) => { legacyOrder.push('auth'); c.set('apiKey', { id: '30000000-0000-4000-8000-000000000001', org_id: '40000000-0000-4000-8000-000000000001', policies: {}, rpm_limit: 10, batch_rpm_limit: 1, daily_usd_cap: null, model_whitelist: [], ru_residency_only: false }); await next(); } }));
vi.mock('../middleware/rate-limit-plan04', () => ({ rateLimit: async (_c: unknown, next: () => Promise<void>) => { legacyOrder.push('rate'); await next(); }, rpmOnly: vi.fn() }));
vi.mock('../middleware/key-limits', () => ({ keyLimits: async (_c: unknown, next: () => Promise<void>) => { legacyOrder.push('key'); await next(); } }));
vi.mock('../middleware/pii-filter', () => ({ piiFilter: async (_c: unknown, next: () => Promise<void>) => { legacyOrder.push('pii'); await next(); } }));
vi.mock('../middleware/model-status-check', () => ({ modelStatusMiddleware: () => async (_c: unknown, next: () => Promise<void>) => { legacyOrder.push('model'); await next(); } }));
vi.mock('../routes/v1/chat', async () => { const { Hono } = await import('hono'); return { chat: new Hono().post('/completions', c => { legacyOrder.push('legacy-chat'); c.header('x-aiag-charged-usd-micro','123'); return c.json({legacy:true}); }) }; });
vi.mock('../catalog/public-catalog', () => ({
  PublicCatalogError: class PublicCatalogError extends Error { constructor(readonly kind: string) { super(kind); } },
  readPublicCatalog: catalogRead,
}));
import { app as productionApp } from '../server';
it('default production assembly retains legacy middleware order and handler response', async () => {
  legacyOrder.length = 0;
  const response = await productionApp.request('/v1/chat/completions',{method:'POST'});
  expect(response.status).toBe(200); expect(await response.json()).toEqual({legacy:true});
  expect(legacyOrder).toEqual(['auth','rate','key','pii','model','legacy-chat']);
  expect(response.headers.get('x-aiag-charged-usd-micro')).toBe('123');
  expect(response.headers.get('x-aiag-receipt-version')).toBeNull();
});

it.each(['/v1/catalog', '/v1/catalog/'])('legacy assembly mounts catalog alias through the unchanged common guard order: %s', async (path) => {
  legacyOrder.length = 0;
  catalogRead.mockResolvedValueOnce({
    schemaVersion: 1, object: 'catalog.list', catalogRevision: `sha256:${'a'.repeat(64)}`,
    data: [], page: { limit: 20, nextCursor: null },
  });
  const response = await productionApp.request(path);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ object: 'catalog.list' });
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('vary')).toBe('Authorization');
  expect(legacyOrder).toEqual(['auth', 'rate', 'key', 'pii', 'model']);
});
