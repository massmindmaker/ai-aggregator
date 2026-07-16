/**
 * POST /v1/images/generations — OpenAI-compatible image generation.
 * Dispatches to the resolved upstream's `imageGeneration` adapter (typically Kie).
 *
 * Async upstreams (Kie) are submitted, then synchronously polled up to
 * KIE_SYNC_POLL_MS (default 60s). If still pending, returns
 * { status:"queued", job_id, poll_url } so callers can poll later. If
 * completed, returns OpenAI-shaped { data: [{ url }] }.
 *
 * GET  /v1/images/jobs/:id  — poll status for a previously queued job.
 *   Required query: provider=<kie>&family=<image|video|suno>
 */
import { Hono } from 'hono';
import { errors } from '../../lib/errors';
import { resolveModelWithOverride } from '../../routing/resolver';
import { pickUpstream, type Mode, type ApiKeyPolicies } from '../../routing/engine';
import { calcCostCredits, calcByokFeeCredits } from '../../lib/pricing';
import { settleCharge } from '../../billing/settle';
import { logRequest } from '../../logging/stream';
import { getUpstream } from '../../upstreams/registry';
import type { AuthenticatedApiKey } from '../../middleware/auth-plan04';
import { logger } from '../../lib/logger';
import { NEUTRAL_MESSAGES } from '../../lib/client-errors';

export const images = new Hono();

type ImagesBody = {
  model: string;
  prompt: string;
  n?: number;
  size?: string;
  negative_prompt?: string;
  reference_image_url?: string;
  aiag_mode?: Mode;
};

images.post('/generations', async (c) => {
  const bodyRaw = c.get('rawBody' as never) as ImagesBody | undefined;
  const body: ImagesBody = bodyRaw ?? ((await c.req.json()) as ImagesBody);
  const key = c.get('apiKey' as never) as AuthenticatedApiKey;
  const requestId = c.get('requestId' as never) as string;
  const byokKey = c.req.header('x-upstream-key');
  const byok = Boolean(byokKey);
  const policies = (key.policies ?? {}) as ApiKeyPolicies;

  if (!body?.model || !body?.prompt) {
    throw errors.badRequest('model + prompt required');
  }

  const model = await resolveModelWithOverride(body.model);
  const mode: Mode = (body.aiag_mode ?? policies.default_mode ?? 'auto') as Mode;
  const upstream = pickUpstream(model.candidates, mode, policies, 'image');

  const start = Date.now();
  const adapter = getUpstream(upstream.provider);
  if (!adapter.imageGeneration) {
    throw errors.badRequest('Selected model does not support image generation');
  }

  // Submit
  let job = await adapter.imageGeneration({
    modelId: upstream.upstream_model_id,
    prompt: body.prompt,
    n: body.n,
    size: body.size,
    negative_prompt: body.negative_prompt,
    reference_image_url: body.reference_image_url,
    byokKey,
  });

  // Synchronously poll if adapter has pollJob
  if (adapter.pollJob && (job.status === 'queued' || job.status === 'processing')) {
    const timeoutMs = Number(process.env.KIE_SYNC_POLL_MS || 60_000);
    const intervalMs = 3_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, intervalMs));
      job = await adapter.pollJob(job.job_id, 'image');
      if (job.status === 'completed' || job.status === 'failed') break;
    }
  }

  // Settle: per-image pricing (T1-fix: whole MICRO-credits, no ₽/FX).
  // upstream.price_per_image is already US CENTS — see lib/pricing.ts.
  const n = Math.max(1, body.n ?? 1);
  let costCredits = 0; // MICRO-credits (1 credit = 1000 micro = 1¢)
  let upstreamCents = 0;
  if (byok) {
    costCredits = calcByokFeeCredits();
  } else {
    upstreamCents = (upstream.price_per_image ?? 0.01) * n;
    costCredits = calcCostCredits({ upstreamCents, markup: upstream.markup });
  }
  // Only settle if completed (don't charge for failed jobs) and non-zero.
  if (job.status === 'completed' && costCredits > 0) {
    await settleCharge({
      orgId: key.org_id,
      requestId,
      costCredits,
      metadata: { model_slug: body.model, image_count: n },
    });
  }

  void logRequest({
    requestId,
    orgId: key.org_id,
    apiKeyId: key.id,
    type: 'image',
    modelSlug: body.model,
    upstreamId: upstream.upstream_id,
    modeApplied: mode,
    inputTokens: 0,
    outputTokens: 0,
    upstreamCostUsd: upstreamCents / 100,
    markup: upstream.markup,
    totalCostCredits: costCredits,
    statusCode: job.status === 'failed' ? 502 : 200,
    latencyMs: Date.now() - start,
    byok,
  });

  c.header('X-AIAG-Mode-Applied', mode);
  c.header('X-AIAG-Job-Id', job.job_id);
  c.header('X-AIAG-Job-Status', job.status);

  if (job.status === 'failed') {
    // White-label: job.error carries the raw upstream failure text (Kie's
    // failMsg/failCode) — log it server-side, never forward it to the client.
    logger.warn(
      { requestId, upstreamId: upstream.upstream_id, jobId: job.job_id, upstreamError: job.error },
      'image_job_failed'
    );
    return c.json(
      { error: { code: 'UPSTREAM_FAILED', message: NEUTRAL_MESSAGES.jobFailed } },
      502,
    );
  }
  if (job.status === 'completed') {
    // Normalize output → OpenAI image shape
    const out = job.output;
    let urls: string[] = [];
    if (typeof out === 'string') urls = [out];
    else if (Array.isArray(out)) urls = (out as unknown[]).filter((x): x is string => typeof x === 'string');
    else if (out && typeof out === 'object') {
      const o = out as Record<string, unknown>;
      const u = (o.url ?? o.image_url ?? o.output_url) as string | undefined;
      if (u) urls = [u];
    }
    return c.json({
      created: Math.floor(Date.now() / 1000),
      data: urls.length ? urls.map((u) => ({ url: u })) : [{ raw: out }],
      job_id: job.job_id,
    });
  }
  // Still queued/processing. White-label: job.poll_url is the raw upstream
  // URL (e.g. api.kie.ai) — never forward it, there is no client-facing poll
  // endpoint yet, so only the job_id (opaque, brand-neutral) goes out.
  return c.json(
    {
      job_id: job.job_id,
      status: job.status,
      hint: 'Job did not complete within the sync poll window. Retry later.',
    },
    202,
  );
});
