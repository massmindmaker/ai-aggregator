/**
 * POST /v1/chat/completions — OpenAI-compatible. Stub upstream (mock) until
 * Plan 05 real adapters ship.
 */
import { Hono } from 'hono';
import { errors } from '../../lib/errors';
import { resolveModelWithOverride } from '../../routing/resolver';
import {
  pickUpstream,
  type Mode,
  type ApiKeyPolicies,
} from '../../routing/engine';
import { checkSessionBudget } from '../../routing/policies';
import {
  executeWithFailover,
  orderCandidates,
  type FailoverOpts,
} from '../../routing/failover';
import { calcCostCredits, calcByokFeeCredits, MICRO_PER_USD } from '../../lib/pricing';
import { settleCharge, assertPositiveBalance } from '../../billing/settle';
import { incrementSpendCounters } from '../../billing/spend-counters';
import {
  BILLING_HEADERS,
  formatUsdMicroHeader,
} from '../../lib/billing-headers';
import { logRequest } from '../../logging/stream';
import { streamSseAndSettle } from '../../streaming/sse';
import { getUpstream } from '../../upstreams/registry';
import type { AuthenticatedApiKey } from '../../middleware/auth-plan04';

export const chat = new Hono();

/**
 * Continue an async iterable whose FIRST chunk was already pulled inside the
 * failover window: replay that chunk, then delegate the rest. Mid-stream
 * errors stay handled by sse.ts (they cannot be retried — headers/body are
 * already flowing to the client).
 */
