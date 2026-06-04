import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getUpstream } from '../upstreams/registry';
import { mockUpstream } from '../upstreams/mock';
import { AiagError } from '../lib/errors';

/**
 * P0 mock-billing footgun guard: a provider with a MISSING key must FAIL CLEAN
 * (throw a neutral AiagError), NOT silently return the billable mock. The mock is
 * served ONLY when AIAG_FORCE_MOCK=1 (CI/local escape hatch). A configured key
 * still returns the real adapter.
 */
describe('getUpstream — missing-key fail-clean (no billable mock)', () => {
  // Snapshot + restore the env we mutate so tests don't leak into each other.
  const KEYS = [
    'AIAG_FORCE_MOCK',
    'OPENROUTER_API_KEY',
    'KIE_API_KEY',
    'OLLAMA_CLOUD_URL',
    'GROQ_API_KEY',
    'GONKA_API_KEY',
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('throws a neutral AiagError (NOT mock) when the provider key is absent', () => {
    for (const p of ['openrouter', 'kie', 'ollama', 'groq', 'gonka']) {
      let thrown: unknown;
      try {
        getUpstream(p);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, `provider ${p} should throw`).toBeInstanceOf(AiagError);
      const err = thrown as AiagError;
      expect(err.status).toBe(503);
      // White-label: the message must NOT leak an upstream brand.
      expect(err.message).toBe('upstream unavailable');
      expect(err.message).not.toMatch(/openrouter|kie|ollama|groq|gonka/i);
    }
  });

  it('throws (NOT mock) for an unknown provider (default case)', () => {
    expect(() => getUpstream('definitely-not-a-provider')).toThrow(AiagError);
  });

  it('returns the mock when AIAG_FORCE_MOCK=1 (CI/local escape hatch)', () => {
    process.env.AIAG_FORCE_MOCK = '1';
    expect(getUpstream('openrouter')).toBe(mockUpstream);
    expect(getUpstream('gonka')).toBe(mockUpstream);
    expect(getUpstream('definitely-not-a-provider')).toBe(mockUpstream);
  });

  it('returns the real adapter (NOT mock) when the key is present', () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    const up = getUpstream('openrouter');
    expect(up).not.toBe(mockUpstream);
    // sanity: it is a real adapter with a chat() method
    expect(typeof up.chat).toBe('function');
  });
});
