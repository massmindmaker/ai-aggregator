import { beforeEach, expect, it, vi } from 'vitest';
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../lib/db', () => ({ sql: query }));
import { prepareStoredEmbeddingsFreshPolicy } from '../billing/stored-embeddings-fresh-policy';
import { captureStoredEmbeddingsHttpIdentity } from '../billing/stored-embeddings-http-identity';
import type { AuthenticatedApiKey } from '../middleware/auth-plan04';
import type { ResolvedModel } from '../routing/resolver';

const key = (policies: Record<string, unknown> = {}): AuthenticatedApiKey => ({
  id: 'key', org_id: 'org', policies, rpm_limit: 10, batch_rpm_limit: 1,
  daily_usd_cap: null, model_whitelist: [], ru_residency_only: false,
});
const identity = (input: readonly string[] = ['first', 'second']) => captureStoredEmbeddingsHttpIdentity({
  body: { model: 'openai/text-embedding-3-small', input }, idempotencyKey: 'key', declaredSessionId: null,
});
const candidate = (ru: boolean) => ({
  id: ru ? 'ru' : 'nonru', provider: ru ? 'ru' : 'foreign', upstream_id: 'openrouter',
  upstream_model_id: 'openai/text-embedding-3-small', ru_residency: ru,
  price_per_1k_input: 0.002, price_per_1k_output: 0, markup: 1.25, latency_p50_ms: 1, uptime: 1,
});
const model = (candidates = [candidate(false), candidate(true)]): ResolvedModel => ({
  slug: 'openai/text-embedding-3-small', type: 'embedding', candidates,
});
const prepare = (apiKey = key(), input?: readonly string[], resolved = model()) =>
  prepareStoredEmbeddingsFreshPolicy({ key: apiKey, identity: identity(input), model: resolved, requestId: 'trace' });
beforeEach(() => query.mockReset().mockResolvedValue([]));

it('keeps whitelist/provider/RU/default mode policy before admission', () => {
  expect(prepare(key({ default_mode: 'cheapest', blocked_providers: ['foreign'] })).model.candidates.map((c) => c.provider)).toEqual(['ru']);
  expect(prepare(key({ default_mode: 'cheapest' })).requestedMode).toBe('cheapest');
  expect(() => prepare({ ...key(), model_whitelist: ['other'] })).toThrow('MODEL_NOT_ALLOWED');
});

it('checks PII across every input, filters non-RU and stores hashes only', () => {
  const prepared = prepare(key(), ['innocent', 'alice@example.com']);
  expect(prepared.model.candidates.map((c) => c.provider)).toEqual(['ru']);
  expect(query).toHaveBeenCalledOnce();
  expect(JSON.stringify(query.mock.calls)).not.toContain('alice@example.com');
});

it('blocks PII when no reviewed RU candidate survives', () => {
  expect(() => prepare(key(), ['alice@example.com'], model([candidate(false)]))).toThrow('PII_TRANSBORDER_BLOCKED');
});

it('fails malformed key policies closed', () => {
  expect(() => prepare(key({ unknown: true }))).toThrow('KEY_POLICY_UNAVAILABLE');
  expect(() => prepare(key({ allowed_providers: ['missing'] }))).toThrow('STORED_EMBEDDINGS_UNAVAILABLE');
});
