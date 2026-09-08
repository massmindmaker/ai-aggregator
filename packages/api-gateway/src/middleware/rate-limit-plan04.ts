/**
 * Plan 04 rate-limit middleware — sliding window ZSET (FIX H2).
 *
 * Three buckets:
 *   - per-key RPM             → rl:rpm:{api_key_id}
 *   - per-key batch RPM (path starts with /v1/batches) → rl:batch:{api_key_id}
 *   - per-org daily USD cap   → usd_day:{org_id}:{YYYY-MM-DD}
 *     (read-only check here; INCRBYFLOAT happens in settlement path.)
 */
import type { MiddlewareHandler } from 'hono';
import { makeRedis } from '../lib/redis';
import { errors } from '../lib/errors';
import type { AuthenticatedApiKey } from './auth-plan04';

const SLIDING_LUA = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, 0, now_ms - window_ms)
local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry_ms = (tonumber(oldest[2]) + window_ms) - now_ms
  return {0, math.max(1, math.ceil(retry_ms / 1000))}
end
redis.call('ZADD', key, now_ms, member)
redis.call('PEXPIRE', key, window_ms + 1000)
return {1, 0}
`;

type SlidingResult = [number, number];

async function checkRpm(k: AuthenticatedApiKey, isBatch: boolean, redis = makeRedis('ratelimit')): Promise<SlidingResult> {
  const now_ms = Date.now();

  const limit = isBatch ? k.batch_rpm_limit : k.rpm_limit;
  const key = isBatch ? `rl:batch:${k.id}` : `rl:rpm:${k.id}`;
  const member = `${now_ms}:${Math.random().toString(36).slice(2, 8)}`;

  const rawResult = (await redis.eval(
    SLIDING_LUA,
    1,
    key,
    String(limit),
    '60000',
    String(now_ms),
    member
  )) as SlidingResult;
  return rawResult;
}

/** Same normal RPM bucket, deliberately no legacy spending reads. */
export const rpmOnly: MiddlewareHandler = async (c, next) => {
  const key = c.get('apiKey' as never) as AuthenticatedApiKey | undefined;
  if (!key) throw errors.unauthorized();
  let result: SlidingResult;
  try {
    result = await checkRpm(key, false);
    if (!Array.isArray(result) || result.length !== 2 ||
        ![0, 1].includes(result[0]) || !Number.isSafeInteger(result[1]) || result[1] < 0) throw new Error();
  } catch {
    c.header('Retry-After', '2');
    throw errors.unavailable('Request state unavailable');
  }
  const [ok, retry] = result;
  if (!ok) {
    const retryAfter = retry || 60;
    c.header('Retry-After', String(retryAfter));
    throw errors.rateLimited(retryAfter);
  }
  await next();
};

export const rateLimit: MiddlewareHandler = async (c, next) => {
  const k = c.get('apiKey' as never) as AuthenticatedApiKey | undefined;
  if (!k) return next(); // auth middleware didn't populate — skip (defensive)

  const redis = makeRedis('ratelimit');
  const [ok, retry] = await checkRpm(k, c.req.path.startsWith('/v1/batches'), redis);
  if (!ok) {
    const retryAfter = retry || 60;
    c.header('Retry-After', String(retryAfter));
    throw errors.rateLimited(retryAfter);
  }

  // Daily USD cap read-only check (INCR happens in settlement path)
  if (k.daily_usd_cap) {
    const today = new Date().toISOString().slice(0, 10);
    const usedKey = `usd_day:${k.org_id}:${today}`;
    const used = parseFloat((await redis.get(usedKey)) ?? '0');
    if (used >= Number(k.daily_usd_cap)) {
      const secUntilMidnight =
        86400 - Math.floor((Date.now() / 1000) % 86400);
      c.header('Retry-After', String(secUntilMidnight));
      throw errors.rateLimited(secUntilMidnight, 'Daily USD cap reached');
    }
  }
  await next();
};
