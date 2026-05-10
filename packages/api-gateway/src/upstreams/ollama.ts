// packages/api-gateway/src/upstreams/ollama.ts
/**
 * Ollama Cloud upstream — OpenAI-compatible /chat/completions endpoint.
 * Reads OLLAMA_CLOUD_URL and OLLAMA_CLOUD_API_KEY from env.
 */
import type { UpstreamAdapter, ChatRequest, ChatResponse, EmbeddingsRequest } from './interface';
import { logger } from '../lib/logger';

function getBaseUrl(): string {
  const url = process.env.OLLAMA_CLOUD_URL;
  if (!url) throw new Error('OLLAMA_CLOUD_URL not configured');
  return url;
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
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: req.modelId,
        messages: req.messages,
        stream: false,
        ...(req.temperature !== undefined && { temperature: req.temperature }),
        ...(req.max_tokens !== undefined && { max_tokens: req.max_tokens }),
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      logger.warn({ status: res.status, body: txt }, 'ollama_chat_error');
      throw new Error(`Ollama ${res.status}: ${txt.slice(0, 200)}`);
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

  async embeddings(_req: EmbeddingsRequest) {
    throw new Error('Ollama Cloud embeddings not implemented');
  },
};
