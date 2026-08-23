/**
 * Kie.ai upstream — wraps Kie's unified async jobs API for the gateway's
 * UpstreamAdapter contract.
 *
 * Kie exposes a single endpoint family for all media generation:
 *   POST /api/v1/jobs/createTask       body: { model, input: {...} }
 *   GET  /api/v1/jobs/recordInfo?taskId=<id>
 *
 * Response shape:
 *   { code: 200, msg: "success", data: { taskId, recordId } }
 *   { data: { state: "success"|"fail"|"processing", resultJson, failMsg, ... } }
 *
 * `resultJson` is a stringified JSON like {"resultUrls":["https://..."]}.
 *
 * Routes synchronously poll up to KIE_SYNC_POLL_MS (default 60s); if the
 * job is still pending, the route returns a 202 with the job_id so the
 * caller can poll `/api/v1/jobs/recordInfo?taskId=<id>` directly (or via
 * a future internal /v1/jobs/{id} endpoint).
 *
 * Reads system key from process.env.KIE_API_KEY. BYOK header overrides.
 */
import type {
  UpstreamAdapter,
  ChatRequest,
  ChatResponse,
  ImageRequest,
  VideoRequest,
  AudioSpeechRequest,
  AudioTranscriptionRequest,
  MediaJob,
} from './interface';
import { logger } from '../lib/logger';
import { upstreamHttpError } from '../lib/client-errors';
import { fetchUpstream } from './fetch-upstream';

const KIE_BASE = process.env.KIE_BASE_URL || 'https://api.kie.ai';

// KIE_BASE_URL is operator-configured (may be an internal / plain-http host in
// self-hosted setups). Allowlist exactly that host so safeFetch accepts what
// worked before T2 — the operator already vetted this endpoint by configuring
// it. Public default keeps its normal DNS/IP vetting via the same entry.
const KIE_ALLOWLIST: string[] = (() => {
  try {
    const u = new URL(KIE_BASE);
    const host = u.hostname.toLowerCase();
    return [u.port ? `${host}:${u.port}` : host];
  } catch {
    return [];
  }
})();

function selectKey(byok?: string): string | undefined {
  return byok || process.env.KIE_API_KEY;
}

/**
 * Kie has multiple endpoint families depending on model:
 *  - veo3 / veo3_fast / veo3_lite           → /api/v1/veo/generate (status: /veo/recordInfo)
 *  - suno*                                  → /api/v1/generate     (suno-specific)
 *  - everything else (nano-banana-2, sora-2-text-to-video, flux-*,
 *    midjourney, kling, etc.)               → /api/v1/jobs/createTask (status: /jobs/recordInfo)
 *
 * Model strings here are the actual Kie ids — not gateway slugs.
 */
type KieFamily = 'jobs' | 'veo' | 'suno';

function familyOf(model: string): KieFamily {
  const m = model.toLowerCase();
  if (m.startsWith('veo')) return 'veo';
  if (m.startsWith('suno')) return 'suno';
  return 'jobs';
}

function endpointsFor(family: KieFamily): { create: string; status: (id: string) => string } {
  switch (family) {
    case 'veo':
      return {
        create: '/api/v1/veo/generate',
        status: (id) => `/api/v1/veo/recordInfo?taskId=${encodeURIComponent(id)}`,
      };
    case 'suno':
      return {
        create: '/api/v1/generate',
        status: (id) => `/api/v1/generate/recordInfo?taskId=${encodeURIComponent(id)}`,
      };
    case 'jobs':
    default:
      return {
        create: '/api/v1/jobs/createTask',
        status: (id) => `/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(id)}`,
      };
  }
}

async function createTask(
  model: string,
  input: Record<string, unknown>,
  byokKey?: string,
  egressProxyUrl?: string | null,
): Promise<MediaJob> {
  const apiKey = selectKey(byokKey);
  if (!apiKey) {
    logger.warn({ model }, 'kie_apikey_missing');
    throw new Error('image service not configured');
  }
  const family = familyOf(model);
  const ep = endpointsFor(family);
  const url = `${KIE_BASE}${ep.create}`;
  // veo/suno endpoints typically expect a flat body with `model` + fields,
  // while /jobs/createTask wraps params in `input`. Send the union — extra
  // fields are usually ignored by Kie.
  const body =
    family === 'jobs'
      ? { model, input }
      : { model, ...input };
  const start = Date.now();
  const res = await fetchUpstream(
    url,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      allowlist: KIE_ALLOWLIST,
    },
    egressProxyUrl,
  );
  const text = await res.text();
  if (!res.ok) {
    logger.warn(
      { model, family, url, status: res.status, body: text.slice(0, 500) },
      'kie_submit_error',
    );
    throw upstreamHttpError(res.status);
  }
  let data: { code?: number; msg?: string; data?: { taskId?: string } };
  try {
    data = JSON.parse(text);
  } catch {
    logger.warn({ family, body: text.slice(0, 500) }, 'kie_non_json');
    throw new Error('upstream error: malformed response');
  }
  if (data?.code && data.code !== 200) {
    logger.warn({ family, code: data.code, msg: data.msg }, 'kie_error_code');
    throw new Error(`upstream error code=${data.code}`);
  }
  const taskId = data?.data?.taskId;
  if (!taskId) {
    logger.warn({ family, body: text.slice(0, 500) }, 'kie_no_taskid');
    throw new Error('upstream error: no job id');
  }
  logger.info({ model, family, taskId, ms: Date.now() - start }, 'kie_submit_ok');
  return {
    status: 'queued',
    job_id: `${family}:${taskId}`,
    poll_url: `${KIE_BASE}${ep.status(taskId)}`,
  };
}

