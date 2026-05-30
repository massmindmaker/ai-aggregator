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
} from './interface';
import { logger } from '../lib/logger';

const GROQ_BASE = 'https://api.groq.com/openai/v1';

function selectKey(byok?: string): string | undefined {
  return byok || process.env.GROQ_API_KEY;
}

export const groqUpstream: UpstreamAdapter = {
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const apiKey = selectKey(req.byokKey);
    if (!apiKey) throw new Error('GROQ_API_KEY not configured');
    const headers: Record<string, string> = {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    };

    const start = Date.now();
    const res = await fetch(`${GROQ_BASE}/chat/completions`, {
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
      const text = await res.text().catch(() => '');
      logger.warn(
        { status: res.status, model: req.modelId, body: text.slice(0, 500) },
        'groq_upstream_error'
      );
      throw new Error(`Groq ${res.status}: ${text.slice(0, 200)}`);
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
    if (!apiKey) throw new Error('GROQ_API_KEY not configured');
    const headers: Record<string, string> = {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    };

    const res = await fetch(`${GROQ_BASE}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: req.modelId,
        messages: req.messages,
        stream: true,
        ...(req.temperature !== undefined && { temperature: req.temperature }),
        ...(req.max_tokens !== undefined && { max_tokens: req.max_tokens }),
      }),
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`Groq stream ${res.status}: ${text.slice(0, 200)}`);
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
    if (!apiKey) throw new Error('GROQ_API_KEY not configured');
    const res = await fetch(`${GROQ_BASE}/embeddings`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: req.modelId, input: req.input }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn(
        { status: res.status, model: req.modelId, body: text.slice(0, 500) },
        'groq_embeddings_error'
      );
      throw new Error(`Groq embeddings ${res.status}: ${text.slice(0, 200)}`);
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
