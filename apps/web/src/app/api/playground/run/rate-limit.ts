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
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
};

// INCR + "set TTL only if this is the first hit on the key today" as one
// atomic server-side step. Plain `INCR` then `if (countAfter === 1) EXPIRE`
// is two round-trips — a crash/redeploy between them leaves the key without
// a TTL, so it never expires: the counter sticks past midnight and keeps
// counting against yesterday's quota (a guest gets stuck rate-limited past
// reset — annoying, not a money leak, since it only ever makes the gate
// stricter). Still worth closing since it's one Lua script away.
const INCR_WITH_TTL_IF_NEW = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`;

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
    const client = new IORedis(url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: true,
      lazyConnect: false,
      connectionName: 'web-playground-rate-limit',
    });
    // Required: ioredis emits 'error' on the client for connection failures
    // (ECONNREFUSED, reset, etc). Without a listener Node treats it as an
    // unhandled error event and CRASHES THE PROCESS — on this endpoint that
    // would take down `web` instead of the intended fail-closed 403/429.
    // The incr()/expire()/decr() call sites already try/catch and fail
    // closed, so this handler only needs to stop the crash + log server-side
    // (no infra detail reaches the client response).
    client.on('error', (err) => {
      console.warn('[playground] redis client error (non-fatal, failing closed)', err);
    });
    globalForPlaygroundRedis.__aiagPlaygroundRedis = client as unknown as MinimalRedisClient;
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
  if (!client) {
    // No Redis configured/reachable at all — distinct server-side signal
    // from "quota exhausted" below, even though both currently produce the
    // same user-facing 429 (we don't want to leak infra state to the
    // client). A spike in this specific log line means Redis is down, not
    // that guests are legitimately hitting their daily limit.
    console.warn('[playground] redis unavailable, failing closed (no client)');
    return { allowed: false };
  }
  const key = dayKey(ip);
  try {
    const countAfter = (await client.eval(
      INCR_WITH_TTL_IF_NEW,
      1,
      key,
      secondsUntilEndOfDayUtc()
    )) as number;
    // countAfter includes this attempt; feed the pre-attempt count through
    // the same pure decision `guard.ts` uses, so there is exactly one place
    // that defines "allowed".
    const usedBefore = countAfter - 1;
    return { allowed: playgroundAllowed({ ip, used: usedBefore, limit }) };
  } catch (e) {
    // Redis reachable at connect time but this call failed (timeout, script
    // error, connection dropped mid-request) — same fail-closed outcome as
    // "no client" above, logged separately so an operator can tell "Redis
    // never connected" apart from "Redis flaked on this one call".
    console.warn('[playground] redis eval(incr+ttl) failed, failing closed', e);
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
