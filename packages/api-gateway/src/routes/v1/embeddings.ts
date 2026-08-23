/** POST /v1/embeddings — OpenAI-compatible. Stub. */
import { Hono } from 'hono';
import { errors } from '../../lib/errors';
import { resolveModelWithOverride } from '../../routing/resolver';
import { pickUpstream, type Mode, type ApiKeyPolicies } from '../../routing/engine';
import {
  executeWithFailover,
  orderCandidates,
  type FailoverOpts,
} from '../../routing/failover';
import { calcCostCredits, calcByokFeeCredits } from '../../lib/pricing';
import { settleCharge, assertPositiveBalance } from '../../billing/settle';
import { incrementSpendCounters } from '../../billing/spend-counters';
import { logRequest } from '../../logging/stream';
import { getUpstream } from '../../upstreams/registry';
import type { AuthenticatedApiKey } from '../../middleware/auth-plan04';

export const embeddings = new Hono();

type EmbeddingsBody = {
  model: string;
  input: string | string[];
  aiag_mode?: Mode;
};

embeddings.post('/', async (c) => {
  const bodyRaw = c.get('rawBody' as never) as EmbeddingsBody | undefined;
  const body: EmbeddingsBody = bodyRaw ?? ((await c.req.json()) as EmbeddingsBody);
  const key = c.get('apiKey' as never) as AuthenticatedApiKey;
  const requestId = c.get('requestId' as never) as string;
  const byok = Boolean(c.req.header('x-upstream-key'));
  const policies = (key.policies ?? {}) as ApiKeyPolicies;

  if (!body?.model || body.input == null) {
    throw errors.badRequest('model + input required');
  }

  const model = await resolveModelWithOverride(body.model);
  const mode: Mode = (body.aiag_mode ?? policies.default_mode ?? 'auto') as Mode;
  const preferred = pickUpstream(model.candidates, mode, policies, 'embedding');
  // T3 failover — BYOK keeps the pre-T3 single-upstream passthrough.
  const ordered = byok ? [preferred] : orderCandidates(model.candidates, preferred);
  const failoverOpts: FailoverOpts = byok
    ? { useBreaker: false, wrapErrors: false }
    : {};

  // PREFLIGHT: 402 before spending on the upstream (see billing/settle.ts).
  if (!byok) await assertPositiveBalance(key.org_id);

  const start = Date.now();

  // 🔴 This route used to call the mock adapter UNCONDITIONALLY — it returned
  // sine-function-generated 8-dimension fake vectors and then billed the
  // caller for them (a paid-for fabrication; registry.ts had already closed
  // the same footgun for chat). Now it dispatches to the resolved provider's
  // real adapter, exactly like chat.ts/completions.ts do. The fake is
  // reachable only via AIAG_FORCE_MOCK=1 (CI), which getUpstream owns.
  // ⚠️ Do not re-introduce the literal mock import here — a test asserts this
  // file never names it again (see __tests__/billing-preflight.test.ts).
  const { resp, usedUpstream } = await executeWithFailover(ordered, (upstream) => {
    const adapter = getUpstream(upstream.provider);
    if (!adapter.embeddings) {
      // White-label: never name the upstream. Same neutral shape images.ts uses
      // for an unsupported capability — an honest error beats a billable fake.
      throw errors.badRequest('Selected model does not support embeddings');
    }
    return adapter.embeddings({
      modelId: upstream.upstream_model_id,
      input: body.input,
      byokKey: c.req.header('x-upstream-key'),
      egressProxyUrl: upstream.egress_proxy ?? undefined,
    });
  }, failoverOpts);

  // T1-fix: whole MICRO-credits, no ₽/FX. price_per_1k_input is already US
  // CENTS — see lib/pricing.ts. This is exactly the route Opus flagged
  // (HIGH-1): under the old whole-credit floor, cheap embeddings rounded UP
  // to a full cent (~1390× overcharge); micro-credits fix that at the root.
  let costCredits = 0; // MICRO-credits (1 credit = 1000 micro = 1¢)
  let upstreamCents = 0;
  if (byok) {
    costCredits = calcByokFeeCredits();
  } else {
    upstreamCents = (resp.usage.prompt_tokens / 1000) * usedUpstream.price_per_1k_input;
    costCredits = calcCostCredits({ upstreamCents, markup: usedUpstream.markup });
  }
  if (costCredits > 0) {
    await settleCharge({
      orgId: key.org_id,
      requestId,
      costCredits,
      metadata: { model_slug: body.model, input_tokens: resp.usage.prompt_tokens },
    });
  }

  // Cap counters — this route settled money without moving them before.
  await incrementSpendCounters({
    key,
    byok,
    upstreamCents,
    costCredits,
    sessionId: c.req.header('x-aiag-session-id'),
  });

  void logRequest({
    requestId,
    orgId: key.org_id,
    apiKeyId: key.id,
    type: 'embedding',
    modelSlug: body.model,
    upstreamId: usedUpstream.upstream_id,
    modeApplied: mode,
    inputTokens: resp.usage.prompt_tokens,
    outputTokens: 0,
    upstreamCostUsd: upstreamCents / 100,
    markup: usedUpstream.markup,
    totalCostCredits: costCredits,
    statusCode: 200,
    latencyMs: Date.now() - start,
    byok,
  });

  return c.json(resp);
});
