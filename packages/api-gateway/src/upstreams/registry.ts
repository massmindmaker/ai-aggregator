/**
 * Upstream registry: dispatches a resolved provider name to its concrete
 * UpstreamAdapter implementation.
 *
 * Selection order per provider:
 *  - "openrouter" → real OpenRouter API (requires OPENROUTER_API_KEY env)
 *  - "kie" / "ollama" / "groq" / "gonka" → their real adapter (each requires its key env)
 *
 * Missing-key footgun (FIXED): previously a provider with no key env fell back to
 * mockUpstream, which returns a DETERMINISTIC FAKE completion. The agent-worker
 * bills non-external runs off that response (estimate / gateway charge) → a
 * misconfigured/missing key silently served a fake answer the user PAID for. Now a
 * missing key (when NOT force-mock) FAILS CLEAN: it throws a typed neutral
 * AiagError (503, brand-neutral message). server.ts's app.onError serializes that
 * into a white-label `{error:{code,message}}` response; the worker then marks the
 * run failed (non-200 → throw → markFailed) and does NOT bill it (settleRun runs
 * only on success).
 *
 * Override knob:
 *  - AIAG_FORCE_MOCK=1 → always returns mock (CI / local without keys). The ONLY
 *    path that still serves the mock.
 */
import type { UpstreamAdapter } from './interface';
import { mockUpstream } from './mock';
import { openRouterUpstream } from './openrouter';
import { kieUpstream } from './kie';
import { ollamaUpstream } from './ollama';
import { groqUpstream } from './groq';
import { gonkaUpstream } from './gonka';
import { errors } from '../lib/errors';

/**
 * Neutral, white-label "this provider isn't configured / available" error.
 * 503 SERVICE_UNAVAILABLE, brand-neutral message — never names the upstream.
 */
function providerUnavailable(): never {
  throw errors.unavailable('upstream unavailable');
}

export function getUpstream(provider: string): UpstreamAdapter {
  if (process.env.AIAG_FORCE_MOCK === '1') return mockUpstream;
  switch (provider) {
    case 'openrouter':
      // Real adapter only when its key is configured; otherwise fail clean
      // (do NOT serve a billable mock).
      return process.env.OPENROUTER_API_KEY ? openRouterUpstream : providerUnavailable();
    case 'kie':
      return process.env.KIE_API_KEY ? kieUpstream : providerUnavailable();
    case 'ollama':
      return process.env.OLLAMA_CLOUD_URL ? ollamaUpstream : providerUnavailable();
    case 'groq':
      return process.env.GROQ_API_KEY ? groqUpstream : providerUnavailable();
    case 'gonka':
      return process.env.GONKA_API_KEY ? gonkaUpstream : providerUnavailable();
    default:
      // Unknown / unwired provider → fail clean (never a billable mock).
      return providerUnavailable();
  }
}
