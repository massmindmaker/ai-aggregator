/**
 * F-3 (security review) — PII/transborder residency policy for the stored
 * media + transcription routes.
 *
 * Stored chat/embeddings/completions/batches were already closed correctly by
 * `evaluateChatPolicyInternal` (billing/stored-chat-fresh-policy.ts): when PII is
 * present and the key does not allow transborder PII, candidates are narrowed to
 * `ru_residency === true` and an empty pool is a hard block.
 *
 * `routes/v1/stored-media.ts` and `routes/v1/stored-transcription.ts` called
 * neither `detectPii` nor any fresh-policy helper — a prompt carrying an email
 * or an ИНН went straight to kie.ai (and audio to groq.com) under a key with the
 * DEFAULT policy. This module is the shared decision both routes now use.
 *
 * Fail-closed by construction: the only way to keep a non-RU candidate is an
 * explicit `allow_pii_transborder: true` on the key.
 */
import type { PiiHit } from '../lib/pii';
import type { ApiKeyPolicies } from '../routing/engine';

export class StoredMediaPiiError extends Error {
  /** Stable code mapped to 403 by the route. */
  readonly code = 'PII_TRANSBORDER_BLOCKED';
  constructor() {
    super('PII_TRANSBORDER_BLOCKED');
    this.name = 'StoredMediaPiiError';
  }
}

export type ResidencyCandidate = { readonly ru_residency: boolean };

export type ResidencyDecision<T extends ResidencyCandidate> = Readonly<{
  candidates: readonly T[];
  hits: readonly PiiHit[];
  /** True when PII forced the narrowing (i.e. the pool was actually filtered). */
  restricted: boolean;
}>;

export type ResidencyArgs<T extends ResidencyCandidate> = Readonly<{
  policy: ApiKeyPolicies;
  /** Text actually sent upstream. Empty for routes with no text payload. */
  text: string;
  /** PII hits for `text`. Callers pass `detectPii(text)`. */
  hits: readonly PiiHit[];
  candidates: readonly T[];
  /**
   * Set when the payload is personal data by nature (raw voice audio) and
   * cannot be scanned for PII patterns. Such payloads are treated as carrying
   * PII unconditionally rather than being waved through unscanned.
   */
  piiByConstruction?: boolean;
}>;

/**
 * Pure decision: narrow `candidates` to RU-resident ones when PII would cross
 * the border, and throw `StoredMediaPiiError` when nothing survives.
 */
export function evaluateResidencyPolicy<T extends ResidencyCandidate>(
  args: ResidencyArgs<T>
): ResidencyDecision<T> {
  const { policy, hits, candidates } = args;
  const allowTransborder = policy.allow_pii_transborder === true;
  const hasBlocking = hits.some((h) => h.blocking) || args.piiByConstruction === true;

  // No PII, or the key explicitly accepts transborder PII → untouched pool.
  if (!hasBlocking || allowTransborder) {
    return Object.freeze({
      candidates: Object.freeze([...candidates]),
      hits: Object.freeze([...hits]),
      restricted: false,
    });
  }

  const narrowed = candidates.filter((c) => c.ru_residency === true);
  if (narrowed.length === 0) throw new StoredMediaPiiError();
  return Object.freeze({
    candidates: Object.freeze(narrowed),
    hits: Object.freeze([...hits]),
    restricted: true,
  });
}