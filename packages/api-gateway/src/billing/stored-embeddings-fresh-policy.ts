import { sql } from '../lib/db';
import { detectPii, sha256 } from '../lib/pii';
import type { AuthenticatedApiKey } from '../middleware/auth-plan04';
import type { ApiKeyPolicies, Mode } from '../routing/engine';
import type { ResolvedModel } from '../routing/resolver';
import { normalizeStoredChatFreshPolicy } from './stored-chat-fresh-policy';
import type { StoredEmbeddingsHttpIdentity } from './stored-embeddings-http-identity';
import type { StoredEmbeddingsHttpErrorKind } from './stored-embeddings-http-contract';

export class StoredEmbeddingsFreshPolicyError extends Error {
  constructor(readonly kind: Extract<StoredEmbeddingsHttpErrorKind,
    'key_policy_unavailable' | 'model_not_allowed' | 'pii_transborder_blocked' | 'stored_embeddings_unavailable'>) {
    super(kind.toUpperCase());
  }
}

/** Fresh preparation only; the durable replay read must happen before this function. */
export function prepareStoredEmbeddingsFreshPolicy(args: Readonly<{
  key: AuthenticatedApiKey;
  identity: StoredEmbeddingsHttpIdentity;
  model: ResolvedModel;
  requestId: string;
}>): Readonly<{ model: ResolvedModel; policy: Readonly<ApiKeyPolicies>; requestedMode: Mode }> {
  let normalized: ReturnType<typeof normalizeStoredChatFreshPolicy>;
  try { normalized = normalizeStoredChatFreshPolicy(args.key); }
  catch { throw new StoredEmbeddingsFreshPolicyError('key_policy_unavailable'); }
  const { policy, whitelist } = normalized;
  const slug = args.identity.attemptBody.model;
  if (whitelist.length && !whitelist.includes(slug))
    throw new StoredEmbeddingsFreshPolicyError('model_not_allowed');
  const requestedMode = args.identity.requestedMode ?? policy.default_mode ?? 'auto';
  let candidates = args.model.candidates.filter((candidate) =>
    (!policy.allowed_providers?.length || policy.allowed_providers.includes(candidate.provider)) &&
    !policy.blocked_providers?.includes(candidate.provider) &&
    (!(policy.forbid_non_ru || requestedMode === 'ru-only') || candidate.ru_residency === true));
  if (!candidates.length)
    throw new StoredEmbeddingsFreshPolicyError('stored_embeddings_unavailable');

  const hits = args.identity.attemptBody.input.flatMap((input) => detectPii(input));
  const restrictPii = !policy.allow_pii_transborder && hits.some((hit) => hit.blocking);
  if (restrictPii) candidates = candidates.filter((candidate) => candidate.ru_residency === true);
  const blocked = restrictPii && !candidates.length;
  for (const hit of hits.slice(0, 32)) {
    const action = blocked && hit.blocking ? 'block' : hit.blocking ? 'pass' : 'warn';
    try {
      void sql`INSERT INTO pii_detections (org_id, request_id, kind, sample_hash, action, model_slug)
        VALUES (${args.key.org_id}::uuid, ${args.requestId}, ${hit.kind}, ${sha256(hit.sample)}, ${action}, ${slug})`.catch(() => {});
    } catch { /* Best-effort telemetry never changes admission. */ }
  }
  if (blocked) throw new StoredEmbeddingsFreshPolicyError('pii_transborder_blocked');
  return Object.freeze({
    policy: Object.freeze(policy),
    requestedMode,
    model: Object.freeze({ ...args.model, candidates: Object.freeze(
      candidates.map((candidate) => Object.freeze({ ...candidate })),
    ) as unknown as ResolvedModel['candidates'] }),
  });
}
