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
import { fetchUsdRubRate } from '../../lib/cbr';
import { calcCostRub, calcByokFeeRub } from '../../lib/pricing';
import { settleCharge } from '../../billing/settle';
import {
  BILLING_HEADERS,
  formatRubHeader,
  formatUsdMicroHeader,
} from '../../lib/billing-headers';
import { logRequest } from '../../logging/stream';
import { streamSseAndSettle } from '../../streaming/sse';
import { getUpstream } from '../../upstreams/registry';
import type { AuthenticatedApiKey } from '../../middleware/auth-plan04';

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
  let totalRub = 0;
  let upstreamUsd = 0;
  // D-0: authoritative upstream cost in ₽ (upstream_usd × rate, NO markup), so
  // the caller can compute realized margin = charged − upstreamCost. For BYOK
  // there is no upstream cost we bear (the user paid their provider) → 0.
  let upstreamCostRub = 0;
  // D-1 (USD-native): the SAME authoritative figures in USD, for the TMA worker's
  // micro-USD headers. Derived from the ₽ figures via the SAME `rate` (computed
  // once, below) so chargedUsd × rate == totalRub exactly — no second cost calc.
  let chargedUsd = 0;
  let upstreamCostUsd = 0;
  if (byok) {
    totalRub = calcByokFeeRub();
    // BYOK pays a fixed ₽ fee, no upstream cost we bear. Convert the fee to USD
    // via the live rate so the USD-micro header is populated too. (TMA BYOK runs
    // are isExternal → the worker ignores these headers, but keep them coherent.)
    const rate = await fetchUsdRubRate().catch(() => 92);
    chargedUsd = rate > 0 ? totalRub / rate : 0;
    upstreamCostUsd = 0;
    await settleCharge({ orgId: key.org_id, requestId, totalRub });
  } else {
    const rate = await fetchUsdRubRate().catch(() => 92);
    upstreamUsd =
      (usage.prompt_tokens / 1000) * upstream.price_per_1k_input +
      (usage.completion_tokens / 1000) * upstream.price_per_1k_output;
    upstreamCostRub = upstreamUsd * rate;
    totalRub = calcCostRub({
      upstreamUsd,
      rate,
      markup: upstream.markup,
      cachedInputTokens: usage.cached_input_tokens,
      totalInputTokens: usage.prompt_tokens,
    });
    // USD-native equivalents off the SAME rate: upstream cost in USD is just
    // upstreamUsd; the charged USD is totalRub / rate (markup + caching already
    // folded into totalRub). One division, same rate → no drift vs the ₽ figures.
    upstreamCostUsd = upstreamUsd;
    chargedUsd = rate > 0 ? totalRub / rate : 0;
    await settleCharge({ orgId: key.org_id, requestId, totalRub });
  }

  // FIX H2.3: daily USD cap INCR
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

  if (sessionCap && sessionId) {
    await accumulateSessionCost({
      apiKeyId: key.id,
      sessionId,
      deltaRub: totalRub,
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
    totalCostRub: totalRub,
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
  // D-0: authoritative billing figures (₽), keyed to gateway_request_id via the
  // echoed X-Request-Id. Brand-neutral (numbers only). The agent-worker reads
  // these to bill off the REAL charge/cost instead of its local estimate.
  c.header(BILLING_HEADERS.CHARGED_RUB, formatRubHeader(totalRub));
  c.header(BILLING_HEADERS.UPSTREAM_COST_RUB, formatRubHeader(upstreamCostRub));
  // D-1: the USD-micro pair the TMA worker actually reads (USD-cent credits).
  // ₽ pair kept above for the web aggregator / earnings; USD pair added for TMA.
  c.header(BILLING_HEADERS.CHARGED_USD_MICRO, formatUsdMicroHeader(chargedUsd));
  c.header(
    BILLING_HEADERS.UPSTREAM_COST_USD_MICRO,
    formatUsdMicroHeader(upstreamCostUsd),
  );
  return c.json(resp);
});
