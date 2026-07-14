/**
 * White-label regression coverage (SECURITY.md: the upstream provider name
 * must never reach the client). Covers the two hot-path leak fixes:
 *  - streaming/scrub.ts: SSE chunks strip provider-revealing fields.
 *  - lib/client-errors.ts: upstream HTTP failures map to brand-neutral
 *    AiagErrors that still preserve retryable status codes (429 stays 429).
 */
import { describe, it, expect } from 'vitest';
import { stripUpstreamFields } from '../streaming/scrub';
import { upstreamHttpError, NEUTRAL_MESSAGES } from '../lib/client-errors';
import { AiagError } from '../lib/errors';

describe('stripUpstreamFields', () => {
  it('removes top-level provider-revealing fields', () => {
    const chunk = {
      id: 'gen-1',
      object: 'chat.completion.chunk',
      provider: 'Azure',
      system_fingerprint: 'fp_abc123',
      x_groq: { id: 'req_123' },
      choices: [],
    };
    const cleaned = stripUpstreamFields(chunk);
    expect(cleaned).not.toHaveProperty('provider');
    expect(cleaned).not.toHaveProperty('system_fingerprint');
    expect(cleaned).not.toHaveProperty('x_groq');
    // OpenAI-compatible envelope shape stays intact.
    expect(cleaned.id).toBe('gen-1');
    expect(cleaned.object).toBe('chat.completion.chunk');
  });

  it('removes native_finish_reason and delta/message.reasoning per choice', () => {
    const chunk = {
      choices: [
        {
          index: 0,
          delta: { content: 'hi', reasoning: 'internal upstream CoT' },
          native_finish_reason: 'STOP',
          finish_reason: null,
        },
        {
          index: 0,
          message: { role: 'assistant', content: 'hi', reasoning: 'internal upstream CoT' },
          native_finish_reason: 'STOP',
          finish_reason: 'stop',
        },
      ],
    };
    const cleaned = stripUpstreamFields(chunk) as typeof chunk;
    for (const choice of cleaned.choices) {
      expect(choice).not.toHaveProperty('native_finish_reason');
      if ('delta' in choice) expect(choice.delta).not.toHaveProperty('reasoning');
      if ('message' in choice) expect((choice as any).message).not.toHaveProperty('reasoning');
    }
    // Content + finish_reason (the fields OpenAI-compatible clients read) survive.
    expect(cleaned.choices[0].delta?.content).toBe('hi');
    expect(cleaned.choices[1].finish_reason).toBe('stop');
  });

  it('is a no-op on a chunk with no leak fields (e.g. the [DONE]-adjacent shape)', () => {
    const chunk = { id: 'x', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] };
    const cleaned = stripUpstreamFields(structuredClone(chunk));
    expect(cleaned).toEqual(chunk);
  });
});

describe('upstreamHttpError', () => {
  it('preserves 429 (rate limit) status and uses a neutral message', () => {
    const e = upstreamHttpError(429);
    expect(e).toBeInstanceOf(AiagError);
    expect(e.status).toBe(429);
    expect(e.message.toLowerCase()).not.toContain('openrouter');
    expect(e.message.toLowerCase()).not.toContain('kie');
    expect(e.message.toLowerCase()).not.toContain('gonka');
  });

  it('maps 503/504 to a neutral "temporarily unavailable" 503', () => {
    expect(upstreamHttpError(503).status).toBe(503);
    expect(upstreamHttpError(504).status).toBe(503);
    expect(upstreamHttpError(503).message).toBe(NEUTRAL_MESSAGES.unavailable);
  });

  it('maps 529 to overloaded (529)', () => {
    expect(upstreamHttpError(529).status).toBe(529);
  });

  it('falls back to a neutral 502 for any other upstream failure status', () => {
    const e = upstreamHttpError(500);
    expect(e.status).toBe(502);
    expect(e.message).toBe(NEUTRAL_MESSAGES.providerError);
  });
});
