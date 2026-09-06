/**
 * Offline models.dev catalog converter.
 *
 * This module never fetches models.dev and never connects to PostgreSQL. The
 * CLI reads an explicitly supplied JSON file and writes a reviewable bundle of
 * fixed SQL templates plus separate bind values. Applying that bundle is a
 * separate, deliberate operation.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SYNC_PROVIDERS = [
  'openrouter',
  'togetherai',
  'huggingface',
] as const;

type SyncProvider = (typeof SYNC_PROVIDERS)[number];

type ModelsDevModel = {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  family?: unknown;
  modalities?: unknown;
  tool_call?: unknown;
  reasoning?: unknown;
  open_weights?: unknown;
  limit?: unknown;
  cost?: unknown;
};

type CatalogUpstream = {
  provider: SyncProvider;
  upstream_model_id: string;
  price_per_1k_input: number;
  price_per_1k_output: number;
};

export type SyncCatalogModel = {
  slug: string;
  type: 'chat';
  enabled: true;
  displayName: string;
  description: string | null;
  metadata: {
    source: 'models.dev';
    source_id: string;
    provider_family?: string;
    context_window?: number;
    max_output_tokens?: number;
    tags: string[];
  };
  upstreams: CatalogUpstream[];
};

export type SyncStats = {
  models: number;
  upstreams: number;
  skipped_no_pricing: number;
  skipped_non_chat: number;
  skipped_meta_router: number;
};

export type ParameterizedStatement = {
  text: string;
  values: Array<string | number | null>;
};

export type ParameterizedSqlBundle = {
  format: 'aiag-parameterized-sql-v1';
  statements: ParameterizedStatement[];
};

const DB_PROVIDER: Record<SyncProvider, string> = {
  openrouter: 'openrouter',
  togetherai: 'together',
  huggingface: 'hf',
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** Convert a models.dev USD-per-million price to US cents per 1k tokens. */
function centsPer1k(usdPerMillion: number | null): number {
  return (usdPerMillion ?? 0) * 100 / 1000;
}

export function slugifyModelId(modelId: string): string {
  const [org = '', ...modelParts] = modelId.trim().toLowerCase().split('/');
  const model = modelParts.join('/');
  const normalize = (part: string) => part
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const normalizedOrg = normalize(org);
  const normalizedModel = model
    .split('/')
    .map(normalize)
    .filter(Boolean)
    .join('/');
  return normalizedModel ? `${normalizedOrg}/${normalizedModel}` : normalizedOrg;
}

function modelTags(model: ModelsDevModel): string[] {
  const modalities = record(model.modalities);
  const input = stringArray(modalities.input);
  const tags = new Set<string>(['text']);
  if (input.includes('image')) tags.add('vision');
  if (model.tool_call === true) tags.add('tools');
  if (model.reasoning === true) tags.add('reasoning');
  if (model.open_weights === true) tags.add('open-weights');
  return [...tags];
}

