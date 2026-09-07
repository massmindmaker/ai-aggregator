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
  AdmittedChatMechanics,
  AdmittedChatRequest,
} from './interface';
import { fetchUpstream } from './fetch-upstream';
import { z } from 'zod';
import { findReviewedChatProfile } from '../billing/reviewed-token-profiles';
import { logger } from '../lib/logger';
import { upstreamHttpError } from '../lib/client-errors';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
// safeFetch allowlist: OpenRouter is the only host this adapter ever talks to.
const OPENROUTER_ALLOWLIST = ['openrouter.ai'];

function selectKey(byok?: string): string | undefined {
  return byok || process.env.OPENROUTER_API_KEY;
}

export class AdmittedChatError extends Error {
  constructor(readonly code: 'INVALID_ADMITTED_REQUEST' | 'INVALID_ADMITTED_RESPONSE') {
    super(code === 'INVALID_ADMITTED_REQUEST' ? 'Invalid admitted chat request' : 'Invalid admitted chat response');
    this.name = 'AdmittedChatError';
  }
}
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const admittedRequest = z.object({
  modelId: z.literal('openai/gpt-4o-mini'),
  messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }).strict()).min(1),
  maxTokens: count.positive().max(16384),
  endpointPolicy: z.object({ only: z.tuple([z.literal('openai')]), allowFallbacks: z.literal(false), requireParameters: z.literal(true) }).strict(),
  byokKey: z.string().optional(),
  egressProxyUrl: z.string().optional(),
}).strict();
const admittedResponse = z.object({
  id: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/),
  object: z.literal('chat.completion'),
  created: count,
  model: z.string().min(1).max(256).regex(/^[A-Za-z0-9_./:@+-]+$/),
  choices: z.array(z.object({
    index: z.literal(0),
    message: z.object({ role: z.literal('assistant'), content: z.string().nullable(), tool_calls: z.array(z.never()).length(0).nullable().optional(), function_call: z.null().optional() }),
    finish_reason: z.enum(['stop', 'length', 'content_filter']),
  })).length(1),
  usage: z.object({
    prompt_tokens: count, completion_tokens: count, total_tokens: count,
    prompt_tokens_details: z.object({ cached_tokens: count.optional() }).optional(),
  }).refine(u => Number.isSafeInteger(u.prompt_tokens + u.completion_tokens)
    && u.total_tokens === u.prompt_tokens + u.completion_tokens
    && (u.prompt_tokens_details?.cached_tokens ?? 0) <= u.prompt_tokens),
});

const admittedChat: AdmittedChatMechanics = Object.freeze({
  contract: 'openrouter-pinned-provider-chat-v1',
  async execute(input: AdmittedChatRequest) {
    // Parse a detached body before the first await. Caller mutation cannot change dispatch.
    const parsed = admittedRequest.safeParse(input);
    if (!parsed.success) throw new AdmittedChatError('INVALID_ADMITTED_REQUEST');
    const req = parsed.data;
    const profile = findReviewedChatProfile({ modelSlug: req.modelId, modelType: 'chat', upstreamId: 'openrouter', upstreamModelId: req.modelId, adapterKey: 'openrouter' });
    if (!profile || profile.adapterContract !== 'openrouter-pinned-provider-chat-v1' || req.maxTokens > Math.min(profile.contextWindowTokens, profile.maxOutputTokens)) {
      throw new AdmittedChatError('INVALID_ADMITTED_REQUEST');
    }
    const apiKey = selectKey(req.byokKey);
    if (!apiKey) throw new Error('model provider not configured');
    const headers: Record<string, string> = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
    if (process.env.OPENROUTER_APP_URL) headers['http-referer'] = process.env.OPENROUTER_APP_URL;
    if (process.env.OPENROUTER_APP_NAME) headers['x-title'] = process.env.OPENROUTER_APP_NAME;
    const res = await fetchUpstream(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST', headers, allowlist: OPENROUTER_ALLOWLIST,
      body: JSON.stringify({ model: profile.upstreamModelId, messages: req.messages, stream: false, max_tokens: req.maxTokens,
        provider: { only: profile.endpointPolicy.only, allow_fallbacks: profile.endpointPolicy.allowFallbacks, require_parameters: profile.endpointPolicy.requireParameters } }),
    }, req.egressProxyUrl);
    if (!res.ok) throw upstreamHttpError(res.status);
    let raw: unknown;
    try { raw = await res.json(); } catch { throw new AdmittedChatError('INVALID_ADMITTED_RESPONSE'); }
    const validated = admittedResponse.safeParse(raw);
    if (!validated.success) throw new AdmittedChatError('INVALID_ADMITTED_RESPONSE');
    const data = validated.data;
    const usage = Object.freeze({ promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens,
      totalTokens: data.usage.total_tokens, cachedInputTokens: data.usage.prompt_tokens_details?.cached_tokens ?? 0 });
    // Construct a positive allowlist DTO; no provider metadata, costs or reasoning escape.
    return { response: {
      id: data.id, object: data.object, created: data.created, model: data.model,
      choices: data.choices.map(c => ({ index: c.index, message: { role: c.message.role, content: c.message.content }, finish_reason: c.finish_reason })),
      usage: { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, total_tokens: usage.totalTokens },
    }, usage };
  },
});

export const openRouterUpstream: UpstreamAdapter = {
  admittedChat,
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
        sse: true,
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
