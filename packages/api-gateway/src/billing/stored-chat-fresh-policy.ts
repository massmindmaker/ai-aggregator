import { sql } from '../lib/db';
import { detectPii, extractText, sha256 } from '../lib/pii';
import type { AuthenticatedApiKey } from '../middleware/auth-plan04';
import type { ApiKeyPolicies, Mode } from '../routing/engine';
import type { ResolvedModel } from '../routing/resolver';
import type { StoredChatHttpIdentity } from './stored-chat-http-identity';
import type { StoredChatHttpErrorKind } from './stored-chat-http-contract';

export class StoredChatFreshPolicyError extends Error {
  constructor(
    readonly kind: Extract<
      StoredChatHttpErrorKind,
      | 'key_policy_unavailable'
      | 'model_not_allowed'
      | 'pii_transborder_blocked'
      | 'stored_chat_unavailable'
    >,
  ) {
    super(kind.toUpperCase());
  }
}
function invalid(): never {
  throw new StoredChatFreshPolicyError('key_policy_unavailable');
}
const modes = ['auto', 'fastest', 'cheapest', 'balanced', 'ru-only'] as const;
const known = [
  'default_mode',
  'allowed_providers',
  'blocked_providers',
  'forbid_non_ru',
  'allow_pii_transborder',
  'per_session_budget_cap_rub',
  'forbid_streaming_prompts',
];

function plain(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.getOwnPropertySymbols(value).length
  )
    invalid();
  for (const d of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!d.enumerable || !('value' in d)) invalid();
  }
  return value as Record<string, unknown>;
}
function strings(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length ||
    Object.getOwnPropertyNames(value).length !== value.length + 1
  )
    invalid();
  const copy: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (
      !d ||
      !('value' in d) ||
      typeof d.value !== 'string' ||
      d.value.length === 0
    )
      invalid();
    copy.push(d.value);
  }
  return Object.freeze(copy) as unknown as string[];
}
export function normalizeStoredChatFreshPolicy(
  key: AuthenticatedApiKey,
): Readonly<{
  policy: Readonly<ApiKeyPolicies>;
  whitelist: readonly string[];
}> {
  // Read descriptors before values: even test-seam accessors must not execute.
  const data = plain(key);
  const p = plain(data.policies);
  if (Object.keys(p).some((name) => !known.includes(name))) invalid();
  const whitelist = strings(data.model_whitelist);
  if (typeof data.ru_residency_only !== 'boolean') invalid();
  const policy: ApiKeyPolicies = {};
  if (Object.hasOwn(p, 'default_mode')) {
    if (!modes.includes(p.default_mode as Mode)) invalid();
    policy.default_mode = p.default_mode as Mode;
  }
  for (const name of ['allowed_providers', 'blocked_providers'] as const) {
    if (Object.hasOwn(p, name)) policy[name] = strings(p[name]);
  }
  for (const name of [
    'forbid_non_ru',
    'allow_pii_transborder',
    'forbid_streaming_prompts',
  ] as const) {
    if (Object.hasOwn(p, name)) {
      if (typeof p[name] !== 'boolean') invalid();
      policy[name] = p[name];
    }
  }
  if (Object.hasOwn(p, 'per_session_budget_cap_rub')) {
    const cap = p.per_session_budget_cap_rub;
    if (
      cap !== null &&
      cap !== 0 &&
      !(typeof cap === 'string' && /^0(?:\.0+)?$/.test(cap))
    )
      invalid();
    // Exact zero carries no limit. SQL v2 alone owns authoritative session quota.
  }
  policy.forbid_non_ru =
    data.ru_residency_only || policy.forbid_non_ru === true;
  return Object.freeze({ policy: Object.freeze(policy), whitelist });
}

/** Fresh snapshot preparation only. No claim, admission, provider or legacy spending authority. */
export function prepareStoredChatFreshPolicy(
  args: Readonly<{
    key: AuthenticatedApiKey;
    identity: Pick<StoredChatHttpIdentity, 'requestedMode' | 'attemptBody'>;
    model: ResolvedModel;
    requestId: string;
  }>,
): Readonly<{
  model: ResolvedModel;
  policy: Readonly<ApiKeyPolicies>;
  requestedMode: Mode;
}> {
  const { policy, whitelist } = normalizeStoredChatFreshPolicy(args.key);
  const slug = args.identity.attemptBody.model;
  if (whitelist.length && !whitelist.includes(slug))
    throw new StoredChatFreshPolicyError('model_not_allowed');
  const requestedMode =
    args.identity.requestedMode ?? policy.default_mode ?? 'auto';
  if (args.identity.attemptBody.stream && policy.forbid_streaming_prompts)
    throw new StoredChatFreshPolicyError('stored_chat_unavailable');
  let candidates = args.model.candidates.filter(
    (c) =>
      (!policy.allowed_providers?.length ||
        policy.allowed_providers.includes(c.provider)) &&
      !policy.blocked_providers?.includes(c.provider) &&
      (!(policy.forbid_non_ru || requestedMode === 'ru-only') ||
        c.ru_residency === true),
  );
  if (!candidates.length)
    throw new StoredChatFreshPolicyError('stored_chat_unavailable');
  const hits = detectPii(extractText(args.identity.attemptBody));
  const restrictPii =
    !policy.allow_pii_transborder && hits.some((h) => h.blocking);
  if (restrictPii)
    candidates = candidates.filter((c) => c.ru_residency === true);
  const blocked = restrictPii && !candidates.length;
  // Body bytes are bounded by B2. Cap telemetry work separately; never persist samples or log failures.
  for (const h of hits.slice(0, 32)) {
    const action =
      blocked && h.blocking ? 'block' : h.blocking ? 'pass' : 'warn';
    try {
      void sql`INSERT INTO pii_detections (org_id, request_id, kind, sample_hash, action, model_slug)
        VALUES (${args.key.org_id}::uuid, ${args.requestId}, ${h.kind}, ${sha256(h.sample)}, ${action}, ${slug})`.catch(
        () => {},
      );
    } catch {
      /* Best-effort telemetry never changes admission eligibility. */
    }
  }
  if (blocked) throw new StoredChatFreshPolicyError('pii_transborder_blocked');
  const model = Object.freeze({
    ...args.model,
    candidates: Object.freeze(
      candidates.map((c) => Object.freeze({ ...c })),
    ) as unknown as ResolvedModel['candidates'],
  });
  return Object.freeze({ model, policy, requestedMode });
}
