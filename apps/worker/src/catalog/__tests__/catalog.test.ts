import { afterEach, describe, expect, it } from 'vitest';
import { transformModelsDev, transformModel } from '../transform.js';
import { runCatalogSyncOnce } from '../sync-cron.js';

const SAMPLE = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    models: {
      'gpt-4o-mini': {
        cost: { input: 0.15, output: 0.6 },
        limit: { context: 128000, output: 16384 },
        modalities: { input: ['text', 'image'], output: ['text'] },
      },
      broken: { cost: { input: 'free' } },
    },
  },
  badprovider: null,
};

describe('transformModelsDev', () => {
  const rows = transformModelsDev(SAMPLE);

  it('flattens providers x models into draft rows', () => {
    expect(rows.map((r) => `${r.provider_slug}/${r.model_slug}`).sort()).toEqual([
      'openai/broken',
      'openai/gpt-4o-mini',
    ]);
  });

  it('normalizes prices (USD/1M), context and modalities; nulls for junk', () => {
    const good = transformModel('openai', 'gpt-4o-mini', SAMPLE.openai.models['gpt-4o-mini']);
    expect(good.normalized).toEqual({
      price_usd_per_1m_input: 0.15,
      price_usd_per_1m_output: 0.6,
      context_window: 128000,
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
    });
    const junk = rows.find((r) => r.model_slug === 'broken')!;
    expect(junk.normalized.price_usd_per_1m_input).toBeNull();
  });

  it('non-object payload → empty list', () => {
    expect(transformModelsDev(null)).toEqual([]);
    expect(transformModelsDev('x')).toEqual([]);
  });
});

describe('runCatalogSyncOnce', () => {
  const captured: unknown[] = [];
  const fakeSql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    captured.push({ sql: strings.join('?'), values });
    return Promise.resolve([]);
  }) as never;

  afterEach(() => captured.length = 0);

  it('fetches api.json and upserts every draft idempotently', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(SAMPLE), { status: 200 })) as typeof fetch;
    const res = await runCatalogSyncOnce({ sql: fakeSql, fetchImpl });
    expect(res.draftsUpserted).toBe(2);
    expect(captured.length).toBe(2);
    expect(captured[0].sql).toContain('ON CONFLICT (provider_slug, model_slug)');
    // CASE keeps applied/rejected statuses from being reset to draft.
    expect(captured[0].sql).toContain("WHEN model_catalog_drafts.status = 'draft'");
  });

  it('HTTP failure propagates to the cron logger', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 503 })) as typeof fetch;
    await expect(runCatalogSyncOnce({ sql: fakeSql, fetchImpl })).rejects.toThrow(
      /HTTP 503/
    );
  });
});
