import { sql } from '../lib/db';
import { projectModelRoutingRows, type ModelRoutingDbRow, type ResolvedModel } from './resolver';

export class StoredEmbeddingsFreshModelError extends Error {
  constructor() { super('MODEL_UNAVAILABLE'); }
}
type FreshRow = ModelRoutingDbRow & {
  model_enabled: boolean; model_status: string; candidate_enabled: boolean; upstream_enabled: boolean;
};

/** Prepared live embedding read; cached legacy routing data is never authority. */
export async function resolveStoredEmbeddingsFreshModel(slug: string): Promise<ResolvedModel> {
  const rows = await sql<FreshRow[]>`
    SELECT m.slug, m.type, m.enabled AS model_enabled, m.status AS model_status,
           mu.enabled AS candidate_enabled, u.enabled AS upstream_enabled,
           mu.id::text AS model_upstream_id,
           mu.price_per_1k_input::text AS billing_input_cents_per_1k,
           mu.price_per_1k_output::text AS billing_output_cents_per_1k,
           mu.markup::text AS billing_markup,
           mu.upstream_id, mu.upstream_model_id,
           u.provider, u.ru_residency, u.latency_p50_ms, u.uptime,
           mu.price_per_1k_input, mu.price_per_1k_output, mu.price_per_image,
           mu.markup, mu.egress_proxy, mu.priority
      FROM models m
      JOIN model_upstreams mu ON mu.model_id = m.id AND mu.enabled = TRUE
      JOIN upstreams u ON u.id = mu.upstream_id AND u.enabled = TRUE
     WHERE m.slug = ${slug} AND m.enabled = TRUE AND m.status = 'live' AND m.type = 'embedding'
     ORDER BY mu.priority ASC, mu.upstream_id ASC
  `;
  try {
    if (!rows.length || rows.some((row) =>
      row.slug !== slug || row.type !== 'embedding' || row.model_enabled !== true ||
      row.model_status !== 'live' || row.candidate_enabled !== true ||
      row.upstream_enabled !== true || typeof row.ru_residency !== 'boolean')) throw new Error();
    return projectModelRoutingRows(rows, slug);
  } catch { throw new StoredEmbeddingsFreshModelError(); }
}
