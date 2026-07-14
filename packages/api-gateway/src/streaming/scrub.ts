/**
 * White-label scrubber for the SSE hot path.
 *
 * The non-stream `chat()` adapters (openrouter.ts / gonka.ts / groq.ts)
 * already strip provider-revealing fields before returning a response.
 * `chatStream()` yields upstream chunks straight from the wire — this
 * closes the same hole on the streaming path, at the one place all of
 * them are proxied to the client (streaming/sse.ts).
 *
 * Mutates in place (no clone, no extra JSON pass) — this runs per-chunk
 * on a hot path.
 */
const TOP_LEVEL_LEAK_FIELDS = ['provider', 'system_fingerprint', 'x_groq'] as const;
const CHOICE_LEAK_FIELDS = ['native_finish_reason'] as const;

export function stripUpstreamFields(chunk: Record<string, unknown>): Record<string, unknown> {
  for (const f of TOP_LEVEL_LEAK_FIELDS) delete chunk[f];

  const choices = chunk.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!choice || typeof choice !== 'object') continue;
      const c = choice as Record<string, unknown>;
      for (const f of CHOICE_LEAK_FIELDS) delete c[f];
      const delta = c.delta;
      if (delta && typeof delta === 'object') {
        delete (delta as Record<string, unknown>).reasoning;
      }
      const message = c.message;
      if (message && typeof message === 'object') {
        delete (message as Record<string, unknown>).reasoning;
      }
    }
  }
  return chunk;
}
