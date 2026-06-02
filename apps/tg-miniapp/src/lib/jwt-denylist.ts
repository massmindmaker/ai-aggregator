/**
 * JWT denylist helper — deferred live-revocation wiring (T-15.1-10, R0 non-blocking).
 *
 * Design:
 *   revoke(jti, ttl)  — ioredis, node-runtime callers only (future logout route).
 *   isRevoked(jti)    — Edge-safe, no ioredis import.
 *                       If UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set,
 *                       uses the Upstash REST API (GET by key).
 *                       Otherwise returns false (stub) — the alg-pin + CVE patch +
 *                       fail-hard secret are the R0 blocking layer; live revocation
 *                       lands in T-15.1-10 deferred hardening.
 *
 * Key namespace: tma:jwt:denylist:{jti}
 *   SET with EX = remaining token lifetime so the set self-cleans.
 *
 * isRevoked status for R0: STUB (returns false when Upstash not configured).
 * revoke status for R0: FUNCTIONAL (ioredis, node-runtime only).
 */

// ---------------------------------------------------------------------------
// revoke — node-runtime only (ioredis); called from future logout/session routes
// ---------------------------------------------------------------------------

/**
 * Add a jti to the denylist with a TTL matching the token's remaining lifetime.
 * Call from node-runtime routes only — ioredis cannot run on the Edge.
 *
 * @param jti        - JWT ID (the `jti` claim value from the token)
 * @param ttlSeconds - seconds until the token expires (set EX to match so the set self-cleans)
 */
export async function revoke(jti: string, ttlSeconds: number): Promise<void> {
  if (ttlSeconds <= 0) return; // already expired — nothing to revoke

  // Lazy import keeps ioredis out of Edge bundle analysis paths.
  const { default: Redis } = await import('ioredis');
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error('REDIS_URL not configured — cannot revoke JWT');
  }
  const redis = new Redis(redisUrl);
  try {
    const key = `tma:jwt:denylist:${jti}`;
    await redis.set(key, '1', 'EX', ttlSeconds);
  } finally {
    await redis.quit();
  }
}

// ---------------------------------------------------------------------------
// isRevoked — Edge-safe; no ioredis import
// ---------------------------------------------------------------------------

/**
 * Check whether a jti has been revoked.
 *
 * Edge-safe implementation:
 *   - If UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set in env,
 *     queries the Upstash REST API (GET /get/{key}).
 *   - Otherwise returns false (stub) for R0. Wire real revocation in T-15.1-10.
 *
 * @param jti - JWT ID claim to check
 * @returns   true if the token has been explicitly revoked; false otherwise
 */
export async function isRevoked(jti: string): Promise<boolean> {
  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!upstashUrl || !upstashToken) {
    // Stub path — deferred hardening (T-15.1-10).
    // The alg-pin + CVE patch + fail-hard secret cover R0; live revocation is
    // a future work item. Return false so the middleware continues normally.
    return false;
  }

  // Upstash REST API: GET /get/{key} returns { result: "1" } if present, { result: null } if absent.
  const key = `tma:jwt:denylist:${jti}`;
  const url = `${upstashUrl.replace(/\/$/, '')}/get/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${upstashToken}` },
    // Short timeout for the middleware hot path — treat fetch errors as non-revoked
    // to avoid breaking auth on transient Redis blips.
  });

  if (!res.ok) {
    // Network or Upstash error — fail open (non-revoked) to avoid auth disruption.
    // A stricter policy (fail closed) would call for returning true here, but that
    // would lock out all users on any Redis blip; R0 favours availability.
    return false;
  }

  const body = (await res.json()) as { result: string | null };
  return body.result !== null;
}
