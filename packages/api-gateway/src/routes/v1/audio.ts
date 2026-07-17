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
  // FIX (blocker 1, Opus review 2026-07-17): this route serves TWO different
  // pricing shapes under the 'audio' model type — Suno-style song generation
  // (flat per-track price, model_upstreams.price_per_image) and ElevenLabs-
  // style TTS (per-second rate, model_upstreams.price_per_audio_sec). The
  // previous code hardcoded 'image' as the cost metric and required
  // price_per_image on EVERY audio row — that field is NULL for every TTS
  // model (elevenlabs-tts-hf/-kie), so the earlier fail-closed check 503'd
  // the entire TTS surface. 'audio' metric picks whichever column routing
  // ranks by; the fail-closed check below accepts either column being set.
  const upstream = pickUpstream(model.candidates, mode, policies, 'audio');

  // Fail closed, before spending on the upstream job: no price in EITHER
  // column means we cannot bill correctly for this model. A numeric fallback
  // here was the MED bug (Opus review) — `?? 0.05` was written when the
  // column was believed to be USD; now that these columns are confirmed US
  // CENTS, that fallback would have billed ~100x too little instead of
  // erroring. The price is required in the DB — there is no safe guess.
  if (!byok && upstream.price_per_audio_sec == null && upstream.price_per_image == null) {
    throw errors.unavailable('Pricing not configured for this model — cannot bill safely');
  }

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

  // T1-fix: whole MICRO-credits, no ₽/FX. Both pricing columns are already
  // US CENTS — see lib/pricing.ts.
  let costCredits = 0; // MICRO-credits (1 credit = 1000 micro = 1¢)
  let upstreamCents = 0;
  if (byok) {
    costCredits = calcByokFeeCredits();
  } else if (upstream.price_per_audio_sec != null) {
    // ElevenLabs-style TTS: price_per_audio_sec is a genuine $/second RATE,
    // not a flat call price (the storefront catalog shows it scaled to a
    // per-minute display price — gen-marketplace-catalog.ts). Kie's
    // completed-job response carries no actual output-audio duration (only
    // a result URL), so true per-second metering isn't available from this
    // upstream today. Bill one call as a 1-minute unit — the same unit the
    // storefront already advertises (pricing.unit = 'минута') — rather than
    // inventing a text-length heuristic. This is a documented approximation
    // (like video.ts's per-clip-at-default-duration), not a guess dressed
    // up as precision; real duration-based metering is follow-up debt.
    upstreamCents = upstream.price_per_audio_sec * 60;
    costCredits = calcCostCredits({ upstreamCents, markup: upstream.markup });
  } else {
    // Suno-style song generation: flat per-track price stored in
    // price_per_image (reused the way video.ts reuses it for per-clip
    // pricing — validated non-null by the fail-closed check above).
    upstreamCents = upstream.price_per_image!;
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
