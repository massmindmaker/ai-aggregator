import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedApiKey } from '../middleware/auth-plan04';
import { createBatchQueueProducer } from '../lib/batch-queue';
import { createStoredBatchesRoute } from '../routes/v1/stored-batches';

const orgId = '10000000-0000-4000-8000-000000000001';
const apiKeyId = '20000000-0000-4000-8000-000000000001';
const key: AuthenticatedApiKey = {
  id: apiKeyId,
  org_id: orgId,
  policies: {},
  rpm_limit: 100,
  batch_rpm_limit: 10,
  daily_usd_cap: null,
};
const identity = Object.freeze({
  contractVersion: 5 as const,
  routeKind: 'batch' as const,
  billingMode: 'stored' as const,
  batchType: 'chat' as const,
  idempotencyKeyDigest: 'a'.repeat(64),
  requestFingerprint: 'b'.repeat(64),
  declaredSessionId: null,
  items: Object.freeze([{ index: 0, customId: 'one', routeKind: 'chat' as const, requestedMode: null, requestFingerprint: 'c'.repeat(64), attemptBody: { model: 'openai/gpt-4o-mini', messages: [{ role: 'user' as const, content: 'hi' }], stream: false } }]),
});
const summary = Object.freeze({
  id: '30000000-0000-4000-8000-000000000001', batchId: 'batch_' + 'd'.repeat(32),
  orgId, apiKeyId, batchType: 'chat', status: 'queued' as const,
  totalCount: 1, completedCount: 0, failedCount: 0, reconciliationCount: 0,
  settledMicrocredits: 0n, contractVersion: 5, billingMode: 'stored',
  idempotencyKeyDigest: identity.idempotencyKeyDigest, requestFingerprint: identity.requestFingerprint,
  queuedAt: null, reconcileAfter: null, terminalAt: null,
  createdAt: '2026-09-27T10:00:00.000000Z', expiresAt: '2026-09-28T10:00:00.000000Z',
});

function request(method: string, path = '/v1/batches', body?: unknown) {
  return new Request('http://test' + path, {
    method,
    headers: { 'content-type': 'application/json', 'idempotency-key': 'request-1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function harness(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const deps = {
    captureIdentity: vi.fn(async () => { calls.push('identity'); return identity; }),
    readBatch: vi.fn(async () => { calls.push('read'); return null; }),
    prepareItems: vi.fn(async () => { calls.push('prepare'); return [{ index: 0 }]; }),
    createOrReplay: vi.fn(async () => { calls.push('create'); return { kind: 'created' as const, batch: summary }; }),
    enqueue: vi.fn(async () => { calls.push('enqueue'); }),
    markQueued: vi.fn(async () => { calls.push('queued'); }),
    markRecovery: vi.fn(async () => { calls.push('recovery'); }),
    readResults: vi.fn(async () => { calls.push('results'); return { items: [], nextCursor: null }; }),
    now: () => new Date('2026-09-27T10:00:00.000Z'),
    ...overrides,
  } as any;
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('apiKey' as never, key as never); c.set('requestId' as never, 'req_test' as never); await next(); });
  app.route('/v1/batches', createStoredBatchesRoute(deps));
  return { app, deps, calls };
}

