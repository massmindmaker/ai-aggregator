/**
 * Brand-neutral, user-facing error vocabulary (SECURITY.md white-label rule:
 * the upstream provider name — OpenRouter / Kie / Gonka / Groq / Ollama —
 * must never reach the client).
 *
 * Real upstream status/body is still logged server-side via `logger.warn`
 * at the call site; only what crosses the wire to the client goes through
 * this module.
 */
import { errors, type AiagError } from './errors';

export const NEUTRAL_MESSAGES = {
  unavailable: 'Model temporarily unavailable',
  providerError: 'Model provider error',
  jobFailed: 'Model generation failed. Please try again.',
} as const;

/**
 * Maps a failed upstream HTTP response status to a brand-neutral AiagError,
 * preserving the retry semantics the status code carries (429 stays 429,
 * 503/504 stay "temporarily unavailable", 529 stays "overloaded") without
 * ever naming the upstream provider or forwarding its raw error body.
 */
export function upstreamHttpError(status: number): AiagError {
  if (status === 429) return errors.rateLimited(30);
  if (status === 503 || status === 504) return errors.unavailable(NEUTRAL_MESSAGES.unavailable);
  if (status === 529) return errors.overloaded();
  return errors.upstreamError(NEUTRAL_MESSAGES.providerError);
}
