import { beforeEach, expect, it, vi } from 'vitest';
const { query, redis } = vi.hoisted(() => ({ query: vi.fn(), redis: vi.fn() }));
vi.mock('../lib/db', () => ({ sql: query }));
vi.mock('../lib/redis', () => ({ makeRedis: redis }));
import { resolveStoredChatFreshModel } from '../routing/stored-chat-fresh-resolver';
const slug = 'openai/gpt-4o-mini';
const row = () => ({
  slug,
  type: 'chat',
  model_enabled: true,
  model_status: 'live',
  candidate_enabled: true,
  upstream_enabled: true,
  upstream_id: 'openrouter',
  upstream_model_id: slug,
  provider: 'openrouter',
  ru_residency: false,
  latency_p50_ms: 50,
  uptime: '0.99',
  price_per_1k_input: '0.123456789012345678',
  price_per_1k_output: '0.5',
  markup: '1.25',
  price_per_image: null,
  priority: 1,
  egress_proxy: null,
  model_upstream_id: 'f0000000-0000-4000-8000-000000000001',
  billing_input_cents_per_1k: '0.123456789012345678',
  billing_output_cents_per_1k: '0.5',
  billing_markup: '1.25',
});
beforeEach(() => {
  vi.clearAllMocks();
  query.mockResolvedValue([row()]);
});
it('queries uncached live/enabled chat facts and preserves exact price text', async () => {
  const model = await resolveStoredChatFreshModel(slug);
  expect(model.candidates[0]!.billing!.prices.inputCentsPer1k).toBe(
    '0.123456789012345678',
  );
  expect(model.candidates[0]!.reviewedChatProfile?.revision).toBe(1);
  const [parts, value] = query.mock.calls[0]!;
  expect(value).toBe(slug);
  const statement = parts.join('');
  for (const predicate of [
    "m.status = 'live'",
    "m.type = 'chat'",
    'm.enabled = TRUE',
    'mu.enabled = TRUE',
    'u.enabled = TRUE',
    'mu.markup::text',
  ])
    expect(statement).toContain(predicate);
  expect(redis).not.toHaveBeenCalled();
  query.mockResolvedValueOnce([]);
  await expect(resolveStoredChatFreshModel(slug)).rejects.toThrow(
    'MODEL_UNAVAILABLE',
  );
  expect(query).toHaveBeenCalledTimes(2);
});
it.each([
  { model_status: 'frozen' },
  { model_status: 'draft' },
  { model_status: 'unknown' },
  { model_enabled: false },
  { candidate_enabled: false },
  { upstream_enabled: false },
  { type: 'image' },
  { ru_residency: 'false' },
  { billing_markup: 1.25 },
  { billing_input_cents_per_1k: '-1' },
  { slug: 'alias' },
])('fails closed on malformed/nonlive projection %j', async (patch) => {
  query.mockResolvedValueOnce([{ ...row(), ...patch }]);
  await expect(resolveStoredChatFreshModel(slug)).rejects.toThrow(
    'MODEL_UNAVAILABLE',
  );
  expect(redis).not.toHaveBeenCalled();
});
it('fresh price changes take effect without Redis cache reads', async () => {
  await resolveStoredChatFreshModel(slug);
  query.mockResolvedValueOnce([{ ...row(), billing_markup: '2.0001' }]);
  expect(
    (await resolveStoredChatFreshModel(slug)).candidates[0]!.billing!.prices
      .markup,
  ).toBe('2.0001');
});
