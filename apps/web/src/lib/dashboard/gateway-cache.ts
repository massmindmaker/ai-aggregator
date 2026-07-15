/**
 * Invalidates the gateway's Redis auth cache (`apikey:{hash}`, TTL 300s — see
 * packages/api-gateway/src/middleware/auth-plan04.ts) when a key is
 * disabled/revoked/deleted or its limits change from the web dashboard.
 *
 * Security review 2026-07 (#4): without this, a revoked/disabled key (or one
 * that just had its cost cap / whitelist tightened) keeps authenticating
 * against the gateway's cached copy for up to 5 more minutes even after the
 * DB row is correct.
 *
 * `keyHash` is the SAME sha256 hex the gateway computes from the plaintext
 * key (see packages/api-gateway/src/lib/api-key.ts hashKey / this app's
 * lib/dashboard/api-key.ts hashKey — identical algorithm) and is already
 * stored in `gateway_api_keys.key_hash`, so this needs no plaintext key.
 *
 * apps/web does not declare `ioredis` as its own dependency (only
 * packages/api-gateway does) — it resolves here via bun workspace hoisting,
 * the same way it already does locally and in the CI deploy (the whole
 * monorepo is `bun install`'d per release, see .github/workflows/
 * deploy-production.yml). The dynamic import + try/catch keeps this
 * best-effort: if redis is unreachable, the DB write (the source of truth)
 * has still gone through — the cache just falls back to its 300s TTL, same
 * exposure window this whole fix is bounded by.
 */
type MinimalRedisClient = {
  del(key: string): Promise<number>;
};

const globalForGatewayCache = globalThis as unknown as {
  __aiagGatewayCacheRedis?: MinimalRedisClient | null;
};

async function getClient(): Promise<MinimalRedisClient | null> {
  if (globalForGatewayCache.__aiagGatewayCacheRedis !== undefined) {
    return globalForGatewayCache.__aiagGatewayCacheRedis;
  }
  const url = process.env.REDIS_URL;
  if (!url) {
    globalForGatewayCache.__aiagGatewayCacheRedis = null;
    return null;
  }
  try {
    const { default: IORedis } = await import('ioredis');
    globalForGatewayCache.__aiagGatewayCacheRedis = new IORedis(url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: true,
      lazyConnect: false,
      connectionName: 'web-gateway-cache-invalidate',
    }) as unknown as MinimalRedisClient;
  } catch (e) {
    console.warn('[gateway-cache] ioredis unavailable, cache invalidation skipped', e);
    globalForGatewayCache.__aiagGatewayCacheRedis = null;
  }
  return globalForGatewayCache.__aiagGatewayCacheRedis;
}

export async function invalidateApiKeyCache(keyHash: string): Promise<void> {
  const client = await getClient();
  if (!client) return;
  try {
    await client.del(`apikey:${keyHash}`);
  } catch (e) {
    // Non-fatal: worst case the cache serves the stale row for its 300s TTL —
    // the same bounded exposure the gateway's cache always had.
    console.warn('[gateway-cache] DEL failed (non-fatal, TTL bounds exposure)', {
      err: String(e),
    });
  }
}
