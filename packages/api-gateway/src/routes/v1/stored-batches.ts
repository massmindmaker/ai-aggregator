import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import type { AuthenticatedApiKey } from '../../middleware/auth-plan04';
import {
  captureStoredBatchHttpIdentity,
  STORED_BATCH_HTTP_IDENTITY_BAD_REQUEST_CODE,
  type StoredBatchHttpIdentity,
} from '../../billing/stored-batch-http-identity';
import { prepareStoredBatchItems } from '../../billing/stored-batch-item-preparation';
import {
  createOrReplayStoredBatch,
  markStoredBatchQueued,
  markStoredBatchQueueRecoveryNeeded,
  readStoredBatch,
  readStoredBatchResults,
  StoredBatchConflictError,
  type CreateStoredBatchArgs,
  type StoredBatchRead,
  type StoredBatchResultPage,
} from '../../billing/stored-batch-storage';
import { enqueueOwnedBatch } from '../../lib/batch-queue';

const BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const PRE_DISPATCH_WINDOW_MS = 60_000;
const BATCH_TTL_MS = 24 * 60 * 60 * 1000;
const RECOVERY_RETRY_MS = 2_000;
const BATCH_ID = /^batch_[0-9a-f]{32}$/;
const TERMINAL = new Set(['completed', 'completed_with_errors', 'failed']);

type StoredBatchRouteDependencies = Readonly<{
  captureIdentity(request: Request): Promise<StoredBatchHttpIdentity>;
  readBatch(orgId: string, batchId: string): Promise<StoredBatchRead | null>;
  prepareItems: typeof prepareStoredBatchItems;
  createOrReplay(args: CreateStoredBatchArgs): ReturnType<typeof createOrReplayStoredBatch>;
  enqueue(batchId: string): Promise<void>;
  markQueued(batchId: string, queuedAt: string): Promise<void>;
  markRecovery(batchId: string, retryAt: string): Promise<void>;
  readResults(orgId: string, batchId: string, cursor: number, limit: number): Promise<StoredBatchResultPage>;
  now(): Date;
}>;

async function captureRequestIdentity(request: Request): Promise<StoredBatchHttpIdentity> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new TypeError(STORED_BATCH_HTTP_IDENTITY_BAD_REQUEST_CODE);
  if (!request.body) throw new TypeError(STORED_BATCH_HTTP_IDENTITY_BAD_REQUEST_CODE);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > BODY_LIMIT_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new TypeError(STORED_BATCH_HTTP_IDENTITY_BAD_REQUEST_CODE);
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new TypeError(STORED_BATCH_HTTP_IDENTITY_BAD_REQUEST_CODE);
  }
  return captureStoredBatchHttpIdentity({
    body,
    idempotencyKey: request.headers.get('idempotency-key'),
    declaredSessionId: request.headers.get('x-aiag-session-id'),
    byokKeyPresent: request.headers.has('x-upstream-key'),
  });
}

function stableBatchId(orgId: string, idempotencyKeyDigest: string): string {
  return `batch_${createHash('sha256').update(`v5|${orgId}|${idempotencyKeyDigest}`, 'utf8').digest('hex').slice(0, 32)}`;
}

function batchSummary(batch: StoredBatchRead) {
  return {
    batch_id: batch.batchId,
    type: batch.batchType,
    status: batch.status,
    total_count: batch.totalCount,
    completed_count: batch.completedCount,
    failed_count: batch.failedCount,
    reconciliation_count: batch.reconciliationCount,
    settled_microcredits: batch.settledMicrocredits.toString(),
    created_at: batch.createdAt,
    expires_at: batch.expiresAt,
  };
}

function resultPage(page: StoredBatchResultPage) {
  return {
    data: page.items.map((item) => ({
      index: item.index,
      custom_id: item.customId,
      status: item.status,
      ...(item.status === 'completed'
        ? { output: item.output, settled_microcredits: item.settledMicrocredits?.toString() ?? '0' }
        : item.status === 'failed'
          ? { error: { code: item.errorCode ?? 'BATCH_ITEM_FAILED', message: 'Batch item failed' } }
          : item.status === 'reconciliation_required'
            ? { error: { code: 'BATCH_ITEM_RECONCILIATION_REQUIRED', message: 'Batch item reconciliation required' } }
            : {}),
    })),
    next_cursor: page.nextCursor,
  };
}

