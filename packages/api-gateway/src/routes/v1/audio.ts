/**
 * POST /v1/audio/speech         — TTS / music generation (Suno via Kie).
 * POST /v1/audio/transcriptions — STT (not yet wired to a real upstream).
 *
 * Speech follows the submit+poll pattern (Suno is async ~30-60s).
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

export const audio = new Hono();

type SpeechBody = {
  model: string;
  input: string;
  voice?: string;
  format?: string;
  aiag_mode?: Mode;
};

audio.post('/speech', async (c) => {
  const bodyRaw = c.get('rawBody' as never) as SpeechBody | undefined;
  const body: SpeechBody = bodyRaw ?? ((await c.req.json()) as SpeechBody);
  const key = c.get('apiKey' as never) as AuthenticatedApiKey;
  const requestId = c.get('requestId' as never) as string;
  const byokKey = c.req.header('x-upstream-key');
  const byok = Boolean(byokKey);
  const policies = (key.policies ?? {}) as ApiKeyPolicies;

  if (!body?.model || !body?.input) {
    throw errors.badRequest('model + input required');
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
  // review) — `?? 0.05` was written when the column was believed to be USD;
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
  if (!getUpstream(preferred.provider).audioSpeech) {
    throw errors.badRequest('Selected model does not support audio speech');
  }

  // T3: submit (+sync poll) inside the failover window; the poll always talks
  // to the SAME upstream's adapter — the job belongs to that provider.
  const { resp: job, usedUpstream } = await executeWithFailover(
    ordered,
    async (u) => {
      const a = getUpstream(u.provider);
      if (!a.audioSpeech) {
        throw errors.badRequest('Selected model does not support audio speech');
      }
      let j = await a.audioSpeech({
        modelId: u.upstream_model_id,
        input: body.input,
        voice: body.voice,
        format: body.format,
        byokKey,
        egressProxyUrl: u.egress_proxy ?? undefined,
      });

      if (a.pollJob && (j.status === 'queued' || j.status === 'processing')) {
        const timeoutMs = Number(process.env.KIE_SYNC_POLL_MS || 60_000);
        const intervalMs = 5_000;
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, intervalMs));
          j = await a.pollJob(j.job_id, 'suno', {
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
      requestId,
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
    type: 'image', // audio logs as 'image' until type enum extended
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
      'audio_job_failed'
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
      url = (o.url ?? o.audio_url ?? o.output_url) as string | undefined;
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
      hint: 'Audio job did not complete within the sync poll window. Retry later.',
    },
    202,
  );
});

audio.post('/transcriptions', async (c) => {
  // Placeholder — STT requires Whisper/Yandex SpeechKit; route returns 501.
  void c;
  throw errors.badRequest('STT not yet wired (use Whisper-capable upstream when available)');
});
