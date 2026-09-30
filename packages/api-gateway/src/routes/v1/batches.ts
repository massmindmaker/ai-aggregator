/**
 * Plan 04 Task 14 — Batch API.
 *
 *   POST /v1/batches      { requests: [...] } → { batch_id, status: 'queued' }
 *   GET  /v1/batches/:id  → batch status row
 *
 * The rate-limit middleware (rate-limit-plan04.ts) already special-cases
 * paths starting with /v1/batches and applies the per-key `batch_rpm_limit`.
 *
 * On POST we:
 *   1. persist a `batches` row (status='queued') so GET can read it back, and
 *   2. enqueue a BullMQ job on the `batch-process` queue
 *      (QUEUE_NAMES.batchProcess in apps/worker/src/queues/names.ts) carrying
 *      the inline request array for the worker to fan out.
 *
 * bullmq is imported dynamically so a missing dependency / unreachable Redis
 * degrades gracefully. The batch row is still written, so the batch is
 * recoverable.
 *
 * Ops note: requires REDIS_URL + a running `batch-process` worker on the VPS
 * to actually execute. The worker consumer is out of scope for this route
 * (route is the producer side only).
 */
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sql } from '../../lib/db';
import { errors } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { config } from '../../config';
import type { AuthenticatedApiKey } from '../../middleware/auth-plan04';

export const batches = new Hono();

const BATCH_QUEUE_NAME = 'batch-process'; // === QUEUE_NAMES.batchProcess
const MAX_REQUESTS = 50_000; // OpenAI batch cap; reject obviously-too-large bodies
const BATCH_TTL_HOURS = 24;

type BatchBody = {
  requests?: unknown;
  type?: string; // chat | embeddings | image (defaults to chat)
};

async function enqueueBatch(
  batchId: string,
  orgId: string,
  apiKeyId: string,
  type: string,
  requests: unknown[]
): Promise<boolean> {
  let queue: import('bullmq').Queue | null = null;
  try {
    const { Queue } = await import('bullmq');
    const url = new URL(config.REDIS_URL);
    queue = new Queue(BATCH_QUEUE_NAME, {
      connection: {
        host: url.hostname,
        port: Number(url.port) || 6379,
        password: url.password || undefined,
        tls: url.protocol === 'rediss:' ? {} : undefined,
      },
    });
    await queue.add('batch', { batchId, orgId, apiKeyId, type, requests });
    return true;
  } catch (err) {
    // BullMQ missing or Redis unreachable — the batch row is already persisted,
    // so an operator can re-enqueue later. Don't fail the request.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), batchId },
      'batch_enqueue_failed'
    );
    return false;
  } finally {
    if (queue) queue.close().catch(() => { /* ignore */ });
  }
}

batches.post('/', async (c) => {
  const key = c.get('apiKey' as never) as AuthenticatedApiKey;
  const orgId = (c.get('orgId' as never) as string) ?? key?.org_id;

  const body = (await c.req.json().catch(() => null)) as BatchBody | null;
  if (!body || !Array.isArray(body.requests)) {
    throw errors.badRequest('requests[] required');
  }
  const requests = body.requests as unknown[];
  if (requests.length === 0) {
    throw errors.badRequest('requests[] must not be empty');
  }
  if (requests.length > MAX_REQUESTS) {
    throw errors.badRequest(`requests[] exceeds max of ${MAX_REQUESTS}`);
  }

  const type = typeof body.type === 'string' ? body.type : 'chat';
  const batchId = `batch_${randomUUID().replace(/-/g, '')}`;
  const expiresAt = new Date(Date.now() + BATCH_TTL_HOURS * 3600 * 1000);

  // Persist the batch row. input_file_url is NOT NULL in the schema, but this
  // is an inline (non-file) batch — store a marker so the column is satisfied
  // and the origin is unambiguous.
  await sql`
    INSERT INTO batches (batch_id, org_id, api_key_id, type, status, input_file_url, total_count, expires_at)
    VALUES (
      ${batchId},
      ${orgId}::uuid,
      ${key?.id ?? null},
      ${type},
      'queued',
      ${`inline:${batchId}`},
      ${requests.length},
      ${expiresAt.toISOString()}
    )
  `;

  const enqueued = await enqueueBatch(batchId, orgId, key?.id ?? '', type, requests);

  return c.json(
    {
      batch_id: batchId,
      status: 'queued',
      type,
      total_count: requests.length,
      enqueued,
      expires_at: expiresAt.toISOString(),
    },
    202
  );
});

batches.get('/:id', async (c) => {
  const key = c.get('apiKey' as never) as AuthenticatedApiKey;
  const orgId = (c.get('orgId' as never) as string) ?? key?.org_id;
  const id = c.req.param('id');

  const rows = await sql<
    Array<{
      batch_id: string;
      status: string;
      type: string;
      total_count: number;
      completed_count: number;
      failed_count: number;
      output_file_url: string | null;
      error_file_url: string | null;
      cost_rub: string;
      created_at: string;
      expires_at: string;
    }>
  >`
    SELECT batch_id, status, type, total_count, completed_count, failed_count,
           output_file_url, error_file_url, cost_rub, created_at, expires_at
      FROM batches
     WHERE batch_id = ${id}
       AND org_id = ${orgId}::uuid
     LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw errors.notFound('batch');

  return c.json({
    batch_id: row.batch_id,
    status: row.status,
    type: row.type,
    total_count: row.total_count,
    completed_count: row.completed_count,
    failed_count: row.failed_count,
    output_file_url: row.output_file_url,
    error_file_url: row.error_file_url,
    cost_rub: Number(row.cost_rub),
    created_at: row.created_at,
    expires_at: row.expires_at,
  });
});
