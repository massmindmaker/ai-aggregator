/**
 * Upstream registry: dispatches a resolved provider name to its concrete
 * UpstreamAdapter implementation. Falls back to mockUpstream for providers
 * that haven't been wired yet (yandex, fal, replicate, etc.).
 *
 * Selection order per provider:
 *  - "openrouter" → real OpenRouter API (requires OPENROUTER_API_KEY env)
 *  - everything else → mock (deterministic test response)
 *
 * Override knobs:
 *  - AIAG_FORCE_MOCK=1 → always returns mock (useful for CI/local without keys)
 */
import type { UpstreamAdapter } from './interface';
import { mockUpstream } from './mock';
import { openRouterUpstream } from './openrouter';
import { kieUpstream } from './kie';
import { ollamaUpstream } from './ollama';
import { groqUpstream } from './groq';

export function getUpstream(provider: string): UpstreamAdapter {
  if (process.env.AIAG_FORCE_MOCK === '1') return mockUpstream;
  switch (provider) {
    case 'openrouter':
      // Only use real adapter if a key is configured; otherwise mock.
      return process.env.OPENROUTER_API_KEY ? openRouterUpstream : mockUpstream;
    case 'kie':
      return process.env.KIE_API_KEY ? kieUpstream : mockUpstream;
    case 'ollama':
      return process.env.OLLAMA_CLOUD_URL ? ollamaUpstream : mockUpstream;
    case 'groq':
      return process.env.GROQ_API_KEY ? groqUpstream : mockUpstream;
    default:
      return mockUpstream;
  }
}
