import { beforeEach, expect, it, vi } from 'vitest';
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../lib/db', () => ({ sql: query }));
import {
  normalizeStoredChatFreshPolicy,
  evaluateStoredChatFreshPolicy,
  prepareStoredChatFreshPolicy,
} from '../billing/stored-chat-fresh-policy';
import { captureStoredChatHttpIdentity } from '../billing/stored-chat-http-identity';
import type { AuthenticatedApiKey } from '../middleware/auth-plan04';
import type { ResolvedModel } from '../routing/resolver';
const key = (policies: Record<string, unknown> = {}): AuthenticatedApiKey => ({
  id: 'key',
  org_id: 'org',
  policies,
  rpm_limit: 10,
  batch_rpm_limit: 1,
  daily_usd_cap: null,
  model_whitelist: [],
  ru_residency_only: false,
});
const identity = (text = 'hi') =>
  captureStoredChatHttpIdentity({
    body: {
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: text }],
    },
    idempotencyKey: 'key',
    declaredSessionId: null,
  });
const candidate = (ru: boolean) => ({
  id: ru ? 'ru' : 'nonru',
  provider: ru ? 'ru' : 'foreign',
  upstream_id: 'openrouter',
  upstream_model_id: 'openai/gpt-4o-mini',
  ru_residency: ru,
  price_per_1k_input: 1,
  price_per_1k_output: 1,
  markup: 1,
  latency_p50_ms: 1,
  uptime: 1,
});
const model = (): ResolvedModel => ({
  slug: 'openai/gpt-4o-mini',
  type: 'chat',
  candidates: [candidate(false), candidate(true)],
});
const prepare = (k = key(), text = 'hi', m = model()) =>
  prepareStoredChatFreshPolicy({
    key: k,
    identity: identity(text),
    model: m,
    requestId: 'trace',
  });
beforeEach(() => {
  query.mockReset().mockResolvedValue([]);
});
it('exports the same strict detached policy seam used by request preparation', () => {
  const policies = {
    default_mode: 'cheapest',
    allowed_providers: ['foreign'],
    forbid_non_ru: false,
  };
  const source = key(policies);
  const normalized = normalizeStoredChatFreshPolicy(source);
  policies.allowed_providers.push('ru');
  source.model_whitelist!.push('other');
  expect(normalized).toEqual({
    policy: {
      default_mode: 'cheapest',
      allowed_providers: ['foreign'],
      forbid_non_ru: false,
    },
    whitelist: [],
  });
  expect(Object.isFrozen(normalized)).toBe(true);
  expect(Object.isFrozen(normalized.policy.allowed_providers)).toBe(true);
  expect(prepare(key({ default_mode: 'cheapest' })).requestedMode).toBe(
    normalized.policy.default_mode,
  );
});
it('defaults auto, detached frozen policy and nullable session remain valid', () => {
  const result = prepare();
  expect(result.requestedMode).toBe('auto');
  expect(result.model.candidates).toHaveLength(2);
  expect(Object.isFrozen(result.model.candidates)).toBe(true);
  expect(Object.isFrozen(result.policy)).toBe(true);
});
it.each([
  { unknown: true },
  { default_mode: 'other' },
  { default_mode: null },
  { allowed_providers: [1] },
  { allowed_providers: [''] },
  { blocked_providers: 'foreign' },
  { forbid_non_ru: 0 },
  { allow_pii_transborder: 'true' },
  { forbid_streaming_prompts: null },
  { per_session_budget_cap_rub: 1 },
  { per_session_budget_cap_rub: '0.01' },
  { per_session_budget_cap_rub: -1 },
  { per_session_budget_cap_rub: '0e0' },
])('rejects malformed/unsupported policy %j', (p) => {
  expect(() => prepare(key(p))).toThrow('KEY_POLICY_UNAVAILABLE');
});
it.each([null, 0, '0', '0.000'])(
  'accepts exact absent/null/zero legacy cap %j',
  (cap) => {
    expect(
      prepare(key({ per_session_budget_cap_rub: cap })).requestedMode,
    ).toBe('auto');
  },
);
it('rejects accessors without evaluating them and missing mandatory top-level fields', () => {
  const getter = vi.fn();
  const k = key(
    Object.defineProperty({}, 'default_mode', {
      get: getter,
      enumerable: true,
    }),
  );
  expect(() => prepare(k)).toThrow('KEY_POLICY_UNAVAILABLE');
  expect(getter).not.toHaveBeenCalled();
  const missing = key();
  delete missing.model_whitelist;
  expect(() => prepare(missing)).toThrow('KEY_POLICY_UNAVAILABLE');
  delete (missing as Partial<AuthenticatedApiKey>).ru_residency_only;
  expect(() => prepare(missing)).toThrow('KEY_POLICY_UNAVAILABLE');
});
it('enforces exact whitelist and block wins with no candidate fallback', () => {
  expect(() => prepare({ ...key(), model_whitelist: ['alias'] })).toThrow(
    'MODEL_NOT_ALLOWED',
  );
  expect(
    prepare(
      key({
        allowed_providers: ['ru', 'foreign'],
        blocked_providers: ['foreign'],
      }),
    ).model.candidates.map((c) => c.provider),
  ).toEqual(['ru']);
  expect(() =>
    prepare(key({ allowed_providers: ['ru'], blocked_providers: ['ru'] })),
  ).toThrow('STORED_CHAT_UNAVAILABLE');
});
it('top-level RU is stronger than policy false, explicit mode and PII allowance', () => {
  const result = prepare({
    ...key({
      forbid_non_ru: false,
      allow_pii_transborder: true,
      default_mode: 'fastest',
    }),
    ru_residency_only: true,
  });
  expect(result.policy.forbid_non_ru).toBe(true);
  expect(result.model.candidates.every((c) => c.ru_residency)).toBe(true);
});
it('pure evaluator applies the same PII/provider decision without telemetry writes', () => {
  const id = identity('mail alice@example.com');
  const result = evaluateStoredChatFreshPolicy({ key: key(), identity: id, model: model() });
  expect(result.model.candidates.map((c) => c.provider)).toEqual(['ru']);
  expect(result.requestedMode).toBe('auto');
  expect(query).not.toHaveBeenCalled();
});

it('PII removes non-RU candidates from mixed pool and hashes bounded telemetry', () => {
  const result = prepare(key(), 'mail alice@example.com');
  expect(result.model.candidates.map((c) => c.provider)).toEqual(['ru']);
  expect(query).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(query.mock.calls)).not.toContain('alice@example.com');
});
it('blocking PII without eligible RU pool returns fixed policy denial', () => {
  expect(() =>
    prepare(key(), 'alice@example.com', {
      ...model(),
      candidates: [candidate(false)],
    }),
  ).toThrow('PII_TRANSBORDER_BLOCKED');
});
it('FIO warns only; explicit allow permits transborder; telemetry failure is best effort', () => {
  query.mockImplementation(() => {
    throw new Error('diagnostic');
  });
  expect(prepare(key(), 'Иван Иванов').model.candidates).toHaveLength(2);
  expect(
    prepare(key({ allow_pii_transborder: true }), 'alice@example.com').model
      .candidates,
  ).toHaveLength(2);
});
