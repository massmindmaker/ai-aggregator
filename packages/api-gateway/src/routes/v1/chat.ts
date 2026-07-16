/**
 * POST /v1/chat/completions — OpenAI-compatible. Stub upstream (mock) until
 * Plan 05 real adapters ship.
 */
import { Hono } from 'hono';
import { makeRedis } from '../../lib/redis';
import { errors } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { resolveModelWithOverride } from '../../routing/resolver';
import {
  pickUpstream,
  type Mode,
  type ApiKeyPolicies,
} from '../../routing/engine';
import {
  checkSessionBudget,
  accumulateSessionCost,
} from '../../routing/policies';
import { calcCostCredits, calcByokFeeCredits } from '../../lib/pricing';
import { settleCharge } from '../../billing/settle';
import {
  BILLING_HEADERS,
  formatUsdMicroHeader,
} from '../../lib/billing-headers';
import { logRequest } from '../../logging/stream';
import { streamSseAndSettle } from '../../streaming/sse';
import { getUpstream } from '../../upstreams/registry';
import type { AuthenticatedApiKey } from '../../middleware/auth-plan04';
import { monthlyCostCounterKey } from '../../middleware/key-limits';

export const chat = new Hono();

type ChatBody = {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  stream?: boolean;
  aiag_mode?: Mode;
};

