/**
 * App-level rate limiter for money/spam-sensitive TMA routes (R2 readiness).
 *
 * Until now the only documented protection was an nginx comment — nothing enforced
 * inside the app. This is a lightweight INCR+EXPIRE limiter on the EXISTING Redis
 * (ioredis is already a dependency; same REDIS_URL the run-enqueue path uses).
 *
 * Contract:
 *   - Key: `rl:{route}:{id}` where id = the verified tg_user_id (or, for public
 *     unauthenticated routes, a client IP fallback).
 *   - First hit in the window sets EXPIRE; subsequent hits INCR. Over the limit → blocked.
 *   - FAIL-OPEN: if Redis is unreachable we DO NOT block (the limiter is spam defence,
 *     not a money/auth gate — settleRun + balance guard remain the source of truth).
 *     But every fail-open is LOGGED so a silently-down limiter is visible.
 *
 * This is a guard placed at the very TOP of a route, before any heavy work. It never
 * touches the money/settle path.
 */

export interface RateLimitResult {
  /** true when the caller is WITHIN the limit (allowed). */
  allowed: boolean;
  /** seconds until the window resets (best-effort; 0 when unknown / fail-open). */
  retryAfter: number;
}

/**
 * Per-route window defaults. window = seconds, max = allowed hits per window.
 * Conservative spam ceilings, not throughput tuning.
 */
export const RATE_LIMITS = {
  run: { max: 20, window: 60 },
  topup: { max: 5, window: 60 },
  transfer: { max: 5, window: 60 },
  'transfer-offer': { max: 10, window: 60 },
  membership: { max: 5, window: 60 },
} as const;

export type RateLimitRoute = keyof typeof RATE_LIMITS;

/**
 * Check + consume one token for `{route}:{id}`.
 *
 * @param route  one of RATE_LIMITS keys (the namespace + its window/max).
 * @param id     the verified tg_user_id, or an IP fallback for public routes.
 */
export async function checkRateLimit(
  route: RateLimitRoute,
  id: string,
): Promise<RateLimitResult> {
  const cfg = RATE_LIMITS[route];
  const key = `rl:${route}:${id}`;

  try {
    // Lazy import keeps ioredis out of any Edge bundle analysis (node runtime only).
    const { default: Redis } = await import('ioredis');
    const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
    const redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      // Don't let a dead Redis hang the request — fail fast → fail-open.
      connectTimeout: 1000,
      lazyConnect: false,
    });

    try {
      const count = await redis.incr(key);
      if (count === 1) {
        // First hit in this window — start the TTL.
        await redis.expire(key, cfg.window);
      }
      if (count > cfg.max) {
        const ttl = await redis.ttl(key);
        return { allowed: false, retryAfter: ttl > 0 ? ttl : cfg.window };
      }
      return { allowed: true, retryAfter: 0 };
    } finally {
      // quit() flushes; on a broken connection fall back to disconnect.
      try {
        await redis.quit();
      } catch {
        redis.disconnect();
      }
    }
  } catch (e) {
    // FAIL-OPEN — never block legitimate users on a Redis blip, but make it visible.
    console.error(`[rate-limit] fail-open for ${key}:`, e);
    return { allowed: true, retryAfter: 0 };
  }
}

/** Best-effort client IP for public (unauthenticated) routes that have no tg_user_id. */
export function clientIp(req: { headers: { get(name: string): string | null } }): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}
