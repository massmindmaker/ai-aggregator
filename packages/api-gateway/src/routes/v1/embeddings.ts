/** POST /v1/embeddings — OpenAI-compatible. Stub. */
import { Hono } from 'hono';
import { errors } from '../../lib/errors';
import { resolveModelWithOverride } from '../../routing/resolver';
import { pickUpstream, type Mode, type ApiKeyPolicies } from '../../routing/engine';
import { calcCostCredits, calcByokFeeCredits } from '../../lib/pricing';
import { settleCharge } from '../../billing/settle';
import { logRequest } from '../../logging/stream';
import { mockUpstream } from '../../upstreams/mock';
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
  const upstream = pickUpstream(model.candidates, mode, policies, 'embedding');
  const start = Date.now();

  const resp = await mockUpstream.embeddings!({
    modelId: upstream.upstream_model_id,
    input: body.input,
  });

  // T1: whole USD-cent credits, no ₽/FX
  let costCredits = 0;
  let upstreamUsd = 0;
  if (byok) {
    costCredits = calcByokFeeCredits();
  } else {
    upstreamUsd = (resp.usage.prompt_tokens / 1000) * upstream.price_per_1k_input;
    costCredits = calcCostCredits({ upstreamUsd, markup: upstream.markup });
  }
  await settleCharge({
    orgId: key.org_id,
    requestId,
    costCredits,
    metadata: { model_slug: body.model, input_tokens: resp.usage.prompt_tokens },
  });

  void logRequest({
    requestId,
    orgId: key.org_id,
    apiKeyId: key.id,
    type: 'embedding',
    modelSlug: body.model,
    upstreamId: upstream.upstream_id,
    modeApplied: mode,
    inputTokens: resp.usage.prompt_tokens,
    outputTokens: 0,
    upstreamCostUsd: upstreamUsd,
    markup: upstream.markup,
    totalCostCredits: costCredits,
    statusCode: 200,
    latencyMs: Date.now() - start,
    byok,
  });

  return c.json(resp);
});
