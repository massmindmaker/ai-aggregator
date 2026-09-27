/**
 * Kie.ai adapter — media exclusives (Veo 3 video, Suno music, Midjourney, nano-banana).
 *
 * API docs: https://docs.kie.ai
 * - Base URL: https://api.kie.ai
 * - Auth: `Authorization: Bearer <KIE_KEY>`
 * - Video (Veo 3): POST /api/v1/veo/generate → { data: { taskId } }
 *                  GET  /api/v1/veo/status/{taskId} → { data: { status, output_url? } }
 * - Music (Suno):  POST /api/v1/suno/generate
 *                  GET  /api/v1/suno/status/{taskId}
 * - Image:         POST /api/v1/image/generate  (nano-banana, midjourney, flux via Kie proxy)
 *                  GET  /api/v1/image/status/{taskId}
 *
 * Gotcha: некоторые Kie модели имеют hidden pricing (видно только после login).
 * Для них `pricing === undefined` → estimateCost returns credits=0, admin вводит manually.
 */
import { UpstreamAdapterBase, type AdapterConfig } from '../base/UpstreamAdapterBase';
import type {
  AsyncJobHandle,
  AsyncJobResult,
  CostEstimate,
  HealthStatus,
  ImageRequest,
  Modality,
  ModelMeta,
  UpstreamInvokeOptions,
  UsageBreakdown,
  VideoRequest,
  AudioRequest,
} from '../base/UpstreamAdapter';

export interface KieConfig extends Omit<AdapterConfig, 'baseUrl' | 'auth_scheme'> {
  baseUrl?: string;
}

interface KieSubmitResponse {
  code?: number;
  msg?: string;
  data: { taskId: string };
}

interface KieStatusResponse {
  code?: number;
  data: {
    taskId: string;
    status?: 'pending' | 'processing' | 'completed' | 'failed' | 'success' | 'queued';
    state?: string;
    resultJson?: string;
    output?: unknown;
    output_url?: string;
    url?: string;
    error?: string;
    fail_reason?: string;
    failMsg?: string;
    failCode?: string;
  };
}

type KieFamily = 'veo' | 'suno' | 'image';

export class KieAdapter extends UpstreamAdapterBase {
  readonly name = 'kie';
  readonly supports_modalities: readonly Modality[] = ['image', 'video', 'audio'];

  constructor(cfg: KieConfig) {
    super({
      baseUrl: cfg.baseUrl ?? 'https://api.kie.ai',
      apiKey: cfg.apiKey,
      markup: cfg.markup ?? 1.2,
      usd_rate: cfg.usd_rate,
      userAgent: cfg.userAgent ?? 'AIAG-Kie/0.5',
      default_timeout_ms: cfg.default_timeout_ms ?? 30_000,
      fetch: cfg.fetch,
      auth_scheme: 'bearer',
      extra_headers: cfg.extra_headers,
      retry: cfg.retry,
    });
  }

  async listModels(): Promise<ModelMeta[]> {
    return CURATED_KIE_MODELS;
  }

  async imageGenerations(
    req: ImageRequest,
    opts: UpstreamInvokeOptions,
  ): Promise<AsyncJobHandle> {
    return this.submitAsync('image', {
      model: req.model,
      prompt: req.prompt,
      negative_prompt: req.negative_prompt,
      size: req.size,
      n: req.n ?? 1,
      seed: req.seed,
      image_url: req.reference_image_url,
    }, opts);
  }

  async videoGenerations(
    req: VideoRequest,
    opts: UpstreamInvokeOptions,
  ): Promise<AsyncJobHandle> {
    return this.submitAsync('veo', {
      model: req.model,
      prompt: req.prompt,
      duration: req.duration_s,
      aspect_ratio: req.aspect_ratio,
      image_url: req.image_url,
    }, opts);
  }

