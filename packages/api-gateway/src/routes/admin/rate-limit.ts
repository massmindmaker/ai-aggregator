/**
 * In-process fixed-window rate limit for /api/admin/* — brute-force guard
 * for the fail-closed AIAG_ADMIN_KEY endpoints (proxy/test also fires
 * outbound requests). Single shared bucket across admin subapps; keyed by
 * client IP (x-forwarded-for first). AIAG_ADMIN_RATE_LIMIT=off disables.
 */
import type { MiddlewareHandler } from 'hono';
import { errors } from '../../lib/errors';

const WINDOW_MS = 60_000;
const DEFAULT_MAX = 30;

type Bucket = { count: number; windowStart: number };
const buckets = new Map<string, Bucket>();

export function __resetAdminRateLimitForTests(): void {
  buckets.clear();
}

function clientKey(c: { req: { header: (n: string) => string | undefined } }): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
}

export function adminRateLimit(): MiddlewareHandler {
  return async (c, next) => {
    if (process.env.AIAG_ADMIN_RATE_LIMIT === 'off') return next();
    const max = Number(process.env.AIAG_ADMIN_RATE_LIMIT) || DEFAULT_MAX;
    const key = clientKey(c);
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now - b.windowStart >= WINDOW_MS) {
      b = { count: 0, windowStart: now };
      buckets.set(key, b);
    }
    b.count += 1;
    if (b.count > max) throw errors.rateLimited(60);
    await next();
  };
}
