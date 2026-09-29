/**
 * Groq upstream — OpenAI-compatible base URL https://api.groq.com/openai/v1.
 *
 * Reads system key from process.env.GROQ_API_KEY.
 * If `byokKey` is supplied per-request, that key takes precedence (BYOK).
 *
 * Returns OpenAI-shaped ChatResponse / EmbeddingsResponse so settle/logging
 * code stays unchanged. Groq is chat/completions only (no embeddings endpoint
 * at time of writing) but the embeddings() method is wired defensively in case
 * Groq adds one — it just calls /embeddings on the same OpenAI-compatible base.
 */
import type {
  UpstreamAdapter,
  ChatRequest,
  ChatResponse,
  EmbeddingsRequest,
  EmbeddingsResponse,
  AdmittedTranscriptionRequest,
  AdmittedTranscriptionResponse,
} from './interface';
import { fetchUpstream } from './fetch-upstream';
import { logger } from '../lib/logger';
import { upstreamHttpError } from '../lib/client-errors';

const GROQ_BASE = 'https://api.groq.com/openai/v1';
// safeFetch allowlist: fixed public host, allowlisted so the vetting path
// needs no DNS (offline-safe unit runs). T2: all adapter traffic funnels
// through fetchUpstream for egress-proxy resolution.
const GROQ_ALLOWLIST = ['api.groq.com'];

function selectKey(byok?: string): string | undefined {
  return byok || process.env.GROQ_API_KEY;
}

const TRANSCRIPTION_TIMEOUT_MS = 120_000;
const TRANSCRIPTION_RESPONSE_LIMIT_BYTES = 1_048_576;

async function boundedResponseText(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body) throw new Error('invalid transcription response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) {
        complete = true;
        break;
      }
      size += part.value.byteLength;
      if (size > TRANSCRIPTION_RESPONSE_LIMIT_BYTES)
        throw new Error('transcription response too large');
      chunks.push(part.value);
    }
  } finally {
    if (!complete) void reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      /* cancellation owns pending read */
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function executeReviewedTranscription(
  req: AdmittedTranscriptionRequest,
): Promise<AdmittedTranscriptionResponse> {
  if (req.modelId !== 'whisper-large-v3')
    throw new Error('reviewed transcription model unavailable');
  if (!(req.audioBytes instanceof Uint8Array) || req.audioBytes.byteLength < 1)
    throw new Error('reviewed transcription audio unavailable');
  if (req.language !== undefined && !/^[a-z]{2}$/.test(req.language))
    throw new Error('reviewed transcription language unavailable');
  if (req.egressProxyUrl?.trim() || process.env.AIAG_EGRESS_PROXY_URL?.trim())
    throw new Error('reviewed transcription proxy unavailable');

  const apiKey = selectKey();
  if (!apiKey) throw new Error('model provider not configured');
  const form = new FormData();
  form.set('model', req.modelId);
  form.set('response_format', 'verbose_json');
  if (req.language) form.set('language', req.language);
  form.set(
    'file',
    new File([req.audioBytes], 'audio.wav', { type: 'audio/wav' }),
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRANSCRIPTION_TIMEOUT_MS);
  try {
    const response = await fetchUpstream(
      `${GROQ_BASE}/audio/transcriptions`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
        allowlist: GROQ_ALLOWLIST,
        maxRedirects: 0,
        maxBufferedResponseBytes: TRANSCRIPTION_RESPONSE_LIMIT_BYTES,
        signal: controller.signal,
      },
      undefined,
    );
    if (!response.ok) {
      if (response.body && !response.body.locked)
        void response.body.cancel().catch(() => undefined);
      throw upstreamHttpError(response.status);
    }
    if (
      response.headers
        .get('content-type')
        ?.split(';', 1)[0]
        ?.trim()
        .toLowerCase() !== 'application/json'
    ) {
      if (response.body && !response.body.locked)
        void response.body.cancel().catch(() => undefined);
      throw new Error('invalid transcription response');
    }
    const raw = await boundedResponseText(response, controller.signal);
    const value = JSON.parse(raw) as {
      text?: unknown;
      duration?: unknown;
      x_groq?: unknown;
    };
    if (
      typeof value.text !== 'string' ||
      Buffer.byteLength(value.text, 'utf8') > 1_000_000 ||
      typeof value.duration !== 'number' ||
      !Number.isFinite(value.duration) ||
      value.duration <= 0 ||
      value.duration > 7_200
    )
      throw new Error('invalid transcription response');
    const providerDurationMs = Math.round(value.duration * 1000);
    if (!Number.isSafeInteger(providerDurationMs) || providerDurationMs <= 0)
      throw new Error('invalid transcription response');
    let providerResponseId: string | null = null;
    if (value.x_groq !== undefined) {
      if (!value.x_groq || typeof value.x_groq !== 'object' || Array.isArray(value.x_groq))
        throw new Error('invalid transcription response');
      const responseId = (value.x_groq as { id?: unknown }).id;
      if (responseId !== undefined) {
        if (
          typeof responseId !== 'string' ||
          responseId.length < 1 ||
          responseId.length > 256 ||
          !/^[A-Za-z0-9._:-]+$/.test(responseId)
        )
          throw new Error('invalid transcription response');
        providerResponseId = responseId;
      }
    }
    return Object.freeze({ text: value.text, providerDurationMs, providerResponseId });
  } finally {
    clearTimeout(timer);
  }
}