function error(c: Parameters<Parameters<Hono['onError']>[0]>[1], status: 400 | 404 | 409 | 503, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

function ownedByKey(batch: StoredBatchRead, key: AuthenticatedApiKey): boolean {
  return batch.orgId === key.org_id && batch.apiKeyId === key.id;
}

export function createStoredBatchesRoute(partial: Partial<StoredBatchRouteDependencies> = {}): Hono {
  const deps: StoredBatchRouteDependencies = {
    captureIdentity: captureRequestIdentity,
    readBatch: readStoredBatch,
    prepareItems: prepareStoredBatchItems,
    createOrReplay: createOrReplayStoredBatch,
    enqueue: enqueueOwnedBatch,
    markQueued: markStoredBatchQueued,
    markRecovery: markStoredBatchQueueRecoveryNeeded,
    readResults: readStoredBatchResults,
    now: () => new Date(),
    ...partial,
  };
  const route = new Hono();

  route.post('/', async (c) => {
    const key = c.get('apiKey' as never) as AuthenticatedApiKey;
    let identity: StoredBatchHttpIdentity;
    try {
      identity = await deps.captureIdentity(c.req.raw);
    } catch {
      return error(c, 400, 'INVALID_STORED_BATCH_HTTP_IDENTITY', 'Invalid stored batch request');
    }
    const batchId = stableBatchId(key.org_id, identity.idempotencyKeyDigest);
    try {
      let batch = await deps.readBatch(key.org_id, batchId);
      if (batch) {
        if (!ownedByKey(batch, key) || batch.idempotencyKeyDigest !== identity.idempotencyKeyDigest ||
          batch.requestFingerprint !== identity.requestFingerprint || batch.batchType !== identity.batchType)
          return error(c, 409, 'BATCH_IDENTITY_CONFLICT', 'Batch identity conflict');
        if (TERMINAL.has(batch.status)) return c.json(batchSummary(batch), 200);
      } else {
        const now = deps.now();
        const items = await deps.prepareItems({
          identity,
          key,
          requestId: c.get('requestId' as never) as string,
          deadlineAt: new Date(now.getTime() + PRE_DISPATCH_WINDOW_MS).toISOString(),
        });
        const created = await deps.createOrReplay({
          orgId: key.org_id,
          apiKeyId: key.id,
          batchId,
          batchType: identity.batchType,
          contractVersion: 5,
          billingMode: 'stored',
          idempotencyKeyDigest: identity.idempotencyKeyDigest,
          requestFingerprint: identity.requestFingerprint,
          expiresAt: new Date(now.getTime() + BATCH_TTL_MS).toISOString(),
          items,
        });
        batch = created.batch;
        if (!ownedByKey(batch, key)) return error(c, 409, 'BATCH_IDENTITY_CONFLICT', 'Batch identity conflict');
        if (TERMINAL.has(batch.status)) return c.json(batchSummary(batch), 200);
      }
      if (batch.queuedAt === null) {
        const queuedAt = deps.now().toISOString();
        try {
          await deps.enqueue(batch.batchId);
          await deps.markQueued(batch.batchId, queuedAt);
          batch = { ...batch, queuedAt, reconcileAfter: null, status: 'queued' };
        } catch {
          try {
            await deps.markRecovery(batch.batchId, new Date(deps.now().getTime() + RECOVERY_RETRY_MS).toISOString());
          } catch { /* recovery scanner/operator still has the durable batch id */ }
          return error(c, 503, 'BATCH_RECONCILIATION_REQUIRED', 'Batch queue reconciliation required');
        }
      }
      return c.json(batchSummary(batch), 202);
    } catch (caught) {
      if (caught instanceof StoredBatchConflictError)
        return error(c, 409, 'BATCH_IDENTITY_CONFLICT', 'Batch identity conflict');
      return error(c, 503, 'BATCH_STATE_UNAVAILABLE', 'Batch state unavailable');
    }
  });

  route.get('/:id', async (c) => {
    const key = c.get('apiKey' as never) as AuthenticatedApiKey;
    const batchId = c.req.param('id');
    if (!BATCH_ID.test(batchId)) return error(c, 404, 'BATCH_NOT_FOUND', 'Batch not found');
    try {
      const batch = await deps.readBatch(key.org_id, batchId);
      if (!batch || !ownedByKey(batch, key)) return error(c, 404, 'BATCH_NOT_FOUND', 'Batch not found');
      return c.json(batchSummary(batch));
    } catch {
      return error(c, 503, 'BATCH_STATE_UNAVAILABLE', 'Batch state unavailable');
    }
  });

  route.get('/:id/results', async (c) => {
    const key = c.get('apiKey' as never) as AuthenticatedApiKey;
    const batchId = c.req.param('id');
    const cursorRaw = c.req.query('cursor');
    const limitRaw = c.req.query('limit');
    const cursor = cursorRaw === undefined ? -1 : Number(cursorRaw);
    const limit = limitRaw === undefined ? 10 : Number(limitRaw);
    if (!BATCH_ID.test(batchId) || !Number.isSafeInteger(cursor) || cursor < -1 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 10)
      return error(c, 400, 'INVALID_BATCH_RESULTS_QUERY', 'Invalid batch results query');
    try {
      const batch = await deps.readBatch(key.org_id, batchId);
      if (!batch || !ownedByKey(batch, key)) return error(c, 404, 'BATCH_NOT_FOUND', 'Batch not found');
      return c.json(resultPage(await deps.readResults(key.org_id, batchId, cursor, limit)));
    } catch {
      return error(c, 503, 'BATCH_STATE_UNAVAILABLE', 'Batch state unavailable');
    }
  });

  return route;
}

export const storedBatches = createStoredBatchesRoute();
