import { beforeEach, expect, it, vi } from 'vitest';
const { query, redis } = vi.hoisted(() => ({ query: vi.fn(), redis: vi.fn() }));
vi.mock('../lib/db', () => ({ sql: query }));
vi.mock('../lib/redis', () => ({ makeRedis: redis }));
import { resolveStoredEmbeddingsFreshModel } from '../routing/stored-embeddings-fresh-resolver';

const slug = 'openai/text-embedding-3-small';
const row = () => ({
  slug, type: 'embedding', model_enabled: true, model_status: 'live', candidate_enabled: true, upstream_enabled: true,
  upstream_id: 'openrouter', upstream_model_id: slug, provider: 'openrouter', ru_residency: false,
  latency_p50_ms: 50, uptime: '0.99', price_per_1k_input: '0.002', price_per_1k_output: '0', markup: '1.25',
  price_per_image: null, priority: 1, egress_proxy: null,
  model_upstream_id: 'f0000000-0000-4000-8000-000000000001',
  billing_input_cents_per_1k: '0.002', billing_output_cents_per_1k: '0', billing_markup: '1.25',
});
beforeEach(() => { vi.clearAllMocks(); query.mockResolvedValue([row()]); });

it('reads uncached live embeddings facts and preserves decimal text', async () => {
  const model = await resolveStoredEmbeddingsFreshModel(slug);
  expect(model.type).toBe('embedding');
  expect(model.candidates[0]!.billing!.prices).toEqual({ inputCentsPer1k: '0.002', outputCentsPer1k: '0', markup: '1.25' });
  const [parts, value] = query.mock.calls[0]!;
  expect(value).toBe(slug);
  expect(parts.join('')).toContain("m.type = 'embedding'");
  expect(redis).not.toHaveBeenCalled();
});

it.each([
  { type: 'chat' }, { model_status: 'frozen' }, { model_enabled: false },
  { candidate_enabled: false }, { upstream_enabled: false }, { slug: 'alias' },
  { billing_input_cents_per_1k: 0.002 },
])('fails closed on malformed/nonlive row %#', async (change) => {
  query.mockResolvedValueOnce([{ ...row(), ...change }]);
  await expect(resolveStoredEmbeddingsFreshModel(slug)).rejects.toThrow('MODEL_UNAVAILABLE');
});
