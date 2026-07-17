import { describe, it, expect, vi, afterEach } from 'vitest';
import { shouldFallbackToDirectUpstream, callWithFallback } from '../agent-runner.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('no silent direct-upstream fallback', () => {
  it('🔴 402 (нет кредитов) — НЕ фолбэчить на прямой апстрим', () => {
    expect(shouldFallbackToDirectUpstream({ status: 402, code: 'insufficient_funds' })).toBe(false);
  });

  it('🔴 401/403 (ключ не принят) — НЕ фолбэчить: это утечка маржи + слом white-label', () => {
    expect(shouldFallbackToDirectUpstream({ status: 401, code: 'unauthorized' })).toBe(false);
    expect(shouldFallbackToDirectUpstream({ status: 403, code: 'forbidden' })).toBe(false);
  });

  it('🔴 402/401/403 не фолбэчат даже если текст тела ошибки упоминает модель (defense in depth)', () => {
    expect(
      shouldFallbackToDirectUpstream({ status: 402, text: '{"error":{"code":"model_not_found"}}' }),
    ).toBe(false);
    expect(
      shouldFallbackToDirectUpstream({ status: 401, text: 'no such model available' }),
    ).toBe(false);
    expect(
      shouldFallbackToDirectUpstream({ status: 403, text: 'Unknown model: x' }),
    ).toBe(false);
  });

  it('404 (модели нет у гейтвея) — легитимный кейс, фолбэк разрешён', () => {
    expect(shouldFallbackToDirectUpstream({ status: 404, text: 'model_not_found' })).toBe(true);
  });

  it('400 "Unknown model" (resolver.ts) — легитимный кейс, фолбэк разрешён', () => {
    expect(
      shouldFallbackToDirectUpstream({ status: 400, text: 'Unknown model: some/slug' }),
    ).toBe(true);
  });

  it('обычный 400 bad request без упоминания модели — НЕ фолбэчить', () => {
    expect(shouldFallbackToDirectUpstream({ status: 400, text: 'Bad request: missing field' })).toBe(
      false,
    );
  });

  it('502/503/429 — НЕ фолбэчить (не про отсутствие модели)', () => {
    expect(shouldFallbackToDirectUpstream({ status: 502, text: 'Upstream error' })).toBe(false);
    expect(shouldFallbackToDirectUpstream({ status: 503, text: 'Service unavailable' })).toBe(false);
    expect(shouldFallbackToDirectUpstream({ status: 429, text: 'Rate limit exceeded' })).toBe(false);
  });
});

describe('callWithFallback — end-to-end: TMA wallet=0 scenario (real gateway 402)', () => {
  const GATEWAY = 'http://127.0.0.1:4000/v1/chat/completions';

  it('🔴 gateway responds 402 PAYMENT_REQUIRED → throws an honest error, ' +
    'does NOT silently re-issue to OpenRouter, even though OPENROUTER_API_KEY is set', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'or_key_test');
    const fetchMock = vi.fn(async (url: string) => {
      if (url === GATEWAY) {
        return new Response(
          JSON.stringify({ error: { code: 'PAYMENT_REQUIRED', message: 'Insufficient funds' } }),
          { status: 402 },
        );
      }
      throw new Error('MUST NOT reach a second host (would be the silent OpenRouter fallback)');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      callWithFallback(
        { url: GATEWAY, apiKey: 'sk_aiag_tma', model: 'openai/gpt-4o-mini', isExternal: false },
        { model: 'openai/gpt-4o-mini', messages: [] },
      ),
    ).rejects.toThrow(/402/);
    // exactly one fetch — proves no silent second hop to any other host.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('🔴 gateway responds 401 UNAUTHORIZED (bad key) → throws, no fallback', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'or_key_test');
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } }), {
        status: 401,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      callWithFallback(
        { url: GATEWAY, apiKey: 'sk_aiag_bad', model: 'openai/gpt-4o-mini', isExternal: false },
        { model: 'openai/gpt-4o-mini', messages: [] },
      ),
    ).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
