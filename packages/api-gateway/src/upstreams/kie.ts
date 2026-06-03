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

const KIE_BASE = process.env.KIE_BASE_URL || 'https://api.kie.ai';

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
): Promise<MediaJob> {
  const apiKey = selectKey(byokKey);
  if (!apiKey) throw new Error('KIE_API_KEY not configured');
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
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    logger.warn(
      { model, family, url, status: res.status, body: text.slice(0, 500) },
      'kie_submit_error',
    );
    throw new Error(`Kie ${family} ${res.status}: ${text.slice(0, 200)}`);
  }
  let data: { code?: number; msg?: string; data?: { taskId?: string } };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Kie ${family} non-JSON: ${text.slice(0, 200)}`);
  }
  if (data?.code && data.code !== 200) {
    throw new Error(`Kie ${family} code=${data.code}: ${data.msg ?? 'unknown'}`);
  }
  const taskId = data?.data?.taskId;
  if (!taskId) {
    throw new Error(`Kie ${family} returned no taskId: ${text.slice(0, 200)}`);
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

async function pollOnce(prefixedJobId: string, byokKey?: string): Promise<MediaJob> {
  const apiKey = selectKey(byokKey);
  if (!apiKey) throw new Error('KIE_API_KEY not configured');
  // Job ids are stored as "<family>:<taskId>" so we know which status endpoint
  // to hit. Older callers passing a bare taskId default to the unified jobs API.
  const sep = prefixedJobId.indexOf(':');
  const family: KieFamily = sep > 0 ? (prefixedJobId.slice(0, sep) as KieFamily) : 'jobs';
  const taskId = sep > 0 ? prefixedJobId.slice(sep + 1) : prefixedJobId;
  const ep = endpointsFor(family);
  const url = `${KIE_BASE}${ep.status(taskId)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Kie recordInfo ${res.status}: ${text.slice(0, 200)}`);
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
    throw new Error('Kie does not support chat completions');
  },

  async imageGeneration(req: ImageRequest): Promise<MediaJob> {
    const input: Record<string, unknown> = { prompt: req.prompt };
    if (req.n) input.n = req.n;
    if (req.size) input.size = req.size;
    if (req.negative_prompt) input.negative_prompt = req.negative_prompt;
    if (req.reference_image_url) input.image_url = req.reference_image_url;
    return createTask(req.modelId, input, req.byokKey);
  },

  async videoGeneration(req: VideoRequest): Promise<MediaJob> {
    const input: Record<string, unknown> = { prompt: req.prompt };
    if (req.duration_s) input.duration = req.duration_s;
    if (req.aspect_ratio) input.aspect_ratio = req.aspect_ratio;
    if (req.image_url) input.image_url = req.image_url;
    return createTask(req.modelId, input, req.byokKey);
  },

  async audioSpeech(req: AudioSpeechRequest): Promise<MediaJob> {
    const input: Record<string, unknown> = { prompt: req.input };
    if (req.voice) input.voice = req.voice;
    if (req.format) input.format = req.format;
    return createTask(req.modelId, input, req.byokKey);
  },

  async audioTranscription(_req: AudioTranscriptionRequest): Promise<MediaJob> {
    throw new Error('Kie does not provide STT; use a Whisper-capable upstream');
  },

  async pollJob(jobId: string): Promise<MediaJob> {
    return pollOnce(jobId);
  },
};