export function buildCatalog(apiJson: unknown): {
  models: SyncCatalogModel[];
  stats: SyncStats;
} {
  const root = record(apiJson);
  const bySlug = new Map<string, SyncCatalogModel>();
  const stats: SyncStats = {
    models: 0,
    upstreams: 0,
    skipped_no_pricing: 0,
    skipped_non_chat: 0,
    skipped_meta_router: 0,
  };

  for (const provider of SYNC_PROVIDERS) {
    const providerRow = record(root[provider]);
    const providerModels = record(providerRow.models);
    for (const [modelKey, rawValue] of Object.entries(providerModels)) {
      const raw = record(rawValue) as ModelsDevModel;
      const sourceModelId = typeof raw.id === 'string' ? raw.id : modelKey;
      const modalities = record(raw.modalities);
      const outputModalities = stringArray(modalities.output);
      const costs = record(raw.cost);
      const inputUsd = finiteNonNegative(costs.input);
      const outputUsd = finiteNonNegative(costs.output);
      const noPricing = inputUsd === null && outputUsd === null;
      const nonChat = outputModalities.length > 0 && !outputModalities.includes('text');
      const metaRouter = provider === 'openrouter' && sourceModelId === 'openrouter/auto';

      if (noPricing) stats.skipped_no_pricing += 1;
      if (nonChat) stats.skipped_non_chat += 1;
      if (metaRouter) stats.skipped_meta_router += 1;
      if (noPricing || nonChat || metaRouter) continue;

      const slug = slugifyModelId(sourceModelId);
      if (!slug.includes('/')) continue;
      const limits = record(raw.limit);
      const contextWindow = finiteNonNegative(limits.context);
      const maxOutputTokens = finiteNonNegative(limits.output);
      const displayName = typeof raw.name === 'string' && raw.name.trim()
        ? raw.name.trim()
        : sourceModelId.split('/').at(-1) ?? sourceModelId;
      const description = typeof raw.description === 'string'
        ? raw.description
        : null;
      const family = typeof raw.family === 'string' && raw.family
        ? raw.family
        : undefined;
      const upstream: CatalogUpstream = {
        provider,
        upstream_model_id: sourceModelId,
        price_per_1k_input: centsPer1k(inputUsd),
        price_per_1k_output: centsPer1k(outputUsd),
      };

      const existing = bySlug.get(slug);
      if (existing) {
        existing.upstreams.push(upstream);
        continue;
      }

      bySlug.set(slug, {
        slug,
        type: 'chat',
        enabled: true,
        displayName,
        description,
        metadata: {
          source: 'models.dev',
          source_id: `${provider}/${sourceModelId}`,
          ...(family ? { provider_family: family } : {}),
          ...(contextWindow !== null ? { context_window: contextWindow } : {}),
          ...(maxOutputTokens !== null ? { max_output_tokens: maxOutputTokens } : {}),
          tags: modelTags(raw),
        },
        upstreams: [upstream],
      });
    }
  }

  const models = [...bySlug.values()]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((model) => ({
      ...model,
      upstreams: model.upstreams.sort(
        (a, b) => SYNC_PROVIDERS.indexOf(a.provider) - SYNC_PROVIDERS.indexOf(b.provider),
      ),
    }));
  stats.models = models.length;
  stats.upstreams = models.reduce((sum, model) => sum + model.upstreams.length, 0);
  return { models, stats };
}

const MODEL_UPSERT = `INSERT INTO models
  (slug, type, enabled, display_name, description, metadata)
VALUES ($1, 'chat', TRUE, $2, $3, $4::jsonb)
ON CONFLICT (slug) DO UPDATE SET
  type = EXCLUDED.type,
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  metadata = EXCLUDED.metadata,
  updated_at = now()`;

const UPSTREAM_UPSERT = `INSERT INTO model_upstreams
  (model_id, upstream_id, upstream_model_id,
   price_per_1k_input, price_per_1k_output)
SELECT
  (SELECT id FROM models WHERE slug = $1),
  (SELECT id FROM upstreams WHERE provider = $2 AND enabled = TRUE ORDER BY id LIMIT 1),
  $3, $4::numeric, $5::numeric
WHERE EXISTS (SELECT 1 FROM models WHERE slug = $1)
  AND EXISTS (SELECT 1 FROM upstreams WHERE provider = $2 AND enabled = TRUE)
ON CONFLICT (model_id, upstream_id) DO UPDATE SET
  upstream_model_id = EXCLUDED.upstream_model_id,
  price_per_1k_input = EXCLUDED.price_per_1k_input,
  price_per_1k_output = EXCLUDED.price_per_1k_output`;

export function renderSql(models: SyncCatalogModel[]): ParameterizedSqlBundle {
  const statements: ParameterizedStatement[] = [];
  for (const model of [...models].sort((a, b) => a.slug.localeCompare(b.slug))) {
    statements.push({
      text: MODEL_UPSERT,
      values: [
        model.slug,
        model.displayName,
        model.description,
        JSON.stringify(model.metadata),
      ],
    });
    for (const upstream of model.upstreams) {
      statements.push({
        text: UPSTREAM_UPSERT,
        values: [
          model.slug,
          DB_PROVIDER[upstream.provider],
          upstream.upstream_model_id,
          upstream.price_per_1k_input,
          upstream.price_per_1k_output,
        ],
      });
    }
  }
  return { format: 'aiag-parameterized-sql-v1', statements };
}

async function runCli(args: string[]): Promise<void> {
  const [inputPath, outputPath] = args;
  if (!inputPath || !outputPath) {
    throw new Error(
      'Usage: bun run scripts/sync-models-dev.ts <models-dev.json> <output-bundle.json>',
    );
  }
  const payload = JSON.parse(await readFile(resolve(inputPath), 'utf8')) as unknown;
  const bundle = renderSql(buildCatalog(payload).models);
  await writeFile(resolve(outputPath), `${JSON.stringify(bundle, null, 2)}\n`, {
    flag: 'wx',
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  await runCli(process.argv.slice(2));
}
