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
  const preferred = pickUpstream(model.candidates, mode, policies, 'image');
  // T3 failover — BYOK keeps the pre-T3 single-upstream passthrough.
  const ordered = byok ? [preferred] : orderCandidates(model.candidates, preferred);
  const failoverOpts: FailoverOpts = byok
    ? { useBreaker: false, wrapErrors: false }
    : {};

  // Fail closed, before spending on the upstream job: a missing price means
  // we cannot bill correctly. A numeric fallback here was the MED bug (Opus
  // review) — `?? 0.01` was written when the column was believed to be USD;
  // now that price_per_image is confirmed US CENTS, that fallback would have
  // billed ~100x too little instead of erroring. The price is required in
  // the DB (model_upstreams.price_per_image) — there is no safe guess.
  if (!byok && preferred.price_per_image == null) {
    throw errors.unavailable('Pricing not configured for this model — cannot bill safely');
  }

  // PREFLIGHT: 402 before submitting a paid upstream job (see settle.ts).
  if (!byok) await assertPositiveBalance(key.org_id);

  const start = Date.now();
  // Capability guard preserved for the preferred candidate exactly as pre-T3
  // (fail fast, before any failover attempt). Non-preferred candidates are
  // guarded inside the loop below.
  if (!getUpstream(preferred.provider).imageGeneration) {
    throw errors.badRequest('Selected model does not support image generation');
  }

  // T3: submit (+sync poll) runs inside the failover window — a submit error
  // moves to the next priority-ordered candidate. The poll always talks to
  // the SAME upstream's adapter: the job belongs to that provider.
  const { resp: job, usedUpstream } = await executeWithFailover(
    ordered,
    async (u) => {
      const a = getUpstream(u.provider);
      if (!a.imageGeneration) {
        throw errors.badRequest('Selected model does not support image generation');
      }
      let j = await a.imageGeneration({
        modelId: u.upstream_model_id,
        prompt: body.prompt,
        n: body.n,
        size: body.size,
        negative_prompt: body.negative_prompt,
        reference_image_url: body.reference_image_url,
        byokKey,
        egressProxyUrl: u.egress_proxy ?? undefined,
      });

      if (a.pollJob && (j.status === 'queued' || j.status === 'processing')) {
        const timeoutMs = Number(process.env.KIE_SYNC_POLL_MS || 60_000);
        const intervalMs = 3_000;
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, intervalMs));
          j = await a.pollJob(j.job_id, 'image', {
            egressProxyUrl: u.egress_proxy ?? undefined,
          });
          if (j.status === 'completed' || j.status === 'failed') break;
        }
      }
      return j;
    },
    failoverOpts,
  );

  // Settle: per-image pricing (T1-fix: whole MICRO-credits, no ₽/FX).
  // upstream.price_per_image is already US CENTS — see lib/pricing.ts.
  const n = Math.max(1, body.n ?? 1);
  let costCredits = 0; // MICRO-credits (1 credit = 1000 micro = 1¢)
  let upstreamCents = 0;
  if (byok) {
    costCredits = calcByokFeeCredits();
  } else {
    upstreamCents = usedUpstream.price_per_image! * n; // validated non-null above
    costCredits = calcCostCredits({ upstreamCents, markup: usedUpstream.markup });
  }
  // Only settle if completed (don't charge for failed jobs) and non-zero.
  if (job.status === 'completed' && costCredits > 0) {
    await settleCharge({
      orgId: key.org_id,
      settlementRequestId,
      traceRequestId: requestId,
      costCredits,
      metadata: { model_slug: body.model, image_count: n },
    });
  }

  // Cap counters — gated on the same `completed` condition as the charge
  // above, so a failed/queued job is not counted as spend.
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
    type: 'image',
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