  async audioSpeech(
    req: AudioRequest,
    opts: UpstreamInvokeOptions,
  ): Promise<Response> {
    // Suno is async, but contract says audioSpeech returns Response — wrap the handle.
    const handle = await this.submitAsync('suno', {
      model: req.model,
      prompt: req.input,
      voice: req.voice,
      format: req.format,
    }, opts);
    return new Response(JSON.stringify(handle), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    });
  }

  private async submitAsync(
    family: KieFamily,
    body: Record<string, unknown>,
    opts: UpstreamInvokeOptions,
  ): Promise<AsyncJobHandle> {
    const path = `/api/v1/${family}/generate`;
    const res = await this.request({
      path,
      method: 'POST',
      body,
      byok_key: opts.byok_key,
      timeout_ms: opts.timeout_ms,
      headers: { 'x-request-id': opts.request_id },
    });
    const data = (await res.json()) as KieSubmitResponse;
    if (!data?.data?.taskId) {
      throw new Error(`Kie submit returned no taskId: ${JSON.stringify(data)}`);
    }
    return {
      task_id: data.data.taskId,
      poll_url: `/api/v1/${family}/status/${data.data.taskId}`,
    };
  }

  async pollAsync(task_id: string, opts: UpstreamInvokeOptions): Promise<AsyncJobResult> {
    const prefixed = /^(jobs|veo|suno):(.+)$/.exec(task_id);
    const hinted = (opts as UpstreamInvokeOptions & { poll_url?: string; family?: KieFamily }).poll_url;
    let path: string;
    if (prefixed) {
      const family = prefixed[1]!;
      const rawTaskId = prefixed[2]!;
      path =
        family === 'jobs'
          ? `/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(rawTaskId)}`
          : family === 'veo'
            ? `/api/v1/veo/recordInfo?taskId=${encodeURIComponent(rawTaskId)}`
            : `/api/v1/generate/recordInfo?taskId=${encodeURIComponent(rawTaskId)}`;
    } else {
      const family: KieFamily =
        (opts as UpstreamInvokeOptions & { family?: KieFamily }).family ??
        inferFamilyFromPollUrl(hinted) ??
        'veo';
      path = hinted ?? `/api/v1/${family}/status/${task_id}`;
    }

    const res = await this.request({ path, method: 'GET', no_retry: true, byok_key: opts.byok_key });
    const body = (await res.json()) as KieStatusResponse;
    const s = String(body?.data?.status ?? body?.data?.state ?? '').toLowerCase();
    if (s === 'completed' || s === 'success') {
      const candidate = selectKiePublicOutputCandidate(body.data);
      const output = sanitizePublicMediaOutput(candidate);
      if (output === null) {
        return { status: 'failed', error: 'kie completed without usable output' };
      }
      return { status: 'completed', output };
    }
    if (s === 'failed' || s === 'fail') {
      return {
        status: 'failed',
        error: body.data.fail_reason ?? body.data.error ?? body.data.failMsg ?? body.data.failCode ?? 'kie job failed',
      };
    }
    return { status: 'pending' };
  }

  async healthCheck(): Promise<HealthStatus> {
    const start = Date.now();
    try {
      const apiKey = await this.getApiKey();
      const url = new URL('/api/v1/models', this.config.baseUrl).toString();
      const res = await (this.config.fetch ?? fetch)(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${apiKey}` },
      });
      const ok = res.status < 500;
      return {
        status: ok ? 'healthy' : 'unhealthy',
        latency_ms: Date.now() - start,
        checked_at: new Date().toISOString(),
        last_error: ok ? undefined : `status ${res.status}`,
      };
    } catch (err) {
      return {
        status: 'unhealthy',
        latency_ms: Date.now() - start,
        checked_at: new Date().toISOString(),
        last_error: (err as Error).message,
      };
    }
  }

  async estimateCost(
    req: Record<string, unknown>,
    model: ModelMeta,
  ): Promise<CostEstimate> {
    if (!model.pricing) {
      this.log.warn(
        { model: model.id },
        'Kie model pricing=null — hidden pricing, admin must set manually',
      );
      return {
        credits: 0,
        upstream_cost_usd: 0,
        breakdown: { upstream: 0, markup: this.markup, usd_rate: this.usd_rate },
      };
    }
    const usage: UsageBreakdown = {};
    if (model.modality === 'video') {
      usage.seconds = (req.duration_s as number | undefined) ?? 8;
    }
    if (model.modality === 'image') {
      usage.images = (req.n as number | undefined) ?? 1;
    }
    if (model.modality === 'audio') {
      usage.seconds = (req.duration_s as number | undefined) ?? 30;
    }
    return this.computeActualCost(usage, model);
  }

  async pricingSync(): Promise<Array<{ model_id: string; pricing: NonNullable<ModelMeta['pricing']> }>> {
    const models = await this.listModels();
    return models
      .filter((m) => m.pricing)
      .map((m) => ({ model_id: m.id, pricing: m.pricing! }));
  }
}

function selectKiePublicOutputCandidate(data: KieStatusResponse['data']): unknown {
  const direct: unknown = data.output ?? data.output_url ?? data.url;
  if (direct !== undefined) return direct;
  if (!data.resultJson) return undefined;
  try {
    const parsed = JSON.parse(data.resultJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
    const value = parsed as Record<string, unknown>;
    return (
      value.resultUrls ??
      value.urls ??
      value.outputUrls ??
      value.videoUrl ??
      value.audioUrl ??
      value.imageUrl ??
      value.url
    );
  } catch {
    return undefined;
  }
}

function sanitizePublicMediaOutput(value: unknown): string | string[] | null {
  const asUrl = (raw: unknown): string | null => {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8192) return null;
    try {
      const parsed = new URL(raw);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
      return raw;
    } catch {
      return null;
    }
  };

  if (Array.isArray(value)) {
    if (value.length === 0 || value.length > 32) return null;
    const urls = value.map(asUrl);
    if (urls.some((url) => url === null)) return null;
    const safe = urls as string[];
    return safe.length === 1 ? safe[0]! : safe;
  }
  return asUrl(value);
}

function inferFamilyFromPollUrl(url?: string): KieFamily | null {
  if (!url) return null;
  if (url.includes('/veo/')) return 'veo';
  if (url.includes('/suno/')) return 'suno';
  if (url.includes('/image/')) return 'image';
  return null;
}

const CURATED_KIE_MODELS: ModelMeta[] = [
  {
    id: 'veo-3',
    name: 'Veo 3',
    modality: 'video',
    pricing: { per_second: 0.5 }, // manual — update from Kie dashboard
  },
  {
    id: 'veo-3-fast',
    name: 'Veo 3 Fast',
    modality: 'video',
    pricing: { per_second: 0.25 },
  },
  {
    id: 'kling-3.0',
    name: 'Kling 3.0',
    modality: 'video',
    pricing: { per_second: 0.35 },
  },
  {
    id: 'runway-aleph',
    name: 'Runway Aleph (exclusive)',
    modality: 'video',
    // hidden pricing — admin must fill
  },
  {
    id: 'suno-v4-5',
    name: 'Suno V4.5+',
    modality: 'audio',
    // hidden
  },
  {
    id: 'midjourney-v7',
    name: 'Midjourney v7',
    modality: 'image',
    pricing: { per_image: 0.05 },
  },
  {
    id: 'nano-banana-pro',
    name: 'Nano Banana Pro',
    modality: 'image',
    pricing: { per_image: 0.015 },
  },
  {
    id: 'nano-banana-2',
    name: 'Nano Banana 2',
    modality: 'image',
    pricing: { per_image: 0.008 },
  },
];
