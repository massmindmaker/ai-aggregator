/**
 * Redis-backed daily hit counter for the public playground endpoint.
 *
 * Replaces the old in-memory `Map<ip, {count, resetAt}>` — that counter
 * reset on every pm2 restart, silently re-granting the free quota to any
 * abuser. Redis with a TTL to end-of-day (UTC) survives restarts.
 *
 * Reuses the lazy-import + globalThis-cached-client pattern already used by
 * `apps/web/src/lib/dashboard/gateway-cache.ts` (same package, ioredis
 * resolves via bun workspace hoisting — apps/web does not declare it as its
 * own dependency).
 *
 * 🔴 Fails CLOSED, not open: this endpoint spends real money on the system
 * key (`playground-system-key`) against a live upstream. If Redis is
 * unreachable we cannot prove the caller is under quota, so we reject
 * rather than silently going unlimited — the same posture as the
 * `require-balance` gateway middleware (fail-closed 402 on missing state).
 */
import { playgroundAllowed } from './guard';

type MinimalRedisClient = {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  decr(key: string): Promise<number>;
};

const globalForPlaygroundRedis = globalThis as unknown as {
  __aiagPlaygroundRedis?: MinimalRedisClient | null;
};

async function getClient(): Promise<MinimalRedisClient | null> {
  if (globalForPlaygroundRedis.__aiagPlaygroundRedis !== undefined) {
    return globalForPlaygroundRedis.__aiagPlaygroundRedis;
  }
  const url = process.env.REDIS_URL;
  if (!url) {
    globalForPlaygroundRedis.__aiagPlaygroundRedis = null;
    return null;
  }
  try {
    const { default: IORedis } = await import('ioredis');
    globalForPlaygroundRedis.__aiagPlaygroundRedis = new IORedis(url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: true,
      lazyConnect: false,
      connectionName: 'web-playground-rate-limit',
    }) as unknown as MinimalRedisClient;
  } catch (e) {
    console.warn('[playground] ioredis unavailable, rate limit fails closed', e);
    globalForPlaygroundRedis.__aiagPlaygroundRedis = null;
  }
  return globalForPlaygroundRedis.__aiagPlaygroundRedis;
}

function secondsUntilEndOfDayUtc(): number {
  const now = new Date();
  const endOfDay = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0
  );
  return Math.max(1, Math.ceil((endOfDay - now.getTime()) / 1000));
}

function dayKey(ip: string): string {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  return `playground:rl:${ip}:${day}`;
}

/**
 * Atomically consumes one hit against the IP's daily quota.
 * Returns `allowed: false` if the quota is exhausted OR if Redis could not
 * be reached (fail-closed).
 */
export async function consumePlaygroundHit(
  ip: string,
  limit: number
): Promise<{ allowed: boolean }> {
  const client = await getClient();
  if (!client) return { allowed: false };
  const key = dayKey(ip);
  try {
    const countAfter = await client.incr(key);
    if (countAfter === 1) {
      await client.expire(key, secondsUntilEndOfDayUtc());
    }
    // countAfter includes this attempt; feed the pre-attempt count through
    // the same pure decision `guard.ts` uses, so there is exactly one place
    // that defines "allowed".
    const usedBefore = countAfter - 1;
    return { allowed: playgroundAllowed({ ip, used: usedBefore, limit }) };
  } catch (e) {
    console.warn('[playground] redis incr failed, failing closed', e);
    return { allowed: false };
  }
}

/**
 * Gives back a hit that was consumed but the request ultimately failed on
 * our side (gateway unreachable / gateway error) — mirrors the old
 * `decrementRateLimit` behaviour so a gateway outage doesn't burn a
 * visitor's free quota. Best-effort: a failed refund just means the visitor
 * loses one of their five free tries, which is not a money-safety issue.
 */
export async function refundPlaygroundHit(ip: string): Promise<void> {
  const client = await getClient();
  if (!client) return;
  try {
    await client.decr(dayKey(ip));
  } catch (e) {
    console.warn('[playground] redis decr (refund) failed, non-fatal', e);
  }
}
