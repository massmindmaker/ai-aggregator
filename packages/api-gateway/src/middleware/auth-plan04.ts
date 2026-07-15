/**
 * Plan-04 canonical auth middleware.
 *
 * Auth modes:
 *  1. Gateway API key:  `Authorization: Bearer sk_aiag_{live|test}_...`
 *     → SHA-256 hash, Redis cache, Postgres lookup in `gateway_api_keys`.
 *  2. Optional BYOK:    `X-Upstream-Key: <provider-key>` (accepted alongside).
 *  3. NextAuth session: for web-app admin endpoints — handled at app-router
 *     level, not in this middleware.
 *
 * NOTE: This file is re-exported by middleware/auth.ts as `requireApiKey`.
 */
import type { MiddlewareHandler } from 'hono';
import { makeRedis } from '../lib/redis';
import { sql } from '../lib/db';
import { hashKey, KEY_PREFIX_REGEX, parseBearer } from '../lib/api-key';
import { errors } from '../lib/errors';
import { logger } from '../lib/logger';

const CACHE_TTL_SEC = 300;

export type AuthenticatedApiKey = {
  id: string;
  org_id: string;
  policies: Record<string, unknown>;
  rpm_limit: number;
  daily_usd_cap: number | null;
  batch_rpm_limit: number;
  // Security review 2026-07: were persisted at key creation but never read by
  // the gateway — decoration only. Now selected + enforced (key-limits.ts /
  // this middleware's disabled_at guard). Optional so pre-existing test
  // fixtures / DI resolvers that predate this fix keep compiling.
  // NULL/undefined cost_limit_monthly_rub = unlimited (the DB default — do not
  // treat as 0). An empty/undefined model_whitelist = no restriction (also the
  // DB default, see gatewayApiKeys.modelWhitelist).
  cost_limit_monthly_rub?: number | null;
  model_whitelist?: string[];
  ru_residency_only?: boolean;
};

/**
 * Test/harness override: dependency-injected key resolver. When set, the
 * middleware uses this instead of the DB.
 */
let resolver:
  | ((keyPlain: string) => Promise<AuthenticatedApiKey | null>)
  | null = null;

export function setApiKeyResolver(
  fn: ((keyPlain: string) => Promise<AuthenticatedApiKey | null>) | null
): void {
  resolver = fn;
}

async function resolveFromDb(key: string): Promise<AuthenticatedApiKey | null> {
  const keyHash = hashKey(key);
  const redis = makeRedis('cache');
  const cacheKey = `apikey:${keyHash}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as AuthenticatedApiKey;
  } catch (e) {
    logger.warn({ err: String(e) }, 'auth_cache_read_fail');
  }

  // Security review 2026-07 (#2): "disable key" only ever set `disabled_at`
  // (see apps/web keys/[id] PATCH) — this query used to filter solely on
  // `revoked_at IS NULL`, so a disabled-but-not-revoked key kept working
  // forever. Also now selects cost_limit_monthly_rub / model_whitelist /
  // ru_residency_only (#3) — previously written at key creation but never
  // read here, so those caps were pure decoration.
  const rows = await sql<AuthenticatedApiKey[]>`
    SELECT id, org_id, policies,
           rpm_limit, daily_usd_cap, batch_rpm_limit,
           cost_limit_monthly_rub, model_whitelist, ru_residency_only
    FROM gateway_api_keys
    WHERE key_hash = ${keyHash}
      AND revoked_at IS NULL
      AND disabled_at IS NULL
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;

  try {
    await redis.setex(cacheKey, CACHE_TTL_SEC, JSON.stringify(row));
  } catch (e) {
    logger.warn({ err: String(e) }, 'auth_cache_write_fail');
  }
  // fire-and-forget last_used_at
  sql`UPDATE gateway_api_keys SET last_used_at = NOW() WHERE id = ${row.id}`.catch(() => {});
  return row;
}

export const requireApiKey: MiddlewareHandler = async (c, next) => {
  const key = parseBearer(c.req.header('authorization'));
  if (!key || !KEY_PREFIX_REGEX.test(key)) {
    throw errors.unauthorized();
  }
  const apiKey = resolver ? await resolver(key) : await resolveFromDb(key);
  if (!apiKey) throw errors.unauthorized();

  c.set('apiKey' as never, apiKey as never);
  c.set('orgId' as never, apiKey.org_id as never);

  // BYOK passthrough: just surface header into context; adapters read it.
  const byokKey = c.req.header('x-upstream-key');
  if (byokKey) {
    c.set('byokKey' as never, byokKey as never);
    c.set('byok' as never, true as never);
  }
  await next();
};
