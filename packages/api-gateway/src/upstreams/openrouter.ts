/**
 * Real OpenRouter upstream — implements the gateway's UpstreamAdapter contract
 * by calling OpenRouter's OpenAI-compatible /chat/completions endpoint.
 *
 * Reads system key from process.env.OPENROUTER_API_KEY.
 * If `byokKey` is supplied per-request, that key takes precedence (BYOK).
 *
 * Returns OpenAI-shaped ChatResponse so settle/logging code stays unchanged.
 */
import type {
  UpstreamAdapter,
  ChatRequest,
  ChatResponse,
  EmbeddingsRequest,
  EmbeddingsResponse,
} from './interface';
import { fetchUpstream } from './fetch-upstream';
import { logger } from '../lib/logger';
import { upstreamHttpError } from '../lib/client-errors';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
// safeFetch allowlist: OpenRouter is the only host this adapter ever talks to.
const OPENROUTER_ALLOWLIST = ['openrouter.ai'];

function selectKey(byok?: string): string | undefined {
  return byok || process.env.OPENROUTER_API_KEY;
}

export const openRouterUpstream: UpstreamAdapter = {
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const apiKey = selectKey(req.byokKey);
    if (!apiKey) {
      logger.warn({ model: req.modelId }, 'openrouter_apikey_missing');
      throw new Error('model provider not configured');
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    };
    if (process.env.OPENROUTER_APP_URL) headers['http-referer'] = process.env.OPENROUTER_APP_URL;
    if (process.env.OPENROUTER_APP_NAME) headers['x-title'] = process.env.OPENROUTER_APP_NAME;

    const body = JSON.stringify({
      model: req.modelId,
      messages: req.messages,
      stream: false,
      temperature: req.temperature,
      max_tokens: req.max_tokens,
    });

    const start = Date.now();
    const res = await fetchUpstream(
      `${OPENROUTER_BASE}/chat/completions`,
      {
        method: 'POST',
        headers,
        body,
        allowlist: OPENROUTER_ALLOWLIST,
      },
      req.egressProxyUrl,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn(
        { status: res.status, model: req.modelId, body: text.slice(0, 500) },
        'openrouter_upstream_error'
      );
      throw upstreamHttpError(res.status);
    }
    const data = (await res.json()) as ChatResponse & {
      usage?: Partial<ChatResponse['usage']>;
      provider?: string;
      system_fingerprint?: string;
      native_finish_reason?: string;
    };
    logger.info(
      {
        model: req.modelId,
        ms: Date.now() - start,
        tokens: data.usage?.total_tokens,
        underlying_provider: data.provider, // logged for debugging, NOT returned
      },
      'openrouter_ok'
    );
    // White-label: strip every field that reveals the underlying provider
    // (Azure / Anthropic / DeepInfra / etc.) before returning to the client.
    // Owner-acknowledged strategy: AIAG is presented as a self-contained
    // platform; users must not see "provider":"Azure" in their responses.
    const usage = {
      prompt_tokens: data.usage?.prompt_tokens ?? 0,
      completion_tokens: data.usage?.completion_tokens ?? 0,
      total_tokens: data.usage?.total_tokens ?? 0,
    };
    const cleaned = { ...data, usage };
    delete (cleaned as Record<string, unknown>).provider;
    delete (cleaned as Record<string, unknown>).system_fingerprint;
    if (Array.isArray(cleaned.choices)) {
      cleaned.choices = cleaned.choices.map((ch) => {
        const c = { ...ch } as Record<string, unknown>;
        delete c.native_finish_reason;
        if (c.message && typeof c.message === 'object') {
          const m = { ...(c.message as Record<string, unknown>) };
          delete m.reasoning; // OpenRouter-specific field
          c.message = m;
        }
        return c as typeof ch;
      });
    }
    return cleaned;
  },

  async *chatStream(req: ChatRequest): AsyncIterable<unknown> {
    const apiKey = selectKey(req.byokKey);
    if (!apiKey) {
      logger.warn({ model: req.modelId }, 'openrouter_apikey_missing');
      throw new Error('model provider not configured');
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    };
    if (process.env.OPENROUTER_APP_URL) headers['http-referer'] = process.env.OPENROUTER_APP_URL;
    if (process.env.OPENROUTER_APP_NAME) headers['x-title'] = process.env.OPENROUTER_APP_NAME;

    const start = Date.now();
    const res = await fetchUpstream(
      `${OPENROUTER_BASE}/chat/completions`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: req.modelId,
          messages: req.messages,
          stream: true,
          temperature: req.temperature,
          max_tokens: req.max_tokens,
        }),
        allowlist: OPENROUTER_ALLOWLIST,
      },
      req.egressProxyUrl,
    );
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      logger.warn(
        { status: res.status, model: req.modelId, body: text.slice(0, 500) },
        'openrouter_stream_error'
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
      logger.warn({ model: req.modelId }, 'openrouter_apikey_missing');
      throw new Error('model provider not configured');
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    };
    if (process.env.OPENROUTER_APP_URL) headers['http-referer'] = process.env.OPENROUTER_APP_URL;
    if (process.env.OPENROUTER_APP_NAME) headers['x-title'] = process.env.OPENROUTER_APP_NAME;

    const start = Date.now();
    const res = await fetchUpstream(
      `${OPENROUTER_BASE}/embeddings`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: req.modelId, input: req.input }),
        allowlist: OPENROUTER_ALLOWLIST,
      },
      req.egressProxyUrl,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn(
        { status: res.status, model: req.modelId, body: text.slice(0, 500) },
        'openrouter_embeddings_error'
      );
      throw upstreamHttpError(res.status);
    }
    const data = (await res.json()) as {
      data?: Array<{ embedding: number[]; index?: number }>;
      usage?: { prompt_tokens?: number; total_tokens?: number };
    };
    logger.info(
      { model: req.modelId, ms: Date.now() - start, count: data.data?.length ?? 0 },
      'openrouter_embeddings_ok'
    );
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
