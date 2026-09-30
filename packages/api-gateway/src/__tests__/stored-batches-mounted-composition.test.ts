import { expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ batch: vi.fn(), rpm: vi.fn() }));
vi.mock('../config', async () => {
  const actual = await vi.importActual<typeof import('../config')>('../config');
  return { config: { ...actual.config, GATEWAY_HTTP_EXECUTION_MODE: 'stored_chat_embeddings_completions_stream_media_batches' } };
});
vi.mock('../egress-executor', () => ({ registerGatewayEgressExecutor: vi.fn() }));
vi.mock('../middleware/auth-plan04', () => ({
  requireApiKey: async (c: any, next: () => Promise<void>) => {
    c.set('apiKey', { id: '20000000-0000-4000-8000-000000000001', org_id: '10000000-0000-4000-8000-000000000001' });
    await next();
  },
}));
vi.mock('../middleware/rate-limit-plan04', () => ({ rateLimit: async (_c: unknown, next: () => Promise<void>) => next(), rpmOnly: async (_c: unknown, next: () => Promise<void>) => { calls.rpm(); await next(); } }));
vi.mock('../middleware/key-limits', () => ({ keyLimits: async (_c: unknown, next: () => Promise<void>) => next() }));
vi.mock('../middleware/pii-filter', () => ({ piiFilter: async (_c: unknown, next: () => Promise<void>) => next(), setPiiResolveModel: vi.fn() }));
vi.mock('../middleware/model-status-check', () => ({ modelStatusMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next() }));
vi.mock('../routes/v1/stored-batches', async () => {
  const { Hono } = await import('hono');
  return { storedBatches: new Hono().post('/', (c) => { calls.batch(); return c.json({ status: 'queued' }, 202); }) };
});

import { app } from '../server';

it('mounts POST /v1/batches only for the explicit durable batches composition', async () => {
  const response = await app.request('/v1/batches', {
    method: 'POST',
    headers: { authorization: `Bearer sk_aiag_test_${'a'.repeat(32)}` },
  });
  expect(response.status).toBe(202);
  expect(calls.rpm).toHaveBeenCalledOnce();
  expect(calls.batch).toHaveBeenCalledOnce();
});
