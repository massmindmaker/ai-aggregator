/**
 * POST /v1/video/generations — text→video / image→video.
 * Dispatches to upstream's `videoGeneration` adapter (typically Kie/Veo).
 *
 * Async, same submit+poll pattern as images.ts. Pricing uses per-image as
 * per-clip baseline (model_upstreams.price_per_image holds clip price for
 * video models in the current schema).
 */
import { Hono } from 'hono';
import { errors } from '../../lib/errors';
import { resolveModelWithOverride } from '../../routing/resolver';
import { pickUpstream, type Mode, type ApiKeyPolicies } from '../../routing/engine';
import { fetchUsdRubRate } from '../../lib/cbr';
import { calcCostRub, calcByokFeeRub } from '../../lib/pricing';
import { settleCharge } from '../../billing/settle';
import { logRequest } from '../../logging/stream';
import { getUpstream } from '../../upstreams/registry';
import type { AuthenticatedApiKey } from '../../middleware/auth-plan04';
import { logger } from '../../lib/logger';
import { NEUTRAL_MESSAGES } from '../../lib/client-errors';

export const video = new Hono();

type VideoBody = {
  model: string;
  prompt: string;
  duration_s?: number;
  aspect_ratio?: string;
  image_url?: string;
  aiag_mode?: Mode;
};

video.post('/generations', async (c) => {
  const bodyRaw = c.get('rawBody' as never) as VideoBody | undefined;
  const body: VideoBody = bodyRaw ?? ((await c.req.json()) as VideoBody);
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
  // image cost-metric reused — picks by per-image (==per-clip) price
  const upstream = pickUpstream(model.candidates, mode, policies, 'image');

  const start = Date.now();
  const adapter = getUpstream(upstream.provider);
  if (!adapter.videoGeneration) {
    throw errors.badRequest('Selected model does not support video generation');
  }

  let job = await adapter.videoGeneration({
    modelId: upstream.upstream_model_id,
    prompt: body.prompt,
    duration_s: body.duration_s,
    aspect_ratio: body.aspect_ratio,
    image_url: body.image_url,
    byokKey,
  });

  if (adapter.pollJob && (job.status === 'queued' || job.status === 'processing')) {
    const timeoutMs = Number(process.env.KIE_SYNC_POLL_MS || 60_000);
    const intervalMs = 5_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, intervalMs));
      job = await adapter.pollJob(job.job_id, 'video');
      if (job.status === 'completed' || job.status === 'failed') break;
    }
  }

  let totalRub = 0;
  let upstreamUsd = 0;
  if (byok) {
    totalRub = calcByokFeeRub();
  } else {
    const rate = await fetchUsdRubRate().catch(() => 92);
    upstreamUsd = upstream.price_per_image ?? 0.5; // per-clip baseline
    totalRub = calcCostRub({ upstreamUsd, rate, markup: upstream.markup });
  }
  if (job.status === 'completed') {
    await settleCharge({ orgId: key.org_id, requestId, totalRub });
  }

  void logRequest({
    requestId,
    orgId: key.org_id,
    apiKeyId: key.id,
    type: 'image', // video logs as 'image' until type enum extended
    modelSlug: body.model,
    upstreamId: upstream.upstream_id,
    modeApplied: mode,
    inputTokens: 0,
    outputTokens: 0,
    upstreamCostUsd: upstreamUsd,
    markup: upstream.markup,
    totalCostRub: totalRub,
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
      'video_job_failed'
    );
    return c.json(
      { error: { code: 'UPSTREAM_FAILED', message: NEUTRAL_MESSAGES.jobFailed } },
      502,
    );
  }
  if (job.status === 'completed') {
    const out = job.output;
    let url: string | undefined;
    if (typeof out === 'string') url = out;
    else if (out && typeof out === 'object') {
      const o = out as Record<string, unknown>;
      url = (o.url ?? o.video_url ?? o.output_url) as string | undefined;
    }
    return c.json({
      created: Math.floor(Date.now() / 1000),
      data: url ? [{ url }] : [{ raw: out }],
      job_id: job.job_id,
    });
  }
  // White-label: job.poll_url is the raw upstream URL — never forward it.
  return c.json(
    {
      job_id: job.job_id,
      status: job.status,
      hint: 'Video job did not complete within the sync poll window. Retry later.',
    },
    202,
  );
});
