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
  // Trace id: echoed, logged, PII-correlated. NEVER a money key.
  const requestId = c.get('requestId' as never) as string;
  // Server-minted `stl_<uuid>` — the only id legacy settlement sees.
  const settlementRequestId = c.get('settlementRequestId' as never) as string;
  const byokKey = c.req.header('x-upstream-key');
  const byok = Boolean(byokKey);
  const policies = (key.policies ?? {}) as ApiKeyPolicies;

  if (!body?.model || !body?.prompt) {
    throw errors.badRequest('model + prompt required');
  }

  const model = await resolveModelWithOverride(body.model);
  const mode: Mode = (body.aiag_mode ?? policies.default_mode ?? 'auto') as Mode;
  // image cost-metric reused — picks by per-image (==per-clip) price
  const preferred = pickUpstream(model.candidates, mode, policies, 'image');
  // T3 failover — BYOK keeps the pre-T3 single-upstream passthrough.
  const ordered = byok ? [preferred] : orderCandidates(model.candidates, preferred);
  const failoverOpts: FailoverOpts = byok
    ? { useBreaker: false, wrapErrors: false }
    : {};

  // Fail closed, before spending on the upstream job: a missing price means
  // we cannot bill correctly. A numeric fallback here was the MED bug (Opus
  // review) — `?? 0.5` was written when the column was believed to be USD;
  // now that price_per_image is confirmed US CENTS, that fallback would have
  // billed ~100x too little instead of erroring. The price is required in
  // the DB (model_upstreams.price_per_image) — there is no safe guess.
  if (!byok && preferred.price_per_image == null) {
    throw errors.unavailable('Pricing not configured for this model — cannot bill safely');
  }

  // PREFLIGHT: 402 before submitting a paid upstream job (see settle.ts).
  if (!byok) await assertPositiveBalance(key.org_id);

  const start = Date.now();
  // Capability guard preserved for the preferred candidate exactly as pre-T3.
  if (!getUpstream(preferred.provider).videoGeneration) {
    throw errors.badRequest('Selected model does not support video generation');
  }

  // T3: submit (+sync poll) inside the failover window; the poll always talks
  // to the SAME upstream's adapter — the job belongs to that provider.
  const { resp: job, usedUpstream } = await executeWithFailover(
    ordered,
    async (u) => {
      const a = getUpstream(u.provider);
      if (!a.videoGeneration) {
        throw errors.badRequest('Selected model does not support video generation');
      }
      let j = await a.videoGeneration({
        modelId: u.upstream_model_id,
        prompt: body.prompt,
        duration_s: body.duration_s,
        aspect_ratio: body.aspect_ratio,
        image_url: body.image_url,
        byokKey,
        egressProxyUrl: u.egress_proxy ?? undefined,
      });

      if (a.pollJob && (j.status === 'queued' || j.status === 'processing')) {
        const timeoutMs = Number(process.env.KIE_SYNC_POLL_MS || 60_000);
        const intervalMs = 5_000;
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, intervalMs));
          j = await a.pollJob(j.job_id, 'video', {
            egressProxyUrl: u.egress_proxy ?? undefined,
          });
          if (j.status === 'completed' || j.status === 'failed') break;
        }
      }
      return j;
    },
    failoverOpts,
  );

  // T1-fix: whole MICRO-credits, no ₽/FX. upstream.price_per_image is
  // already US CENTS — see lib/pricing.ts.
  let costCredits = 0; // MICRO-credits (1 credit = 1000 micro = 1¢)
  let upstreamCents = 0;
  if (byok) {
    costCredits = calcByokFeeCredits();
  } else {
    upstreamCents = usedUpstream.price_per_image!; // per-clip baseline; validated non-null above
    costCredits = calcCostCredits({ upstreamCents, markup: usedUpstream.markup });
  }
  if (job.status === 'completed' && costCredits > 0) {
    await settleCharge({
      orgId: key.org_id,
      settlementRequestId,
      traceRequestId: requestId,
      costCredits,
      metadata: { model_slug: body.model },
    });
  }

  // Cap counters — gated on the same `completed` condition as the charge.
  if (job.status === 'completed') {
    await incrementSpendCounters({
      key,
      byok,
      upstreamCents,
      costCredits,
      sessionId: c.req.header('x-aiag-session-id'),
    });
  }

  void logRequest({
    requestId,
    orgId: key.org_id,
    apiKeyId: key.id,
    type: 'image', // video logs as 'image' until type enum extended
    modelSlug: body.model,
    upstreamId: usedUpstream.upstream_id,
    modeApplied: mode,
    inputTokens: 0,
    outputTokens: 0,
    upstreamCostUsd: upstreamCents / 100,
    markup: usedUpstream.markup,
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
      { requestId, upstreamId: usedUpstream.upstream_id, jobId: job.job_id, upstreamError: job.error },
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