chat.post('/completions', async (c) => {
  const bodyRaw = c.get('rawBody' as never) as ChatBody | undefined;
  const body: ChatBody = bodyRaw ?? ((await c.req.json()) as ChatBody);
  const key = c.get('apiKey' as never) as AuthenticatedApiKey;
  const requestId = c.get('requestId' as never) as string;
  const byokKey = c.req.header('x-upstream-key');
  const byok = Boolean(byokKey);
  const policies = (key.policies ?? {}) as ApiKeyPolicies;

  if (!body?.model || !Array.isArray(body.messages)) {
    throw errors.badRequest('model + messages[] required');
  }

  // FIX H4.4: forbid_streaming_prompts
  if (body.stream && policies.forbid_streaming_prompts) {
    throw errors.badRequest(
      'Streaming forbidden by policy (forbid_streaming_prompts)'
    );
  }

  const model = await resolveModelWithOverride(body.model);
  const mode: Mode = (body.aiag_mode ?? policies.default_mode ?? 'auto') as Mode;
  const upstream = pickUpstream(model.candidates, mode, policies, 'chat');

  // FIX H4.3: per_session_budget_cap_rub
  const sessionId = c.req.header('x-aiag-session-id');
  const sessionCap = policies.per_session_budget_cap_rub;
  if (sessionCap && sessionId) {
    await checkSessionBudget({ apiKeyId: key.id, sessionId, capRub: sessionCap });
  }

  const start = Date.now();
  const upstreamAdapter = getUpstream(upstream.provider);

  if (body.stream) {
    const iter = upstreamAdapter.chatStream!({
      modelId: upstream.upstream_model_id,
      messages: body.messages,
      stream: true,
      byokKey,
    });
    return streamSseAndSettle(c, iter, {
      upstream,
      model: { slug: model.slug, type: model.type },
      key: { id: key.id, org_id: key.org_id },
      requestId,
      byok,
    });
  }

  const resp = await upstreamAdapter.chat({
    modelId: upstream.upstream_model_id,
    messages: body.messages,
    stream: false,
    byokKey,
  });

  const usage = resp.usage;
  // T1 (2026-07-16): org buckets are whole USD-cent credits now — no ₽, no FX.
  let costCredits = 0;
  let upstreamUsd = 0;
  // D-1 (USD-native): computed DIRECTLY from costCredits (no rate division —
  // there is no rate anymore). Still feeds the USD-micro headers the TMA
  // agent-worker reads (HDR_CHARGED_USD_MICRO / HDR_UPSTREAM_COST_USD_MICRO).
  let chargedUsd = 0;
  let upstreamCostUsd = 0;
  if (byok) {
    costCredits = calcByokFeeCredits();
    // BYOK pays a fixed credit fee, no upstream cost we bear. (TMA BYOK runs
    // are isExternal → the worker ignores these headers, but keep them coherent.)
    chargedUsd = costCredits / 100;
    upstreamCostUsd = 0;
    await settleCharge({
      orgId: key.org_id,
      requestId,
      costCredits,
      metadata: { model_slug: body.model },
    });
  } else {
    upstreamUsd =
      (usage.prompt_tokens / 1000) * upstream.price_per_1k_input +
      (usage.completion_tokens / 1000) * upstream.price_per_1k_output;
    costCredits = calcCostCredits({
      upstreamUsd,
      markup: upstream.markup,
      cachedInputTokens: usage.cached_input_tokens,
      totalInputTokens: usage.prompt_tokens,
    });
    // USD-native equivalents: upstream cost in USD is just upstreamUsd; the
    // charged USD is costCredits / 100 (markup + caching already folded into
    // costCredits, and the credit-rounding is the SAME rounding TMA bills on).
    upstreamCostUsd = upstreamUsd;
    chargedUsd = costCredits / 100;
    await settleCharge({
      orgId: key.org_id,
      requestId,
      costCredits,
      metadata: {
        model_slug: body.model,
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
      },
    });
  }

  // FIX H2.3: daily USD cap INCR (unaffected by T1 — already USD, not ₽/credits)
  if (!byok && key.daily_usd_cap) {
    try {
      const redis = makeRedis('ratelimit');
      const today = new Date().toISOString().slice(0, 10);
      const usedKey = `usd_day:${key.org_id}:${today}`;
      await redis.incrbyfloat(usedKey, upstreamUsd);
      await redis.expireat(
        usedKey,
        Math.floor(new Date().setUTCHours(24, 0, 0, 0) / 1000)
      );
    } catch (e) {
      logger.warn({ err: String(e) }, 'daily_usd_incr_fail');
    }
  }

  // Security review 2026-07 (#3): cost_limit_monthly_rub INCR. Same shape as
  // the daily USD cap above but keyed per-key (not per-org) — it must reflect
  // what the caller was actually CHARGED (costCredits), not our upstream cost,
  // so BYOK's fixed fee counts too. key-limits.ts middleware reads this
  // counter read-only on the NEXT request; this is the only place it's
  // incremented.
  // ⚠️ T1 scope note: the field/redis-key are still named "..._rub" and the
  // policy value (`key.cost_limit_monthly_rub`) is still ₽-denominated — this
  // counter now accumulates CREDITS against a ₽ threshold (T1 did not rename
  // this; caps are T4 per finmodel-build-spec §8). Credits ≈ ₽/0.92 at the
  // reference rate, so the cap now trips slightly earlier than a ₽ figure
  // would suggest — not a silent no-op, but the naming is misleading until T4
  // renames the field/threshold to credits.
  if (key.cost_limit_monthly_rub) {
    try {
      const redis = makeRedis('ratelimit');
      const usedKey = monthlyCostCounterKey(key.id);
      await redis.incrbyfloat(usedKey, costCredits);
      // ~32 days: comfortably outlives the current calendar month regardless
      // of when in the month the first request landed; the counter key
      // itself rolls over to a fresh YYYY-MM string next month anyway.
      await redis.expire(usedKey, 32 * 24 * 3600);
    } catch (e) {
      logger.warn({ err: String(e) }, 'monthly_cost_incr_fail');
    }
  }

  // ⚠️ Same T1 scope note as above: policies.per_session_budget_cap_rub /
  // accumulateSessionCost's `deltaRub` param are still ₽-named; fed credits
  // here. T4 follow-up.
  if (sessionCap && sessionId) {
    await accumulateSessionCost({
      apiKeyId: key.id,
      sessionId,
      deltaRub: costCredits,
      ttlSec: 86400,
    });
  }

  void logRequest({
    requestId,
    orgId: key.org_id,
    apiKeyId: key.id,
    type: 'chat',
    modelSlug: body.model,
    upstreamId: upstream.upstream_id,
    modeRequested: body.aiag_mode ?? null,
    modeApplied: mode,
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    upstreamCostUsd: upstreamUsd,
    markup: upstream.markup,
    totalCostCredits: costCredits,
    statusCode: 200,
    latencyMs: Date.now() - start,
    byok,
  });

  c.header('X-AIAG-Mode-Applied', mode);
  // White-label: X-AIAG-Upstream (raw provider name, e.g. "openrouter") used
  // to be echoed here. Removed — it had zero internal consumers (agent-worker,
  // billing, tests all key off upstream_id/model slug, not this header) and
  // directly violated SECURITY.md's white-label rule. Provider name stays in
  // server-side logs only (see logRequest below).
  // T1: the legacy ₽ pair (X-AIAG-Charged-Rub / X-AIAG-Upstream-Cost-Rub) is
  // no longer emitted — it required the FX `rate` this migration removes from
  // the hot path, and grep confirms it had zero real consumers (only this
  // gateway's own contract test asserted the header NAMES, not any reader).
  // The BILLING_HEADERS constants stay defined for now (harmless, still
  // covered by that contract test) but nothing populates them anymore.
  // D-1: the USD-micro pair the TMA worker actually reads.
  c.header(BILLING_HEADERS.CHARGED_USD_MICRO, formatUsdMicroHeader(chargedUsd));
  c.header(
    BILLING_HEADERS.UPSTREAM_COST_USD_MICRO,
    formatUsdMicroHeader(upstreamCostUsd),
  );
  return c.json(resp);
});