function resumeAfterFirst<T>(iter: AsyncIterator<T>, first: IteratorResult<T>): AsyncIterable<T> {
  async function* gen(): AsyncGenerator<T> {
    if (!first.done) yield first.value;
    for (;;) {
      const next = await iter.next();
      if (next.done) return;
      yield next.value;
    }
  }
  return gen();
}

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
  const preferred = pickUpstream(model.candidates, mode, policies, 'chat');
  // T3 failover: preferred first, remaining candidates in resolver (priority)
  // order. BYOK keeps the exact pre-T3 single-upstream passthrough — the
  // caller's key is provider-specific, failing over would send it elsewhere.
  const ordered = byok ? [preferred] : orderCandidates(model.candidates, preferred);
  const failoverOpts: FailoverOpts = byok
    ? { useBreaker: false, wrapErrors: false }
    : {};

  // FIX H4.3: per_session_budget_cap_rub
  const sessionId = c.req.header('x-aiag-session-id');
  const sessionCap = policies.per_session_budget_cap_rub;
  if (sessionCap && sessionId) {
    await checkSessionBudget({ apiKeyId: key.id, sessionId, capRub: sessionCap });
  }

  // PREFLIGHT: 402 BEFORE the upstream is called. Previously the order was
  // upstream → settle → 402, so a zero-balance org still got a full answer
  // (and on the stream path the settle error was swallowed in sse.ts, making
  // the answer free). BYOK is skipped — the caller pays their own provider.
  if (!byok) await assertPositiveBalance(key.org_id);

  const start = Date.now();

  if (body.stream) {
    // Pull the FIRST chunk inside the failover window so connect/first-token
    // failures move to the next candidate before any header is sent.
    const { resp: primed, usedUpstream } = await executeWithFailover(
      ordered,
      async (u) => {
        const iter = getUpstream(u.provider).chatStream!({
          modelId: u.upstream_model_id,
          messages: body.messages,
          stream: true,
          byokKey,
          egressProxyUrl: u.egress_proxy ?? undefined,
        });
        const iterator = iter[Symbol.asyncIterator]();
        const first = await iterator.next();
        return { iter: iterator, first };
      },
      failoverOpts,
    );
    return streamSseAndSettle(c, resumeAfterFirst(primed.iter, primed.first), {
      upstream: usedUpstream,
      model: { slug: model.slug, type: model.type },
      // Full key (not just id/org_id): sse.ts now bumps the SAME cap counters
      // the non-stream branch does — `stream:true` used to bypass all three.
      key,
      sessionId,
      requestId,
      byok,
    });
  }

  const { resp, usedUpstream } = await executeWithFailover(
    ordered,
    (u) =>
      getUpstream(u.provider).chat({
        modelId: u.upstream_model_id,
        messages: body.messages,
        stream: false,
        byokKey,
        egressProxyUrl: u.egress_proxy ?? undefined,
      }),
    failoverOpts,
  );

  const usage = resp.usage;
  // T1-fix (2026-07-16 rework): org buckets are whole MICRO-credits now — no
  // ₽, no FX. `upstream.price_per_1k_input/output` are already US CENTS (=
  // USD × 100, see COMMENT ON COLUMN / 0059) — the local var below is named
  // `upstreamCents` (not `upstreamUsd`, the original bug: reading a cents
  // column as USD produced a 100× overcharge — see lib/pricing.ts).
  let costCredits = 0; // MICRO-credits (1 credit = 1000 micro = 1¢)
  let upstreamCents = 0;
  // D-1 (USD-native): chargedUsd/upstreamCostUsd feed the USD-micro headers
  // the TMA agent-worker reads (HDR_CHARGED_USD_MICRO /
  // HDR_UPSTREAM_COST_USD_MICRO) — MICRO_PER_USD converts costCredits (micro)
  // back to real USD: costCredits / 100_000 = (upstreamCents/100) × markup ×
  // batchDiscount × caching, i.e. real upstream-USD × markup.
  let chargedUsd = 0;
  let upstreamCostUsd = 0;
  if (byok) {
    costCredits = calcByokFeeCredits();
    // BYOK pays a fixed credit fee, no upstream cost we bear. (TMA BYOK runs
    // are isExternal → the worker ignores these headers, but keep them coherent.)
    chargedUsd = costCredits / MICRO_PER_USD;
    upstreamCostUsd = 0;
    if (costCredits > 0) {
      await settleCharge({
        orgId: key.org_id,
        requestId,
        costCredits,
        metadata: { model_slug: body.model },
      });
    }
  } else {
    upstreamCents =
      (usage.prompt_tokens / 1000) * usedUpstream.price_per_1k_input +
      (usage.completion_tokens / 1000) * usedUpstream.price_per_1k_output;
    costCredits = calcCostCredits({
      upstreamCents,
      markup: usedUpstream.markup,
      cachedInputTokens: usage.cached_input_tokens,
      totalInputTokens: usage.prompt_tokens,
    });
    // USD-native equivalents: upstream cost in USD is upstreamCents / 100
    // (this is what fixes the D-0 header — it used to hold cents under the
    // name "USD"); the charged USD is costCredits (micro-credits) / 100_000.
    upstreamCostUsd = upstreamCents / 100;
    chargedUsd = costCredits / MICRO_PER_USD;
    if (costCredits > 0) {
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
  }

  // Cap counters (daily USD / monthly cost / per-session budget). These three
  // INCRs used to live inline HERE and only here — every other billing path
  // (stream, completions, embeddings, images, video, audio) settled real
  // money without moving them, so a capped key was bypassable by switching
  // endpoint or setting `stream:true`. Now a shared helper called from all of
  // them; thresholds/402 logic are untouched (rate-limit-plan04.ts,
  // key-limits.ts, checkSessionBudget still own those).
  await incrementSpendCounters({
    key,
    byok,
    upstreamCents,
    costCredits,
    sessionId,
  });

  void logRequest({
    requestId,
    orgId: key.org_id,
    apiKeyId: key.id,
    type: 'chat',
    modelSlug: body.model,
    upstreamId: usedUpstream.upstream_id,
    modeRequested: body.aiag_mode ?? null,
    modeApplied: mode,
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    upstreamCostUsd,
    markup: usedUpstream.markup,
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
