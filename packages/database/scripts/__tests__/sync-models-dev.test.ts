/**
 * Unit tests for the models.dev → Postgres catalog sync transforms.
 *
 * No network, no database: pure transform + SQL-generation coverage with a
 * trimmed fixture shaped exactly like https://models.dev/api.json.
 */
import { describe, expect, it } from 'vitest';
import {
  slugifyModelId,
  buildCatalog,
  renderSql,
  SYNC_PROVIDERS,
} from '../../scripts/sync-models-dev';

// ---------------------------------------------------------------------------
// Fixture — trimmed models.dev payload (only the fields the sync reads).
// ---------------------------------------------------------------------------
const FIXTURE = {
  openrouter: {
    name: 'OpenRouter',
    models: {
      // Anchor model with known USD-per-million pricing.
      'openai/gpt-4o': {
        id: 'openai/gpt-4o',
        name: 'GPT-4o',
        description: 'Multimodal flagship.',
        family: 'gpt-4o',
        modalities: { input: ['text', 'image'], output: ['text'] },
        tool_call: true,
        reasoning: false,
        open_weights: false,
        limit: { context: 128000, output: 16384 },
        cost: { input: 2.5, output: 10 },
      },
      // Meta-router pseudo-model: must be skipped.
      'openrouter/auto': {
        id: 'openrouter/auto',
        name: 'Auto (best for prompt)',
        description: 'Router.',
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 128000, output: 4096 },
        // no cost
      },
      // Image-only output: gateway routes chat only → skipped.
      'google/gemini-3-pro-image': {
        id: 'google/gemini-3-pro-image',
        name: 'Gemini 3 Pro Image',
        description: 'Image generation.',
        modalities: { input: ['text'], output: ['image'] },
        limit: { context: 1000000, output: 32768 },
        cost: { input: 2, output: 12 },
      },
      // Same logical model as the huggingface entry below → merged upstreams.
      'mistralai/mistral-small-3.2': {
        id: 'mistralai/mistral-small-3.2',
        name: 'Mistral Small 3.2',
        description: 'Open-weights workhorse.',
        family: 'mistral',
        modalities: { input: ['text'], output: ['text'] },
        tool_call: true,
        open_weights: true,
        limit: { context: 128000, output: 8192 },
        cost: { input: 0.1, output: 0.3 },
      },
    },
  },
  togetherai: {
    name: 'Together',
    models: {
      // Uppercase + dots id → slug must be lowercased/dashed.
      'Qwen/Qwen3-235B.A22B': {
        id: 'Qwen/Qwen3-235B.A22B',
        name: 'Qwen3 235B A22B',
        description: 'MoE flagship.',
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 128000, output: 8192 },
        cost: { input: 0.2, output: 0.6 },
      },
    },
  },
  huggingface: {
    name: 'Hugging Face',
    models: {
      // Duplicate of the openrouter mistral entry (same normalized slug).
      'mistralai/Mistral-Small-3.2': {
        id: 'mistralai/Mistral-Small-3.2',
        name: 'Mistral Small 3.2',
        description: 'Open-weights workhorse.',
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 128000, output: 8192 },
        cost: { input: 0.12, output: 0.35 },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// slugifyModelId
// ---------------------------------------------------------------------------
describe('slugifyModelId', () => {
  it('lowercases and converts dots/underscores to dashes after the slash', () => {
    expect(slugifyModelId('anthropic/claude-sonnet-4.5')).toBe(
      'anthropic/claude-sonnet-4-5'
    );
    expect(slugifyModelId('Qwen/Qwen3-235B.A22B')).toBe('qwen/qwen3-235b-a22b');
    expect(slugifyModelId('mistralai/Mistral-Small-3.2')).toBe(
      'mistralai/mistral-small-3-2'
    );
  });

  it('keeps the organisation part verbatim-lowercased and collapses repeats', () => {
    expect(slugifyModelId('OpenAI/GPT-4o')).toBe('openai/gpt-4o');
    expect(slugifyModelId('org/model..v2')).toBe('org/model-v2');
  });
});

// ---------------------------------------------------------------------------
// buildCatalog
// ---------------------------------------------------------------------------
describe('buildCatalog', () => {
  const { models, stats } = buildCatalog(FIXTURE);

  it('emits one entry per normalized slug, merging cross-provider duplicates', () => {
    const slugs = models.map((m) => m.slug).sort();
    expect(slugs).toEqual([
      'mistralai/mistral-small-3-2',
      'openai/gpt-4o',
      'qwen/qwen3-235b-a22b',
    ]);
  });

  it('merges duplicated models into one row with several upstream price rows', () => {
    const mistral = models.find((m) => m.slug === 'mistralai/mistral-small-3-2');
    expect(mistral).toBeDefined();
    expect(mistral!.upstreams.map((u) => u.provider).sort()).toEqual([
      'huggingface',
      'openrouter',
    ]);
    expect(mistral!.upstreams).toHaveLength(2);
  });

  it('keeps the model-level fields from the highest-priority provider', () => {
    const mistral = models.find((m) => m.slug === 'mistralai/mistral-small-3-2');
    // openrouter outranks huggingface in SYNC_PROVIDERS order
    expect(mistral!.displayName).toBe('Mistral Small 3.2');
    expect(mistral!.metadata.source_id).toBe('openrouter/mistralai/mistral-small-3.2');
  });

  it('converts USD-per-million prices to US cents per 1k (USD × 100 / 1000)', () => {
    const gpt4o = models.find((m) => m.slug === 'openai/gpt-4o');
    expect(gpt4o!.upstreams[0]!.price_per_1k_input).toBeCloseTo(0.25, 10);
    expect(gpt4o!.upstreams[0]!.price_per_1k_output).toBeCloseTo(1.0, 10);
  });

  it('marks priced models enabled and derives gateway-friendly metadata', () => {
    const gpt4o = models.find((m) => m.slug === 'openai/gpt-4o');
    expect(gpt4o!.enabled).toBe(true);
    expect(gpt4o!.type).toBe('chat');
    expect(gpt4o!.metadata.context_window).toBe(128000);
    expect(gpt4o!.metadata.provider_family).toBe('gpt-4o');
    expect(gpt4o!.metadata.tags).toContain('vision');
    expect(gpt4o!.metadata.tags).toContain('tools');
    expect(gpt4o!.metadata.source).toBe('models.dev');
  });

  it('skips the meta-router, image-only and unpriced entries', () => {
    const slugs = models.map((m) => m.slug);
    expect(slugs).not.toContain('openrouter/auto');
    expect(slugs).not.toContain('google/gemini-3-pro-image');
    expect(stats.skipped_no_pricing).toBe(1);
    expect(stats.skipped_non_chat).toBe(1);
    expect(stats.skipped_meta_router).toBe(1);
  });

  it('counts upstream rows and models in stats', () => {
    expect(stats.models).toBe(3);
    expect(stats.upstreams).toBe(4); // 1 gpt-4o + 1 qwen + 2 mistral
  });
});

// ---------------------------------------------------------------------------
// renderSql
// ---------------------------------------------------------------------------
describe('renderSql', () => {
  const { models } = buildCatalog(FIXTURE);
  const bundle = renderSql(models);
  const sql = bundle.statements.map((statement) => statement.text).join('\n');

  it('is deterministic (same input → byte-identical output)', () => {
    const again = renderSql(buildCatalog(FIXTURE).models);
    expect(bundle).toEqual(again);
  });

  it('uses idempotent upserts with conflict targets', () => {
    expect(sql).toMatch(/ON CONFLICT \(slug\) DO UPDATE/);
    expect(sql).toMatch(/ON CONFLICT \(model_id, upstream_id\) DO UPDATE/);
  });

  it('does not touch enabled for pre-existing model rows', () => {
    const upsert = sql.match(/INSERT INTO models[\s\S]*?ON CONFLICT/)?.[0] ?? '';
    expect(upsert).not.toMatch(/enabled\s*=\s*(TRUE|FALSE|EXCLUDED)/);
  });

  it('links price rows to models by slug via a subquery', () => {
    expect(sql).toMatch(/\(SELECT id FROM models WHERE slug = \$1\)/);
  });

  it('keeps non-negative prices in bind values instead of SQL literals', () => {
    const priceStatements = bundle.statements.filter((statement) =>
      statement.text.includes('INSERT INTO model_upstreams'),
    );
    expect(priceStatements.length).toBeGreaterThan(0);
    for (const statement of priceStatements) {
      expect(statement.values[3]).toEqual(expect.any(Number));
      expect(statement.values[4]).toEqual(expect.any(Number));
      expect(statement.values[3] as number).toBeGreaterThanOrEqual(0);
      expect(statement.values[4] as number).toBeGreaterThanOrEqual(0);
    }
  });

  it('binds models.dev providers to the existing upstream registry ids', () => {
    const providers = bundle.statements
      .filter((statement) => statement.text.includes('INSERT INTO model_upstreams'))
      .map((statement) => statement.values[1])
      .sort();
    expect(providers).toEqual(['hf', 'openrouter', 'openrouter', 'together']);
  });

  it('keeps dynamic text in bind values instead of interpolating executable SQL', () => {
    const hostile = structuredClone(FIXTURE);
    hostile.openrouter.models['openai/gpt-4o'].description =
      "model'); DROP TABLE models; --";
    const hostileBundle = renderSql(buildCatalog(hostile).models);
    const hostileSql = hostileBundle.statements
      .map((statement) => statement.text)
      .join('\n');

    expect(hostileSql).not.toContain("model'); DROP TABLE models; --");
    expect(hostileSql).toContain('$1');
    expect(hostileBundle.statements.flatMap((statement) => statement.values))
      .toContain("model'); DROP TABLE models; --");
  });
});

// ---------------------------------------------------------------------------
// Provider contract
// ---------------------------------------------------------------------------
describe('SYNC_PROVIDERS', () => {
  it('targets only the upstreams this repo actually routes', () => {
    expect(SYNC_PROVIDERS).toEqual(['openrouter', 'togetherai', 'huggingface']);
  });
});
