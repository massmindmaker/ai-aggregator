import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const read = vi.hoisted(() => vi.fn());
vi.mock('../catalog/public-catalog', () => ({
  PublicCatalogError: class PublicCatalogError extends Error {
    constructor(readonly kind: string) { super(kind); }
  },
  readPublicCatalog: read,
}));

import { catalogRoute } from '../routes/v1/catalog';
import { catalogHttpBoundary } from '../catalog/http-contract';

const key = {
  id: '30000000-0000-4000-8000-000000000001',
  org_id: '40000000-0000-4000-8000-000000000001',
  policies: {}, rpm_limit: 10, batch_rpm_limit: 1, daily_usd_cap: null,
  model_whitelist: [], ru_residency_only: false,
};
const response = {
  schemaVersion: 1, object: 'catalog.list',
  catalogRevision: `sha256:${'a'.repeat(64)}`,
  data: [], page: { limit: 20, nextCursor: null },
};

function mounted() {
  const app = new Hono();
  app.use('/v1/catalog/*', async (c, next) => { c.set('apiKey' as never, key as never); await next(); });
  app.route('/v1/catalog', catalogRoute);
  return app;
}

describe('catalog route request contract', () => {
  it('captures only canonical bounded query values and emits an advisory 200', async () => {
    read.mockResolvedValueOnce(response);
    const result = await mounted().request('/v1/catalog?limit=20');
    expect(result.status).toBe(200);
    expect(result.headers.get('vary')).toBe('Authorization');
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ key, limit: 20, cursor: null }));
  });

  it.each(['/v1/catalog?limit=01', '/v1/catalog?limit=101', '/v1/catalog?limit=1&limit=2', '/v1/catalog?offset=0'])('rejects invalid query %s without reading the catalog', async (path) => {
    const before = read.mock.calls.length;
    const result = await mounted().request(path);
    expect(result.status).toBe(400);
    expect(await result.json()).toEqual({ error: { code: 'INVALID_CATALOG_QUERY', message: 'Invalid catalog query' } });
    expect(read).toHaveBeenCalledTimes(before);
  });

  it.each(['/v1/catalog?cursor=', '/v1/catalog?cursor=***', `/v1/catalog?cursor=${'a'.repeat(1025)}`])('rejects malformed cursors %s', async (path) => {
    const result = await mounted().request(path);
    expect(result.status).toBe(400);
    expect(await result.json()).toEqual({ error: { code: 'INVALID_CATALOG_CURSOR', message: 'Invalid catalog cursor' } });
  });

  it.each([
    ['key_policy_unavailable', 'KEY_POLICY_UNAVAILABLE', 'Key policy unavailable'],
    ['revision_changed', 'CATALOG_REVISION_CHANGED', 'Catalog changed; restart pagination'],
    ['catalog_unavailable', 'CATALOG_UNAVAILABLE', 'Catalog unavailable'],
  ])('maps projector %s without exposing its exception', async (kind, code, message) => {
    const { PublicCatalogError } = await import('../catalog/public-catalog');
    read.mockRejectedValueOnce(new PublicCatalogError(kind as 'key_policy_unavailable' | 'revision_changed' | 'catalog_unavailable'));
    const result = await mounted().request('/v1/catalog');
    expect(result.status).toBe(kind === 'revision_changed' ? 409 : 503);
    expect(await result.json()).toEqual({ error: { code, message } });
    if (result.status === 503) expect(result.headers.get('retry-after')).toBe('2');
  });
});

describe('catalog early HTTP boundary', () => {
  function guarded(status: number, thrown: boolean, retry?: string) {
    const app = new Hono();
    app.use('/v1/catalog', catalogHttpBoundary);
    app.onError((_error, c) => c.json({ error: { code: 'RAW', message: 'redis secret diagnostic' } }, status as 401 | 402 | 404 | 429 | 503));
    app.get('/v1/catalog', (c) => {
      if (retry) c.header('Retry-After', retry);
      if (thrown) throw Object.assign(new Error('redis secret diagnostic'), { status });
      return c.json({ error: { code: 'RAW', message: 'redis secret diagnostic', details: { token: 'secret' } } }, status as 401 | 402 | 404 | 429 | 503);
    });
    return app;
  }

  it.each([
    [401, false, undefined, { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }],
    [402, false, undefined, { error: { code: 'PAYMENT_REQUIRED', message: 'Payment required' } }],
    [429, false, '7', { error: { code: 'RATE_LIMITED', message: 'Rate limited' } }],
    [503, false, undefined, { error: { code: 'SERVICE_UNAVAILABLE', message: 'Service unavailable' } }],
    [503, true, undefined, { error: { code: 'SERVICE_UNAVAILABLE', message: 'Service unavailable' } }],
  ] as const)('sanitizes returned and thrown guard failure %i', async (status, thrown, retry, body) => {
    const result = await guarded(status, thrown, retry).request('/v1/catalog');
    const text = await result.clone().text();
    expect(result.status).toBe(status);
    expect(await result.json()).toEqual(body);
    expect(result.headers.get('cache-control')).toBe('private, no-store');
    expect(text).not.toContain('secret');
    if (status === 503) expect(result.headers.get('retry-after')).toBe('2');
    if (status === 429) expect(result.headers.get('retry-after')).toBe('7');
  });

  it('converts unsupported catalog methods to the fixed 404 envelope', async () => {
    const app = new Hono();
    app.use('/v1/catalog', catalogHttpBoundary);
    app.notFound((c) => c.json({ error: { code: 'RAW', message: 'storage diagnostic' } }, 404));
    const result = await app.request('/v1/catalog', { method: 'POST' });
    expect(await result.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
    expect(result.headers.get('cache-control')).toBe('private, no-store');
  });
});
