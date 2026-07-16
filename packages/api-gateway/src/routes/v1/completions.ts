/** POST /v1/completions — legacy OpenAI completions (stub upstream). */
import { Hono } from 'hono';
import { errors } from '../../lib/errors';
import { resolveModelWithOverride } from '../../routing/resolver';
import { pickUpstream, type Mode, type ApiKeyPolicies } from '../../routing/engine';
import { calcCostCredits, calcByokFeeCredits } from '../../lib/pricing';
import { settleCharge } from '../../billing/settle';
import { logRequest } from '../../logging/stream';
import { getUpstream } from '../../upstreams/registry';
import type { AuthenticatedApiKey } from '../../middleware/auth-plan04';

export const completions = new Hono();

type CompletionBody = {
  model: string;
  prompt: string | string[];
  aiag_mode?: Mode;
};

completions.post('/', async (c) => {
  const bodyRaw = c.get('rawBody' as never) as CompletionBody | undefined;
  const body: CompletionBody = bodyRaw ?? ((await c.req.json()) as CompletionBody);
  const key = c.get('apiKey' as never) as AuthenticatedApiKey;
  const requestId = c.get('requestId' as never) as string;
  const byok = Boolean(c.req.header('x-upstream-key'));
  const policies = (key.policies ?? {}) as ApiKeyPolicies;

  if (!body?.model || body.prompt == null) {
    throw errors.badRequest('model + prompt required');
  }

  const model = await resolveModelWithOverride(body.model);
  const mode: Mode = (body.aiag_mode ?? policies.default_mode ?? 'auto') as Mode;
  const upstream = pickUpstream(model.candidates, mode, policies, 'chat');
  const start = Date.now();

  const promptText = Array.isArray(body.prompt) ? body.prompt.join('\n') : body.prompt;
  const upstreamAdapter = getUpstream(upstream.provider);
  const resp = await upstreamAdapter.chat({
    modelId: upstream.upstream_model_id,
    messages: [{ role: 'user', content: promptText }],
  });

  // T1-fix: whole MICRO-credits, no ₽/FX. price_per_1k_input/output are
  // already US CENTS — see lib/pricing.ts.
  let costCredits = 0; // MICRO-credits (1 credit = 1000 micro = 1¢)
  let upstreamCents = 0;
  if (byok) {
    costCredits = calcByokFeeCredits();
  } else {
    upstreamCents =
      (resp.usage.prompt_tokens / 1000) * upstream.price_per_1k_input +
      (resp.usage.completion_tokens / 1000) * upstream.price_per_1k_output;
    costCredits = calcCostCredits({
      upstreamCents,
      markup: upstream.markup,
      cachedInputTokens: resp.usage.cached_input_tokens,
      totalInputTokens: resp.usage.prompt_tokens,
    });
  }
  if (costCredits > 0) {
    await settleCharge({
      orgId: key.org_id,
      requestId,
      costCredits,
      metadata: {
        model_slug: body.model,
        input_tokens: resp.usage.prompt_tokens,
        output_tokens: resp.usage.completion_tokens,
      },
    });
  }

  void logRequest({
    requestId,
    orgId: key.org_id,
    apiKeyId: key.id,
    type: 'completion',
    modelSlug: body.model,
    upstreamId: upstream.upstream_id,
    modeApplied: mode,
    inputTokens: resp.usage.prompt_tokens,
    outputTokens: resp.usage.completion_tokens,
    upstreamCostUsd: upstreamCents / 100,
    markup: upstream.markup,
    totalCostCredits: costCredits,
    statusCode: 200,
    latencyMs: Date.now() - start,
    byok,
  });

  c.header('X-AIAG-Mode-Applied', mode);
  return c.json({
    id: resp.id,
    object: 'text_completion',
    created: resp.created,
    model: body.model,
    choices: [
      {
        text: resp.choices[0]?.message.content ?? '',
        index: 0,
        logprobs: null,
        finish_reason: resp.choices[0]?.finish_reason,
      },
    ],
    usage: resp.usage,
  });
});
