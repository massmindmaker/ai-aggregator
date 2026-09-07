import { beforeEach, describe, expect, it, vi } from 'vitest';
const { get, setex, query } = vi.hoisted(() => ({ get: vi.fn(), setex: vi.fn(), query: vi.fn() }));
vi.mock('../lib/redis', () => ({ makeRedis: () => ({ get, setex }) }));
vi.mock('../lib/db', () => ({ sql: query }));
import { resolveModel, parseResolvedModelCache } from '../routing/resolver';
const slug = 'openai/gpt-4o-mini';
const row = () => ({ slug, type: 'chat', upstream_id: 'openrouter', upstream_model_id: slug, provider: 'openrouter', ru_residency: false, latency_p50_ms: 50, uptime: '0.99', price_per_1k_input: '0.123456789012345678', price_per_1k_output: '0.5', markup: '1.25', price_per_image: null, priority: 1, egress_proxy: null, model_upstream_id: 'f0000000-0000-4000-8000-000000000001', billing_input_cents_per_1k: '0.123456789012345678', billing_output_cents_per_1k: '0.5', billing_markup: '1.25' });
beforeEach(() => { get.mockReset().mockResolvedValue(null); setex.mockReset(); query.mockReset().mockResolvedValue([row()]); });
describe('exact resolver and versioned cache', () => {
  it('selects UUID and decimal text explicitly through prepared SQL, retaining exact digits', async () => {
    const model = await resolveModel(slug);
    expect(model.candidates[0]!.billing).toEqual({ modelUpstreamId: row().model_upstream_id, prices: { inputCentsPer1k: '0.123456789012345678', outputCentsPer1k: '0.5', markup: '1.25' } });
    const [sqlParts, boundSlug] = query.mock.calls[0]!;
    expect(sqlParts.join('')).toContain('mu.id::text AS model_upstream_id');
    expect(sqlParts.join('')).toContain('mu.price_per_1k_input::text AS billing_input_cents_per_1k');
    expect(sqlParts.join('')).toContain('mu.price_per_1k_output::text AS billing_output_cents_per_1k');
    expect(sqlParts.join('')).toContain('mu.markup::text AS billing_markup');
    expect(boundSlug).toBe(slug);
    expect(get).toHaveBeenCalledWith(`model:v2:${slug}`);
    expect(setex.mock.calls[0]![0]).toBe(`model:v2:${slug}`);
    expect(JSON.parse(setex.mock.calls[0]![2]).candidates[0].reviewedChatProfile).toBeUndefined();
  });
  it('hydrates valid v2 facts and rebinds current profile over injected cached profile', async () => {
    const model = await resolveModel(slug);
    const cached = { ...model, candidates: model.candidates.map(c => ({ ...c, reviewedChatProfile: { revision: 999, maxOutputTokens: 999999 } })) };
    get.mockResolvedValue(JSON.stringify(cached)); query.mockClear();
    const hydrated = await resolveModel(slug);
    expect(query).not.toHaveBeenCalled();
    expect(hydrated.candidates[0]!.reviewedChatProfile?.revision).toBe(1);
    expect(Object.isFrozen(hydrated.candidates[0]!.reviewedChatProfile)).toBe(true);
  });
  it('treats old/malformed/mismatched cache as misses', async () => {
    const model = await resolveModel(slug);
    const c = model.candidates[0]!;
    for (const payload of [{ ...model, slug: 'alias' }, { ...model, candidates: [{ ...c, billing: undefined }] }, { ...model, candidates: [{ ...c, billing: { ...c.billing, modelUpstreamId: 'bad' } }] }, { ...model, candidates: [{ ...c, billing: { ...c.billing, prices: { ...c.billing!.prices, markup: 1.25 } } }] },{ ...model, candidates: [{ ...c, ru_residency: 'false' }] }]) {
      expect(parseResolvedModelCache(payload,slug)).toBeNull();
      get.mockResolvedValueOnce(JSON.stringify(payload)); query.mockClear();
      await resolveModel(slug); expect(query).toHaveBeenCalledTimes(1);
    }
    get.mockResolvedValueOnce('{'); query.mockClear(); await resolveModel(slug); expect(query).toHaveBeenCalledTimes(1);
  });
  it('fails closed for invalid exact DB facts, without caching', async () => {
    query.mockResolvedValueOnce([{ ...row(), billing_input_cents_per_1k: 0.1 }]);
    await expect(resolveModel(slug)).rejects.toThrow('Invalid model routing facts');
    expect(setex).not.toHaveBeenCalled();
  });
});
