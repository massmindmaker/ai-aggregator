/**
 * Shared spend-counter increment — the single write-point for the three
 * counters that back the ENFORCED per-key/per-org caps.
 *
 *   - usd_day:{org_id}:{YYYY-MM-DD}        daily USD cap   (read: rate-limit-plan04.ts)
 *   - cost_month:{api_key_id}:{YYYY-MM}    monthly cost cap (read: key-limits.ts)
 *   - session:{api_key_id}:{sid}:cost_rub  per-session budget (read: routing/policies.ts)
 *
 * WHY THIS EXISTS (the bug it closes): the increments used to live inline in
 * chat.ts's NON-STREAM branch only. Every other billing path — chat STREAM
 * (sse.ts), completions, embeddings, images, video, audio — called
 * settleCharge (debited real money) but never moved these counters. Since the
 * cap *reads* are global (`/v1/*` middlewares) but the *writes* were chat-only,
 * a key with a daily/monthly cap was bypassable by simply switching endpoint or
 * turning on `stream:true`. This helper is now called from ALL billing routes
 * after settlement so the counter grows everywhere.
 *
 * Scope guard: this does NOT change any threshold or 402 logic — those stay in
 * rate-limit-plan04.ts, key-limits.ts and checkSessionBudget. It only moves
 * WHERE the counter is bumped. Key shapes, keyspace, units and TTLs are lifted
 * verbatim from the original chat.ts blocks.
 *
 * Best-effort: each counter write is wrapped so a Redis blip cannot 500 a
 * request that was already charged + served. (chat.ts already did this for the
 * daily/monthly writes; the session write is now wrapped too — same intent, and
 * it runs strictly AFTER settlement, so swallowing a counter error never loses
 * a charge.)
 */
import { makeRedis } from '../lib/redis';
import { logger } from '../lib/logger';
import { monthlyCostCounterKey } from '../middleware/key-limits';
import { accumulateSessionCost } from '../routing/policies';
import type { AuthenticatedApiKey } from '../middleware/auth-plan04';
import type { ApiKeyPolicies } from '../routing/engine';

export type SpendCounterArgs = {
  /** Only the fields the caps key off. Any billing route's `key` satisfies this. */
  key: Pick<
    AuthenticatedApiKey,
    'id' | 'org_id' | 'daily_usd_cap' | 'cost_limit_monthly_rub' | 'policies'
  >;
  /** BYOK bears no upstream cost we track → the daily-USD accumulator is skipped
   *  (matches chat.ts). The monthly/session counters still count the BYOK fee. */
  byok: boolean;
  /** Already-weighted upstream cost for THIS call, in US CENTS. Feeds the daily
   *  USD accumulator as real USD (cents ÷ 100), matching daily_usd_cap's unit. */
  upstreamCents: number;
  /** Amount actually charged, in MICRO-credits (1 credit = 1000 micro = 1¢).
   *  Feeds the monthly + session accumulators (same unit key-limits.ts reads). */
  costCredits: number;
  /** `x-aiag-session-id` header value, if the caller set one. */
  sessionId?: string | null;
};

export async function incrementSpendCounters(args: SpendCounterArgs): Promise<void> {
  const { key, byok, upstreamCents, costCredits, sessionId } = args;

  // ---- daily USD cap (per-org) ------------------------------------------
  // Verbatim from chat.ts FIX H2.3: accumulate REAL USD (cents ÷ 100) so it
  // compares directly with the real-USD daily_usd_cap. BYOK skipped (no
  // upstream cost we bear).
  if (!byok && key.daily_usd_cap) {
    try {
      const redis = makeRedis('ratelimit');
      const today = new Date().toISOString().slice(0, 10);
      const usedKey = `usd_day:${key.org_id}:${today}`;
      await redis.incrbyfloat(usedKey, upstreamCents / 100);
      await redis.expireat(
        usedKey,
        Math.floor(new Date().setUTCHours(24, 0, 0, 0) / 1000)
      );
    } catch (e) {
      logger.warn({ err: String(e) }, 'daily_usd_incr_fail');
    }
  }

  // ---- monthly cost cap (per-key) ---------------------------------------
  // Reflects what the caller was CHARGED (costCredits, MICRO-credits) so the
  // BYOK fixed fee counts too — same unit key-limits.ts compares against
  // (migration 0061 made the cap column CREDITS). Key shape via the shared
  // monthlyCostCounterKey helper so read/write stay in lock-step.
  if (key.cost_limit_monthly_rub) {
    try {
      const redis = makeRedis('ratelimit');
      const usedKey = monthlyCostCounterKey(key.id);
      await redis.incrbyfloat(usedKey, costCredits);
      await redis.expire(usedKey, 32 * 24 * 3600);
    } catch (e) {
      logger.warn({ err: String(e) }, 'monthly_cost_incr_fail');
    }
  }

  // ---- per-session budget (per-key + session) ---------------------------
  // sessionCap is a policy; sessionId is the request header. accumulateSessionCost
  // keys on `session:{key}:{sid}:cost_rub` (routing/policies.ts) — same key
  // checkSessionBudget reads. deltaRub is fed MICRO-credits (widened-unit note
  // lives in chat.ts / policies.ts; unchanged here).
  const sessionCap = (key.policies as ApiKeyPolicies | undefined)
    ?.per_session_budget_cap_rub;
  if (sessionCap && sessionId) {
    try {
      await accumulateSessionCost({
        apiKeyId: key.id,
        sessionId,
        deltaRub: costCredits,
        ttlSec: 86400,
      });
    } catch (e) {
      logger.warn({ err: String(e) }, 'session_cost_incr_fail');
    }
  }
}
