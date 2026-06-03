/**
 * Gonka upstream — implements the gateway's UpstreamAdapter contract by calling
 * GonkaGate's OpenAI-compatible /chat/completions endpoint.
 *
 * GonkaGate (https://api.gonkagate.com/v1) is an OpenAI-compatible broker; this
 * adapter is a copy of the OpenRouter adapter retargeted at that base URL.
 *
 * Reads system key from process.env.GONKA_API_KEY (left undefined if unset — the
 * adapter does NOT crash at module load; getUpstream() only returns it when the
 * key is present, otherwise routing falls back to the mock upstream).
 * If `byokKey` is supplied per-request, that key takes precedence (BYOK).
 *
 * White-label is a HARD rule (same as kie/openrouter): user-facing errors must
 * NEVER leak the upstream brand. Thrown errors use a neutral `upstream error N`
 * label; the real provider name appears only in server-side structured logs.
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
import { safeFetch } from '@aiag/shared';
import { logger } from '../lib/logger';

const GONKA_BASE = 'https://api.gonkagate.com/v1';
// safeFetch allowlist: GonkaGate is the only host this adapter ever talks to.
const GONKA_ALLOWLIST = ['api.gonkagate.com'];

function selectKey(byok?: string): string | undefined {
  return byok || process.env.GONKA_API_KEY;
}

export const gonkaUpstream: UpstreamAdapter = {
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const apiKey = selectKey(req.byokKey);
    if (!apiKey) throw new Error('GONKA_API_KEY not configured');
    const headers: Record<string, string> = {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    };

    const body = JSON.stringify({
      model: req.modelId,
      messages: req.messages,
      stream: false,
      temperature: req.temperature,
      max_tokens: req.max_tokens,
    });

    const start = Date.now();
    const res = await safeFetch(`${GONKA_BASE}/chat/completions`, {
      method: 'POST',
      headers,
      body,
      allowlist: GONKA_ALLOWLIST,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // Server-side log keeps the real provider + body for debugging.
      logger.warn(
        { status: res.status, model: req.modelId, body: text.slice(0, 500) },
        'gonka_upstream_error'
      );
      // White-label: the thrown (user-facing) error MUST NOT reveal the brand
      // or the raw upstream body — neutral status only.
      throw new Error(`upstream error ${res.status}`);
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
      'gonka_ok'
    );
    // White-label: strip every field that reveals the underlying provider
    // before returning to the client (same rule as openrouter/kie).
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
          delete m.reasoning;
          c.message = m;
        }
        return c as typeof ch;
      });
    }
    return cleaned;
  },

  async *chatStream(req: ChatRequest): AsyncIterable<unknown> {
    const apiKey = selectKey(req.byokKey);
    if (!apiKey) throw new Error('GONKA_API_KEY not configured');
    const headers: Record<string, string> = {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    };

    const res = await safeFetch(`${GONKA_BASE}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: req.modelId,
        messages: req.messages,
        stream: true,
        temperature: req.temperature,
        max_tokens: req.max_tokens,
      }),
      allowlist: GONKA_ALLOWLIST,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      logger.warn(
        { status: res.status, model: req.modelId, body: text.slice(0, 500) },
        'gonka_stream_error'
      );
      // White-label: neutral status only, no brand / no raw body.
      throw new Error(`upstream error ${res.status}`);
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
    if (!apiKey) throw new Error('GONKA_API_KEY not configured');
    const headers: Record<string, string> = {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    };

    const start = Date.now();
    const res = await safeFetch(`${GONKA_BASE}/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: req.modelId, input: req.input }),
      allowlist: GONKA_ALLOWLIST,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn(
        { status: res.status, model: req.modelId, body: text.slice(0, 500) },
        'gonka_embeddings_error'
      );
      // White-label: neutral status only, no brand / no raw body.
      throw new Error(`upstream error ${res.status}`);
    }
    const data = (await res.json()) as {
      data?: Array<{ embedding: number[]; index?: number }>;
      usage?: { prompt_tokens?: number; total_tokens?: number };
    };
    logger.info(
      { model: req.modelId, ms: Date.now() - start, count: data.data?.length ?? 0 },
      'gonka_embeddings_ok'
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
