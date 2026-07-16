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
import { calcCostCredits, calcByokFeeCredits } from '../../lib/pricing';
import { settleCharge } from '../../billing/settle';
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
  const upstream = pickUpstream(model.candidates, mode, policies, 'image');

  const start = Date.now();
  const adapter = getUpstream(upstream.provider);
  if (!adapter.audioSpeech) {
    throw errors.badRequest('Selected model does not support audio speech');
  }

  let job = await adapter.audioSpeech({
    modelId: upstream.upstream_model_id,
    input: body.input,
    voice: body.voice,
    format: body.format,
    byokKey,
  });

  if (adapter.pollJob && (job.status === 'queued' || job.status === 'processing')) {
    const timeoutMs = Number(process.env.KIE_SYNC_POLL_MS || 60_000);
    const intervalMs = 5_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, intervalMs));
      job = await adapter.pollJob(job.job_id, 'suno');
      if (job.status === 'completed' || job.status === 'failed') break;
    }
  }

  // T1-fix: whole MICRO-credits, no ₽/FX. upstream.price_per_image is
  // already US CENTS — see lib/pricing.ts.
  let costCredits = 0; // MICRO-credits (1 credit = 1000 micro = 1¢)
  let upstreamCents = 0;
  if (byok) {
    costCredits = calcByokFeeCredits();
  } else {
    upstreamCents = upstream.price_per_image ?? 0.05; // per-clip baseline for audio
    costCredits = calcCostCredits({ upstreamCents, markup: upstream.markup });
  }
  if (job.status === 'completed' && costCredits > 0) {
    await settleCharge({
      orgId: key.org_id,
      requestId,
      costCredits,
      metadata: { model_slug: body.model },
    });
  }

  void logRequest({
    requestId,
    orgId: key.org_id,
    apiKeyId: key.id,
    type: 'image', // audio logs as 'image' until type enum extended
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
