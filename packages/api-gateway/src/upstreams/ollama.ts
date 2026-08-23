// packages/api-gateway/src/upstreams/ollama.ts
/**
 * Ollama Cloud upstream — OpenAI-compatible /chat/completions endpoint.
 * Reads OLLAMA_CLOUD_URL and OLLAMA_CLOUD_API_KEY from env.
 */
import type {
  UpstreamAdapter,
  ChatRequest,
  ChatResponse,
  EmbeddingsRequest,
  EmbeddingsResponse,
} from './interface';
import { logger } from '../lib/logger';
import { upstreamHttpError } from '../lib/client-errors';
import { fetchUpstream } from './fetch-upstream';

function getBaseUrl(): string {
  const url = process.env.OLLAMA_CLOUD_URL;
  if (!url) {
    logger.warn({}, 'ollama_url_missing');
    throw new Error('model provider not configured');
  }
  return url;
}

// OLLAMA_CLOUD_URL is operator-configured (may be an internal / plain-http
// host in self-hosted setups). Allowlist exactly that host so safeFetch
// accepts what worked before T2 — the operator vetted this endpoint by
// configuring it.
function allowlistFor(baseUrl: string): string[] {
  try {
    const u = new URL(baseUrl);
    const host = u.hostname.toLowerCase();
    return [u.port ? `${host}:${u.port}` : host];
  } catch {
    return [];
  }
}

export const ollamaUpstream: UpstreamAdapter = {
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const baseUrl = getBaseUrl();
    const apiKey = req.byokKey ?? process.env.OLLAMA_CLOUD_API_KEY;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;

    // Ollama Cloud is OpenAI-compatible — use /v1/chat/completions, not /api/chat
    const res = await fetchUpstream(
      `${baseUrl}/v1/chat/completions`,
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
        allowlist: allowlistFor(baseUrl),
      },
      req.egressProxyUrl,
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      logger.warn({ status: res.status, body: txt }, 'ollama_chat_error');
      throw upstreamHttpError(res.status);
    }
    const data = await res.json() as {
      id?: string;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    return {
      id: (data as { id?: string }).id ?? `ollama-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: req.modelId,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: data.choices?.[0]?.message?.content ?? '' },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: data.usage?.prompt_tokens ?? 0,
        completion_tokens: data.usage?.completion_tokens ?? 0,
        total_tokens: data.usage?.total_tokens ?? ((data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0)),
      },
    };
  },

  async embeddings(req: EmbeddingsRequest): Promise<EmbeddingsResponse> {
    const baseUrl = getBaseUrl();
    const apiKey = req.byokKey ?? process.env.OLLAMA_CLOUD_API_KEY;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;

    // Native Ollama embeddings: POST /api/embeddings with { model, prompt }
    // returns { embedding: number[] } for a single input. The OpenAI shape
    // accepts string | string[], so we fan out array inputs sequentially and
    // re-assemble into the standard {object:'list', data:[...]} envelope.
    const inputs = Array.isArray(req.input) ? req.input : [req.input];

    const data: EmbeddingsResponse['data'] = [];
    for (let i = 0; i < inputs.length; i++) {
      const res = await fetchUpstream(
        `${baseUrl}/api/embeddings`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ model: req.modelId, prompt: inputs[i] }),
          allowlist: allowlistFor(baseUrl),
        },
        req.egressProxyUrl,
      );
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        logger.warn({ status: res.status, body: txt }, 'ollama_embeddings_error');
        throw upstreamHttpError(res.status);
      }
      const json = (await res.json()) as { embedding?: number[] };
      data.push({ object: 'embedding', embedding: json.embedding ?? [], index: i });
    }

    return {
      object: 'list',
      model: req.modelId,
      data,
      // Ollama's /api/embeddings does not report token usage.
      usage: { prompt_tokens: 0, total_tokens: 0 },
    };
  },
};