describe('durable batch queue producer', () => {
  it('sends only the owned batch id with deterministic queue ownership', async () => {
    const add = vi.fn(async () => ({ id: 'batch-' + summary.batchId }));
    const close = vi.fn(async () => {});
    const enqueue = createBatchQueueProducer({
      redisUrl: 'redis://127.0.0.1:16379',
      openQueue: vi.fn(async () => ({ add, close })),
    });
    await enqueue(summary.batchId);
    await enqueue(summary.batchId);
    expect(add).toHaveBeenCalledWith('batch', { batchId: summary.batchId }, {
      jobId: 'batch-' + summary.batchId,
      removeOnComplete: 1000,
      removeOnFail: 1000,
    });
    expect(Object.keys(add.mock.calls[0]![1])).toEqual(['batchId']);
    expect(add).toHaveBeenCalledTimes(2);
    expect(add.mock.calls[1]).toEqual(add.mock.calls[0]);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('rejects a missing BullMQ acknowledgement and still closes the queue', async () => {
    const close = vi.fn(async () => {});
    const enqueue = createBatchQueueProducer({
      redisUrl: 'redis://127.0.0.1:16379',
      openQueue: vi.fn(async () => ({ add: vi.fn(async () => undefined), close })),
    });
    await expect(enqueue(summary.batchId)).rejects.toThrow('acknowledgement');
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('stored batch HTTP composition', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does identity, durable replay read, full preparation, atomic create and queue ACK before 202', async () => {
    const { app, calls } = harness();
    const response = await app.fetch(request('POST', '/v1/batches', { type: 'chat', requests: [] }));
    expect(response.status).toBe(202);
    expect(calls).toEqual(['identity', 'read', 'prepare', 'create', 'enqueue', 'queued']);
    expect(await response.json()).toMatchObject({ batch_id: summary.batchId, status: 'queued' });
  });

  it('rejects a body over 2 MiB before any durable read or queue effect', async () => {
    const readBatch = vi.fn();
    const enqueue = vi.fn();
    const app = new Hono();
    app.use('*', async (c, next) => { c.set('apiKey' as never, key as never); await next(); });
    app.route('/v1/batches', createStoredBatchesRoute({ readBatch, enqueue }));
    const response = await app.fetch(new Request('http://test/v1/batches', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'oversized' },
      body: JSON.stringify({ type: 'chat', requests: [], padding: 'x'.repeat(2 * 1024 * 1024) }),
    }));
    expect(response.status).toBe(400);
    expect(readBatch).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('returns terminal replay as 200 without prepare, queue or provider work', async () => {
    const terminal = { ...summary, status: 'completed', terminalAt: '2026-09-27T10:01:00.000000Z' };
    const { app, deps, calls } = harness({ readBatch: vi.fn(async () => { calls.push('read'); return terminal; }) });
    const response = await app.fetch(request('POST', '/v1/batches', { type: 'chat', requests: [] }));
    expect(response.status).toBe(200);
    expect(calls).toEqual(['identity', 'read']);
    expect(deps.prepareItems).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it('re-enqueues a nonterminal replay only when durable queue ownership is missing', async () => {
    const { app, deps } = harness({ readBatch: vi.fn(async () => summary) });
    const response = await app.fetch(request('POST', '/v1/batches', { type: 'chat', requests: [] }));
    expect(response.status).toBe(202);
    expect(deps.prepareItems).not.toHaveBeenCalled();
    expect(deps.createOrReplay).not.toHaveBeenCalled();
    expect(deps.enqueue).toHaveBeenCalledWith(summary.batchId);
    expect(deps.markQueued).toHaveBeenCalledOnce();

    const owned = { ...summary, queuedAt: '2026-09-27T09:59:59.000000Z' };
    const second = harness({ readBatch: vi.fn(async () => owned) });
    expect((await second.app.fetch(request('POST', '/v1/batches', { type: 'chat', requests: [] }))).status).toBe(202);
    expect(second.deps.enqueue).not.toHaveBeenCalled();
    expect(second.deps.markQueued).not.toHaveBeenCalled();
  });

  it('returns changed identity as 409 before preparation or queue effects', async () => {
    const changed = { ...summary, requestFingerprint: 'e'.repeat(64) };
    const { app, deps } = harness({ readBatch: vi.fn(async () => changed) });
    const response = await app.fetch(request('POST', '/v1/batches', { type: 'chat', requests: [] }));
    expect(response.status).toBe(409);
    expect(deps.prepareItems).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it('marks durable recovery and returns fixed 503 when queue ACK is uncertain', async () => {
    const { app, deps } = harness({ enqueue: vi.fn(async () => { throw new Error('redis private detail'); }) });
    const response = await app.fetch(request('POST', '/v1/batches', { type: 'chat', requests: [] }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'BATCH_RECONCILIATION_REQUIRED', message: 'Batch queue reconciliation required' } });
    expect(deps.markRecovery).toHaveBeenCalledWith(summary.batchId, '2026-09-27T10:00:02.000Z');
  });

  it('serves summary and results from scoped durable reads without enqueue', async () => {
    const { app, deps } = harness({ readBatch: vi.fn(async () => summary) });
    const one = await app.fetch(request('GET', '/v1/batches/' + summary.batchId));
    const two = await app.fetch(request('GET', '/v1/batches/' + summary.batchId + '/results?cursor=0&limit=10'));
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect(deps.readBatch).toHaveBeenCalledWith(orgId, summary.batchId);
    expect(deps.readResults).toHaveBeenCalledWith(orgId, summary.batchId, 0, 10);
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.prepareItems).not.toHaveBeenCalled();
  });
});
