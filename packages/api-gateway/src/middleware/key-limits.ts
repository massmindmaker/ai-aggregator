/**
 * Plan 04 — per-key limit enforcement (security review 2026-07, #3).
 *
 * `cost_limit_monthly_rub` and `model_whitelist` are written by
 * apps/web/.../dashboard/keys/route.ts at key creation but were never read
 * anywhere in the gateway — pure decoration. This middleware enforces both:
 *
 *   - model_whitelist: if the key restricts which models it may call, a
 *     request for any other model is rejected BEFORE routing/upstream ever
 *     see it (does not touch routing/engine.ts or resolver.ts).
 *   - cost_limit_monthly_rub: a per-key monthly ₽ spend cap. Same shape as
 *     the pre-existing `daily_usd_cap` check in rate-limit-plan04.ts — this
 *     is a READ-ONLY guard; the counter is INCR'd in chat.ts's settlement
 *     block (the same route that already owns the equivalent usd_day INCR —
 *     see FIX H2.3 there). Mirrors that existing, deliberately narrow scope
 *     rather than inventing a new one: today usd_day is chat-only too.
 *
 * ru_residency_only is NOT enforced here — see SECURITY-TODO note in
 * docs/specs (tracked debt): it would require the upstream registry to carry
 * a reliable RU-residency flag per candidate and a routing-level filter,
 * which is out of scope for a read-only pre-check middleware and risks
 * touching routing/engine.ts (explicitly out of bounds for this fix).
 *
 * Mounted globally on /v1/* in server.ts, after requireApiKey so `apiKey` is
 * already in context (defensive no-op if it somehow isn't — same pattern as
 * rateLimit).
 */
import type { Context, Next } from 'hono';
import { makeRedis } from '../lib/redis';
import { errors } from '../lib/errors';
import type { AuthenticatedApiKey } from './auth-plan04';

/** Exported so chat.ts's settlement INCR uses the exact same key shape. */
export function monthlyCostCounterKey(apiKeyId: string, when: Date = new Date()): string {
  const month = when.toISOString().slice(0, 7); // YYYY-MM
  return `cost_month:${apiKeyId}:${month}`;
}

export const keyLimits = async (c: Context, next: Next) => {
  const key = c.get('apiKey' as never) as AuthenticatedApiKey | undefined;
  if (!key) return next(); // auth middleware didn't populate — skip (defensive)

  // ---- model_whitelist ---------------------------------------------------
  const whitelist = key.model_whitelist;
  if (whitelist && whitelist.length > 0) {
    let modelSlug: string | undefined;
    try {
      // Clone so downstream handlers (chat.ts etc.) can still read the body.
      const cloned = c.req.raw.clone();
      const body = (await cloned.json()) as { model?: unknown };
      if (typeof body?.model === 'string') modelSlug = body.model;
    } catch {
      // Non-JSON / no body — nothing to whitelist-check here.
    }
    if (modelSlug && !whitelist.includes(modelSlug)) {
      throw errors.forbidden(`Model "${modelSlug}" is not in this key's model_whitelist`);
    }
  }

  // ---- cost_limit_monthly_rub (read-only; INCR happens at settlement) ---
  if (key.cost_limit_monthly_rub) {
    const redis = makeRedis('ratelimit');
    const usedKey = monthlyCostCounterKey(key.id);
    const used = parseFloat((await redis.get(usedKey)) ?? '0');
    if (used >= Number(key.cost_limit_monthly_rub)) {
      throw errors.paymentRequired('Monthly cost cap reached for this API key');
    }
  }

  await next();
};
