/**
 * JWT denylist — live revocation of issued tokens (steal / logout).
 *
 * Storage: Upstash Redis REST (`@upstash/redis`) — edge-compatible (HTTP, no TCP
 * socket), so the same client works in both `middleware.ts` (Edge) and node-runtime
 * routes (logout). One store, one source of truth for both `revoke` and `isRevoked`.
 *
 * Env (set both or neither):
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 *
 * Soft degradation — if env is NOT configured:
 *   - isRevoked() returns false (never blocks a legitimate login) + one warn log.
 *   - revoke()  is a no-op + one warn log.
 *   The alg-pin + CVE patch + fail-hard secret remain the primary auth layer; live
 *   revocation simply stays off until the founder provisions Upstash.
 *
 * Key namespace: tma:jwt:denylist:{jti}
 *   SET with EX = remaining token lifetime so the entry self-cleans on expiry.
 */

import { Redis } from '@upstash/redis';

const KEY_PREFIX = 'tma:jwt:denylist:';

// One warn per process per method, so a missing-env deployment does not spam logs.
let warnedRevoke = false;
let warnedIsRevoked = false;

/**
 * Build an Upstash REST client from env, or null if env is absent.
 * Returns null (rather than throwing) so callers can degrade softly.
 */
function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

/**
 * Add a jti to the denylist with a TTL matching the token's remaining lifetime.
 * Edge- and node-safe (Upstash REST). No-op when the token is already expired or
 * when the denylist store is not configured.
 *
 * @param jti        - JWT ID (the `jti` claim value)
 * @param ttlSeconds - seconds until the token's own exp (EX so the entry self-cleans)
 */
export async function revoke(jti: string, ttlSeconds: number): Promise<void> {
  if (!jti) return;
  if (ttlSeconds <= 0) return; // already expired — nothing to revoke

  const redis = getRedis();
  if (!redis) {
    if (!warnedRevoke) {
      console.warn(
        '[jwt-denylist] UPSTASH_REDIS_REST_URL/TOKEN not set — revoke() is a no-op (live revocation disabled).',
      );
      warnedRevoke = true;
    }
    return;
  }

  await redis.set(`${KEY_PREFIX}${jti}`, '1', { ex: Math.ceil(ttlSeconds) });
}

/**
 * Check whether a jti has been revoked.
 * Edge-safe. Fail-open: a missing store or a transient network error returns false
 * (allow) rather than locking out legitimate users — only an explicit denylist hit
 * returns true.
 *
 * @param jti - JWT ID claim to check
 * @returns   true only if the token was explicitly revoked; false otherwise
 */
export async function isRevoked(jti: string): Promise<boolean> {
  if (!jti) return false;

  const redis = getRedis();
  if (!redis) {
    if (!warnedIsRevoked) {
      console.warn(
        '[jwt-denylist] UPSTASH_REDIS_REST_URL/TOKEN not set — isRevoked() returns false (live revocation disabled).',
      );
      warnedIsRevoked = true;
    }
    return false;
  }

  try {
    const exists = await redis.exists(`${KEY_PREFIX}${jti}`);
    return exists === 1;
  } catch (err) {
    // Fail-open on a transient Upstash/network blip — never block legitimate auth.
    console.warn('[jwt-denylist] isRevoked check failed, failing open (treated as not revoked):', err);
    return false;
  }
}
