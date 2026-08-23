/**
 * models.dev catalog transform (native egress integration, T4).
 *
 * Adapted from OmniRoute src/lib/modelsDevSync/transform.ts (MIT,
 * Copyright (c) diegosouzapw) - see THIRD_PARTY_NOTICES.md. Only the field
 * mapping we consume survives; prices stay USD-per-1M here and are converted
 * to our US-cents-per-1K at apply time (*0.1), not in this layer.
 *
 * Source shape (https://models.dev/api.json):
 * { "<providerId>": { id, name, models: { "<modelId>": {
 *   name?, limit?: { context?, output? }, modalities?: { input?, output? },
 *   cost?: { input?, output? }  // USD per 1M tokens
 * } } } }
 */

export type CatalogDraftNormalized = {
  price_usd_per_1m_input: number | null;
  price_usd_per_1m_output: number | null;
  context_window: number | null;
  input_modalities: string[];
  output_modalities: string[];
};

export type CatalogDraftRow = {
  provider_slug: string;
  model_slug: string;
  raw: unknown;
  normalized: CatalogDraftNormalized;
};

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
}

export function transformModel(
  providerSlug: string,
  modelSlug: string,
  rawModel: Record<string, unknown>
): CatalogDraftRow {
  const cost = (rawModel.cost ?? {}) as Record<string, unknown>;
  const limit = (rawModel.limit ?? {}) as Record<string, unknown>;
  const modalities = (rawModel.modalities ?? {}) as Record<string, unknown>;

  return {
    provider_slug: providerSlug,
    model_slug: modelSlug,
    raw: rawModel,
    normalized: {
      price_usd_per_1m_input: num(cost.input),
      price_usd_per_1m_output: num(cost.output),
      context_window: num(limit.context),
      input_modalities: strArray(modalities.input),
      output_modalities: strArray(modalities.output),
    },
  };
}

/** Transform the whole api.json payload; skips malformed entries silently. */
export function transformModelsDev(apiJson: unknown): CatalogDraftRow[] {
  if (apiJson === null || typeof apiJson !== 'object') return [];
  const out: CatalogDraftRow[] = [];
  for (const [providerSlug, prov] of Object.entries(
    apiJson as Record<string, unknown>
  )) {
    if (prov === null || typeof prov !== 'object') continue;
    const models = (prov as Record<string, unknown>).models;
    if (models === null || typeof models !== 'object') continue;
    for (const [modelSlug, rawModel] of Object.entries(
      models as Record<string, unknown>
    )) {
      if (rawModel === null || typeof rawModel !== 'object') continue;
      out.push(transformModel(providerSlug, modelSlug, rawModel as Record<string, unknown>));
    }
  }
  return out;
}
