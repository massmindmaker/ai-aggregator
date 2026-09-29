import { Hono } from 'hono';
import { AiagError, errors } from '../../lib/errors';
import type { AuthenticatedApiKey } from '../../middleware/auth-plan04';
import { resolveModelWithOverride } from '../../routing/resolver';
import { pickUpstream, type ApiKeyPolicies, type Mode } from '../../routing/engine';
import { getUpstream } from '../../upstreams/registry';
import {
  captureStoredTranscriptionHttpRequest,
  StoredTranscriptionHttpContractError,
} from '../../billing/stored-transcription-http-identity';
import {
  findReviewedTranscriptionProfile,
  type ReviewedTranscriptionProfile,
} from '../../billing/reviewed-transcription-profiles';
import { quoteReviewedTranscription } from '../../billing/stored-transcription-wav';
import { createStoredTranscriptionAttempt } from '../../billing/stored-transcription-attempt';

export const storedTranscription = new Hono();
const deadline = () => new Date(Date.now() + 5 * 60_000).toISOString();

function contractError(error: StoredTranscriptionHttpContractError): AiagError {
  if (error.code === 'REQUEST_BODY_TOO_LARGE')
    return new AiagError('REQUEST_BODY_TOO_LARGE', 413, 'Transcription request body is too large');
  if (error.code === 'UNSUPPORTED_CONTENT_TYPE')
    return new AiagError('UNSUPPORTED_CONTENT_TYPE', 415, 'Transcription requires multipart/form-data');
  if (error.code === 'UNSUPPORTED_EXECUTION_CONTRACT')
    return errors.unsupported('Transcription execution contract is unsupported');
  return errors.badRequest('Invalid transcription request');
}

function profileFor(
  modelSlug: string,
  modelType: string,
  candidate: {
    id: string;
    upstream_id: string;
    upstream_model_id: string;
  },
): ReviewedTranscriptionProfile | null {
  return findReviewedTranscriptionProfile({
    modelSlug,
    modelType,
    upstreamId: candidate.upstream_id,
    upstreamModelId: candidate.upstream_model_id,
    adapterKey: candidate.id,
  });
}

storedTranscription.post('/audio/transcriptions', async (c) => {
  let captured: Awaited<ReturnType<typeof captureStoredTranscriptionHttpRequest>>;
  try {
    captured = await captureStoredTranscriptionHttpRequest(c.req.raw);
  } catch (error) {
    if (error instanceof StoredTranscriptionHttpContractError)
      throw contractError(error);
    throw errors.badRequest('Invalid transcription request');
  }

  const key = c.get('apiKey' as never) as AuthenticatedApiKey;
  const model = await resolveModelWithOverride(captured.identity.model);
  if (model.type !== 'audio') throw errors.badRequest('Invalid transcription model');

  const reviewedCandidates = model.candidates.filter(
    (candidate) => profileFor(model.slug, model.type, candidate) !== null,
  );
  if (reviewedCandidates.length === 0)
    throw errors.unavailable('Transcription capability unavailable');

  const policies = (key.policies ?? {}) as ApiKeyPolicies;
  const requestedMode = (policies.default_mode ?? 'auto') as Mode;
  const candidate = pickUpstream(reviewedCandidates, requestedMode, policies, 'audio');
  const profile = profileFor(model.slug, model.type, candidate);
  if (!profile) throw errors.unavailable('Transcription capability unavailable');
  if (
    candidate.provider !== 'groq' ||
    candidate.upstream_id !== 'groq' ||
    candidate.egress_proxy ||
    process.env.AIAG_EGRESS_PROXY_URL?.trim() ||
    !candidate.billing ||
    candidate.billing.pricePerAudioSecondCents !== profile.pricePerAudioSecondCents ||
    !candidate.billing.prices.markup
  )
    throw errors.unavailable('Transcription capability unavailable');

  const adapter = getUpstream(candidate.provider);
  if (
    !adapter.admittedTranscription ||
    adapter.admittedTranscription.contract !== profile.adapterContract
  )
    throw errors.unavailable('Transcription capability unavailable');

  const quote = quoteReviewedTranscription({
    profile,
    billableMs: captured.identity.billableMs,
    markup: candidate.billing.prices.markup,
  });

  const attempt = createStoredTranscriptionAttempt({
    identity: captured.identity,
    audioBytes: captured.audio.bytes,
    orgId: key.org_id,
    apiKeyId: key.id,
    clientRequestId: (c.get('requestId' as never) as string | null) ?? null,
    deadlineAt: deadline(),
    modelSlug: captured.identity.model === 'whisper-large-v3'
      ? 'whisper-large-v3'
      : (() => { throw errors.unavailable('Transcription model unavailable'); })(),
    modelUpstreamId: candidate.billing.modelUpstreamId,
    upstreamId: 'groq',
    upstreamModelId: candidate.upstream_model_id === 'whisper-large-v3'
      ? 'whisper-large-v3'
      : (() => { throw errors.unavailable('Transcription model unavailable'); })(),
    quote: {
      billableMs: quote.billableMs,
      supplierRateUsdMicroPerHour: quote.supplierRateUsdMicroPerHour,
      supplierMaxUsdMicro: quote.supplierMaxUsdMicro,
      supplierMaxMicrocredits: quote.supplierMaxMicrocredits,
      retailMaxMicrocredits: quote.retailMaxMicrocredits,
      formulaVersion: quote.formulaVersion,
      supplierFormulaVersion: quote.supplierFormulaVersion,
    },
    markup: candidate.billing.prices.markup,
    execute: () =>
      adapter.admittedTranscription!.execute({
        modelId: 'whisper-large-v3',
        audioBytes: captured.audio.bytes,
        ...(captured.identity.language === null
          ? {}
          : { language: captured.identity.language }),
      }),
  });

  const result = await attempt.run();
  c.header('X-AIAG-Task-Id', result.taskId);
  if (result.kind === 'completed') return c.json({ text: result.text }, 200);
  return c.json(
    {
      error: {
        code: 'TRANSCRIPTION_RECONCILIATION_REQUIRED',
        message: 'Transcription request state unavailable',
      },
      task_id: result.taskId,
    },
    503,
  );
});