interface KieRecordResponse {
  code?: number;
  data?: {
    taskId?: string;
    state?: string;
    resultJson?: string;
    failCode?: string | null;
    failMsg?: string | null;
  };
}

function extractUrls(resultJson?: string): string[] {
  if (!resultJson) return [];
  try {
    const parsed = JSON.parse(resultJson) as Record<string, unknown>;
    const urls = parsed.resultUrls ?? parsed.urls ?? parsed.outputUrls;
    if (Array.isArray(urls)) return urls.filter((u): u is string => typeof u === 'string');
    if (typeof urls === 'string') return [urls];
    // Some video models return { videoUrl: "..." }
    const single =
      (parsed.videoUrl as string | undefined) ??
      (parsed.audioUrl as string | undefined) ??
      (parsed.imageUrl as string | undefined) ??
      (parsed.url as string | undefined);
    if (single) return [single];
  } catch {
    /* fall through */
  }
  return [];
}

async function pollOnce(
  prefixedJobId: string,
  byokKey?: string,
  egressProxyUrl?: string | null,
): Promise<MediaJob> {
  const apiKey = selectKey(byokKey);
  if (!apiKey) {
    logger.warn({ jobId: prefixedJobId }, 'kie_apikey_missing');
    throw new Error('image service not configured');
  }
  // Job ids are stored as "<family>:<taskId>" so we know which status endpoint
  // to hit. Older callers passing a bare taskId default to the unified jobs API.
  const sep = prefixedJobId.indexOf(':');
  const family: KieFamily = sep > 0 ? (prefixedJobId.slice(0, sep) as KieFamily) : 'jobs';
  const taskId = sep > 0 ? prefixedJobId.slice(sep + 1) : prefixedJobId;
  const ep = endpointsFor(family);
  const url = `${KIE_BASE}${ep.status(taskId)}`;
  const res = await fetchUpstream(
    url,
    {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}` },
      allowlist: KIE_ALLOWLIST,
    },
    egressProxyUrl,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.warn({ status: res.status, body: text.slice(0, 500) }, 'kie_recordinfo_error');
    throw upstreamHttpError(res.status);
  }
  const body = (await res.json()) as KieRecordResponse;
  const s = (body?.data?.state ?? '').toLowerCase();
  if (s === 'success' || s === 'completed') {
    const urls = extractUrls(body.data?.resultJson);
    return {
      status: 'completed',
      job_id: prefixedJobId,
      output: urls.length === 1 ? urls[0] : urls.length ? urls : body.data?.resultJson,
    };
  }
  if (s === 'fail' || s === 'failed') {
    // Server-side only: the real upstream failure text. Routes (images.ts /
    // video.ts / audio.ts) log this again alongside requestId/upstreamId and
    // return a brand-neutral message to the client — this MediaJob.error
    // field must never be forwarded to the client as-is.
    logger.warn(
      { jobId: prefixedJobId, failCode: body.data?.failCode, failMsg: body.data?.failMsg },
      'kie_job_failed'
    );
    return {
      status: 'failed',
      job_id: prefixedJobId,
      error: body.data?.failMsg ?? body.data?.failCode ?? 'image generation failed',
    };
  }
  // processing | queued | pending | running | waiting | queuing | generating
  const processing = ['processing', 'running', 'generating'].includes(s);
  return { status: processing ? 'processing' : 'queued', job_id: prefixedJobId };
}

export const kieUpstream: UpstreamAdapter = {
  async chat(_req: ChatRequest): Promise<ChatResponse> {
    logger.warn({}, 'kie_chat_unsupported');
    throw new Error('this model does not support chat completions');
  },

  async imageGeneration(req: ImageRequest): Promise<MediaJob> {
    const input: Record<string, unknown> = { prompt: req.prompt };
    if (req.n) input.n = req.n;
    if (req.size) input.size = req.size;
    if (req.negative_prompt) input.negative_prompt = req.negative_prompt;
    if (req.reference_image_url) input.image_url = req.reference_image_url;
    return createTask(req.modelId, input, req.byokKey, req.egressProxyUrl);
  },

  async videoGeneration(req: VideoRequest): Promise<MediaJob> {
    const input: Record<string, unknown> = { prompt: req.prompt };
    if (req.duration_s) input.duration = req.duration_s;
    if (req.aspect_ratio) input.aspect_ratio = req.aspect_ratio;
    if (req.image_url) input.image_url = req.image_url;
    return createTask(req.modelId, input, req.byokKey, req.egressProxyUrl);
  },

  async audioSpeech(req: AudioSpeechRequest): Promise<MediaJob> {
    const input: Record<string, unknown> = { prompt: req.input };
    if (req.voice) input.voice = req.voice;
    if (req.format) input.format = req.format;
    return createTask(req.modelId, input, req.byokKey, req.egressProxyUrl);
  },

  async audioTranscription(_req: AudioTranscriptionRequest): Promise<MediaJob> {
    logger.warn({}, 'kie_stt_unsupported');
    throw new Error('speech-to-text is not available for this model');
  },

  async pollJob(
    jobId: string,
    _family: 'image' | 'video' | 'suno',
    opts?: { egressProxyUrl?: string | undefined },
  ): Promise<MediaJob> {
    return pollOnce(jobId, undefined, opts?.egressProxyUrl);
  },
};
