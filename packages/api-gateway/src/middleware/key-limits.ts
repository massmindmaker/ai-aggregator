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
 *     🔴 Unit fix (2026-07-17, T2 rework): the accumulator (chat.ts's INCR)
 *     stores MICRO-credits (1 credit = 1000 micro = 1¢). The cap column
 *     (`cost_limit_monthly_rub`) used to be a genuine ruble figure — a
 *     ~1000-92000× mismatch that made the cap effectively dead
 *     (finmodel-build-spec §6/§8, T4). The FIRST fix bridged the gap at
 *     comparison time via the CBR rate helper (lib/cbr.ts) — but that put
 *     cbr.ru in the hot billing path: a cold cache + unreachable CBR (2 URLs
 *     x 3 retries) could block a billed request up to ~88s, with no
 *     fail-open and no budget (Opus review blocker 2). Tests never caught it
 *     because they pre-seed the CBR cache, so the network branch never ran
 *     in CI.
 *
 *     Current fix: migration 0061 converted the CAP itself, once, from ₽ to
 *     CREDITS (1 credit = 1 US cent — same unit the accumulator already
 *     uses). No FX conversion happens here anymore — the two sides are
 *     compared directly, zero network calls. The column/redis-key are NOT
 *     renamed — that is still T6.
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
import { MICRO_PER_CREDIT } from '../lib/pricing';
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
  // No network call: migration 0061 converted the cap column to CREDITS, the
  // same unit the accumulator already stores (MICRO-credits, 1000/credit).
  // Compare directly — see the file-header comment for why the CBR bridge
  // that used to live here was removed (Opus review blocker 2).
  if (key.cost_limit_monthly_rub) {
    const redis = makeRedis('ratelimit');
    const usedKey = monthlyCostCounterKey(key.id);
    const usedMicro = parseFloat((await redis.get(usedKey)) ?? '0');
    const usedCredits = usedMicro / MICRO_PER_CREDIT;
    if (usedCredits >= Number(key.cost_limit_monthly_rub)) {
      throw errors.paymentRequired('Monthly cost cap reached for this API key');
    }
  }

  await next();
};
