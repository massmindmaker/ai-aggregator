import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { get, setex, query } = vi.hoisted(() => ({ get: vi.fn(), setex: vi.fn(), query: vi.fn() }));
vi.mock('../lib/redis', () => ({ makeRedis: () => ({ get, setex }) }));
vi.mock('../lib/db', () => ({ sql: query }));
import { resolveModel, projectModelRoutingRows, parseResolvedModelCache, resolveModelWithOverride, setResolveModelOverride, type ResolvedModel } from '../routing/resolver';
const slug = 'openai/gpt-4o-mini';
const row = () => ({ slug, type: 'chat', upstream_id: 'openrouter', upstream_model_id: slug, provider: 'openrouter', ru_residency: false, latency_p50_ms: 50, uptime: '0.99', price_per_1k_input: '0.123456789012345678', price_per_1k_output: '0.5', markup: '1.25', price_per_image: null, price_per_audio_sec: null, priority: 1, egress_proxy: null, model_upstream_id: 'f0000000-0000-4000-8000-000000000001', billing_input_cents_per_1k: '0.123456789012345678', billing_output_cents_per_1k: '0.5', billing_markup: '1.25', billing_audio_cents_per_sec: null });
afterEach(() => { setResolveModelOverride(null); });
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

it('retains exact audio-second billing text through DB projection and cache', async () => {
  const audioRow = {
    ...row(), slug: 'whisper-large-v3', type: 'audio', upstream_id: 'groq',
    upstream_model_id: 'whisper-large-v3', provider: 'groq',
    price_per_audio_sec: '0.0030833333', billing_audio_cents_per_sec: '0.0030833333',
  };
  query.mockResolvedValueOnce([audioRow]);
  const model = await resolveModel(audioRow.slug);
  expect(model.candidates[0]!.billing?.pricePerAudioSecondCents).toBe('0.0030833333');
  expect(model.candidates[0]!.price_per_audio_sec).toBeCloseTo(0.0030833333, 12);
  const [sqlParts] = query.mock.calls[0]!;
  expect(sqlParts.join('')).toContain('mu.price_per_audio_sec::text AS billing_audio_cents_per_sec');
  const cached = JSON.parse(setex.mock.calls[0]![2]);
  expect(cached.candidates[0].billing.pricePerAudioSecondCents).toBe('0.0030833333');
});

it('resolves an existing video model through fresh DB facts', async () => {
  const videoRow = {
    ...row(), slug: 'kling-3-0-kie', type: 'video', upstream_id: 'kie',
    upstream_model_id: 'kling-3.0', provider: 'kie',
    price_per_1k_input: '0.0000000000', price_per_1k_output: '0.0000000000',
    billing_input_cents_per_1k: '0.0000000000', billing_output_cents_per_1k: '0.0000000000',
    markup: '1.8000', billing_markup: '1.8000', price_per_image: '50.0000000000', uptime: '0.9900',
  };
  query.mockResolvedValueOnce([videoRow]);
  const model = await resolveModel(videoRow.slug);
  expect(model.type).toBe('video');
  expect(model.candidates[0]!.price_per_image).toBe(50);
  expect(model.candidates[0]!.billing?.prices).toEqual({
    inputCentsPer1k: '0.0000000000', outputCentsPer1k: '0.0000000000', markup: '1.8000',
  });
  expect(model.candidates[0]!.egress_proxy).toBeNull();
  expect(model.candidates[0]!.reviewedChatProfile).toBeUndefined();
});

const legacyTypes = ['chat', 'completion', 'embedding', 'image', 'audio', 'video'] as const;
it.each(legacyTypes)('round trips legitimate legacy %s through DB and v2 cache', async type => {
  const legacySlug = `legacy-${type}`;
  query.mockResolvedValueOnce([{ ...row(), slug: legacySlug, type }]);
  const fresh = await resolveModel(legacySlug);
  expect(fresh.type).toBe(type);
  expect(fresh.candidates[0]!.reviewedChatProfile).toBeUndefined();
  expect(setex.mock.calls[0]![0]).toBe(`model:v2:${legacySlug}`);
  const cached = setex.mock.calls[0]![2];
  expect(JSON.parse(cached).type).toBe(type);
  get.mockResolvedValueOnce(cached); query.mockClear(); setex.mockClear();
  const hydrated = await resolveModelWithOverride(legacySlug);
  expect(hydrated).toEqual(fresh);
  expect(query).not.toHaveBeenCalled();
  expect(setex).not.toHaveBeenCalled();
});
it.each(legacyTypes)('preserves legacy %s overrides without requiring new billing facts', async type => {
  const model: ResolvedModel = { slug: `override-${type}`, type, candidates: [{
    id: 'legacy', upstream_id: 'legacy', upstream_model_id: 'legacy-model', provider: 'legacy',
    price_per_1k_input: 0, price_per_1k_output: 0, markup: 1, latency_p50_ms: 50, uptime: 0.99, ru_residency: false,
  }] };
  const override = vi.fn(async () => model);
  setResolveModelOverride(override);
  expect(await resolveModelWithOverride(model.slug)).toBe(model);
  expect(override).toHaveBeenCalledWith(model.slug);
  expect(get).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
});
it.each(['unknown', 'music', 'upscale'])('does not treat %s as a legacy model type', async type => {
  query.mockResolvedValueOnce([{ ...row(), type }]);
  await expect(resolveModel(slug)).rejects.toThrow('Invalid model routing facts');
  expect(setex).not.toHaveBeenCalled();
});

it('shared DB projection matches legacy output without cache or query effects', async () => {
  const expected = await resolveModel(slug);
  vi.clearAllMocks();
  expect(projectModelRoutingRows([row() as Parameters<typeof projectModelRoutingRows>[0][number]], slug)).toEqual(expected);
  expect(get).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled(); expect(setex).not.toHaveBeenCalled();
});
