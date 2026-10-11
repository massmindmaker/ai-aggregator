/**
 * Phase 14 / plan 14-06 — gateway middleware: model degradation state machine
 * short-circuit (spec §7.3).
 *
 * Before forwarding /v1/* requests, look up `models.status` for the requested
 * model_slug. If the model is `frozen` or `depublished`, return 503 with
 * `Retry-After: 3600` (frozen) or 410 Gone (depublished) — see spec §7.3.
 * Anything else (including `live`) passes through.
 *
 * **B-3 (no in-process cache):** Per-request DB lookup against `models`. The
 * settle-charge SQL (plan 14-01) is the AUTHORITATIVE accrual cutoff
 * (`m.status = 'live'`). This middleware is a 503-short-circuit OPTIMIZATION.
 * Adding a TTL cache here would (a) drift accrual decisions vs. middleware
 * decisions and (b) confuse operators when a freeze takes "up to N seconds"
 * to take effect. The DB has `idx_models_status_live` (migration 0014) so
 * lookups are sub-millisecond. NEVER add caching without first wiring a
 * synchronous flush endpoint called from the freeze/depublish admin routes.
 */
import type { Context, Next, MiddlewareHandler } from 'hono';
import { sql as defaultSql, type SqlClient } from '../lib/db';

export type ModelStatus =
  | 'live'
  | 'frozen'
  | 'depublished'
  | 'draft'
  | 'pending_author_consent'
  | 'unknown';

/**
 * Fresh per-request DB lookup. Injectable `sql` for tests.
 */
export async function checkModelStatus(
  modelSlug: string,
  sql: SqlClient = defaultSql
): Promise<ModelStatus> {
  // postgres.js tagged template returns an array of rows.
  const rows = (await sql<{ status: string }[]>`
    SELECT status FROM models WHERE slug = ${modelSlug} LIMIT 1
  `) as unknown as Array<{ status?: string }>;
  const s = rows[0]?.status;
  if (!s) return 'unknown';
  switch (s) {
    case 'live':
    case 'frozen':
    case 'depublished':
    case 'draft':
    case 'pending_author_consent':
      return s;
    default:
      return 'unknown';
  }
}

/**
 * Hono middleware factory. Reads `model` from the JSON body (through Hono's
 * cached-body read so downstream handlers can re-parse it). Non-JSON bodies /
 * no `model` field pass through.
 */
export function modelStatusMiddleware(sqlClient: SqlClient = defaultSql): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    let modelSlug: string | undefined;
    try {
      // Review wave (T-a2 guard parity): read via c.req.json(), NOT
      // c.req.raw.clone(). In both the legacy /v1/* chain and the MCP
      // facade's sub-app this middleware runs AFTER piiFilter, which already
      // consumed the raw stream via c.req.json() — and Request.clone()
      // throws once the body is used, so the old clone-based read made this
      // guard silently skip every JSON POST that reached piiFilter (the
      // freeze/depublish short-circuit never fired on chat paths). Hono's
      // body cache keeps the parsed body readable here and for downstream
      // handlers alike.
      const body = (await c.req.json()) as { model?: unknown };
      if (typeof body?.model === 'string') modelSlug = body.model;
    } catch {
      return next();
    }
    if (!modelSlug) return next();

    const status = await checkModelStatus(modelSlug, sqlClient);

    if (status === 'frozen') {
      c.header('Retry-After', '3600');
      return c.json(
        { error: 'MODEL_FROZEN', model: modelSlug, status },
        503
      );
    }
    if (status === 'depublished') {
      // Terminal — spec §7.3 calls this 410 Gone (resource permanently removed).
      return c.json(
        { error: 'MODEL_DEPUBLISHED', model: modelSlug, status },
        410
      );
    }
    return next();
  };
}