export const groqUpstream: UpstreamAdapter = {
  admittedTranscription: Object.freeze({
    contract: 'groq-pcm-wav-transcription-v1' as const,
    execute: executeReviewedTranscription,
  }),

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const apiKey = selectKey(req.byokKey);
    if (!apiKey) {
      logger.warn({ model: req.modelId }, 'groq_apikey_missing');
      throw new Error('model provider not configured');
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    };

    const start = Date.now();
    const res = await fetchUpstream(
      `${GROQ_BASE}/chat/completions`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: req.modelId,
          messages: req.messages,
          stream: false,
          ...(req.temperature !== undefined && { temperature: req.temperature }),
          ...(req.max_tokens !== undefined && { max_tokens: req.max_tokens }),
        }),
        allowlist: GROQ_ALLOWLIST,
      },
      req.egressProxyUrl,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn(
        { status: res.status, model: req.modelId, body: text.slice(0, 500) },
        'groq_upstream_error'
      );
      throw upstreamHttpError(res.status);
    }
    const data = (await res.json()) as ChatResponse & {
      usage?: Partial<ChatResponse['usage']>;
      system_fingerprint?: string;
    };
    logger.info(
      { model: req.modelId, ms: Date.now() - start, tokens: data.usage?.total_tokens },
      'groq_ok'
    );
    const usage = {
      prompt_tokens: data.usage?.prompt_tokens ?? 0,
      completion_tokens: data.usage?.completion_tokens ?? 0,
      total_tokens: data.usage?.total_tokens ?? 0,
    };
    // White-label: strip upstream-revealing fields before returning.
    const cleaned = { ...data, usage };
    delete (cleaned as Record<string, unknown>).system_fingerprint;
    delete (cleaned as Record<string, unknown>).x_groq;
    return cleaned;
  },

  async *chatStream(req: ChatRequest): AsyncIterable<unknown> {
    const apiKey = selectKey(req.byokKey);
    if (!apiKey) {
      logger.warn({ model: req.modelId }, 'groq_apikey_missing');
      throw new Error('model provider not configured');
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    };

    const res = await fetchUpstream(
      `${GROQ_BASE}/chat/completions`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: req.modelId,
          messages: req.messages,
          stream: true,
          ...(req.temperature !== undefined && { temperature: req.temperature }),
          ...(req.max_tokens !== undefined && { max_tokens: req.max_tokens }),
        }),
        allowlist: GROQ_ALLOWLIST,
        sse: true,
      },
      req.egressProxyUrl,
    );
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      logger.warn(
        { status: res.status, model: req.modelId, body: text.slice(0, 500) },
        'groq_stream_error'
      );
      throw upstreamHttpError(res.status);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          yield JSON.parse(payload);
        } catch {
          /* skip malformed chunk */
        }
      }
    }
  },

  async embeddings(req: EmbeddingsRequest): Promise<EmbeddingsResponse> {
    const apiKey = selectKey(req.byokKey);
    if (!apiKey) {
      logger.warn({ model: req.modelId }, 'groq_apikey_missing');
      throw new Error('model provider not configured');
    }
    const res = await fetchUpstream(
      `${GROQ_BASE}/embeddings`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: req.modelId, input: req.input }),
        allowlist: GROQ_ALLOWLIST,
      },
      req.egressProxyUrl,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn(
        { status: res.status, model: req.modelId, body: text.slice(0, 500) },
        'groq_embeddings_error'
      );
      throw upstreamHttpError(res.status);
    }
    const data = (await res.json()) as {
      data?: Array<{ embedding: number[]; index?: number }>;
      usage?: { prompt_tokens?: number; total_tokens?: number };
    };
    const promptTokens = data.usage?.prompt_tokens ?? 0;
    return {
      object: 'list',
      model: req.modelId,
      data: (data.data ?? []).map((d, i) => ({
        object: 'embedding',
        embedding: d.embedding,
        index: d.index ?? i,
      })),
      usage: {
        prompt_tokens: promptTokens,
        total_tokens: data.usage?.total_tokens ?? promptTokens,
      },
    };
  },
};
