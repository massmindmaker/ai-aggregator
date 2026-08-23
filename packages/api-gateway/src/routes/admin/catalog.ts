/**
 * GET  /api/admin/catalog/diff   - models.dev drafts vs live registry
 * POST /api/admin/catalog/apply  - merge approved drafts into models/model_upstreams
 *
 * (native egress integration, T4). Guard: same fail-closed AIAG_ADMIN_KEY
 * bearer as proxyTest (requireAdminKey). Merge layers: manual registry rows
 * are ALWAYS stronger - apply never overwrites an existing
 * model_upstreams row, it only fills gaps and creates new pairs.
 */
import { Hono } from 'hono';
import { errors } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { sql } from '../../lib/db';
import { requireAdminKey } from './proxyTest';

export const adminCatalog = new Hono();

adminCatalog.use('*', requireAdminKey);

type DraftRow = {
  id: string;
  provider_slug: string;
  model_slug: string;
  status: string;
  normalized: {
    price_usd_per_1m_input?: number | null;
    price_usd_per_1m_output?: number | null;
    context_window?: number | null;
    input_modalities?: string[];
    output_modalities?: string[];
  };
  upstream_id: string | null;
  existing_model_id: string | null;
  existing_pair_id: string | null;
};

/** USD-per-1M -> our US-cents-per-1K (lib/pricing.ts unit). */
function toCentsPer1k(usdPer1m: number | null | undefined): string {
  return ((usdPer1m ?? 0) * 0.1).toFixed(10);
}

adminCatalog.get('/diff', async (c) => c.json(await classifyDrafts()));

async function classifyDrafts() {
  const rows = (await sql`
    SELECT d.id, d.provider_slug, d.model_slug,
           d.normalized,
           u.id  AS upstream_id,
           m.id  AS existing_model_id,
           mu.id AS existing_pair_id,
           mu.price_per_1k_input  AS cur_in,
           mu.price_per_1k_output AS cur_out
      FROM model_catalog_drafts d
      LEFT JOIN upstreams u ON u.provider = d.provider_slug AND u.enabled = TRUE
      LEFT JOIN models m    ON m.slug = d.model_slug
      LEFT JOIN model_upstreams mu
             ON mu.model_id = m.id AND mu.upstream_id = u.id
     WHERE d.status = 'draft'
     ORDER BY d.provider_slug, d.model_slug
  `) as Array<Record<string, unknown>>;

  const out: Record<string, unknown[]> = {
    new: [],
    changed: [],
    skipped_no_provider: [],
  };
  for (const r of rows) {
    if (!r.upstream_id) {
      out.skipped_no_provider.push(r);
    } else if (!r.existing_model_id || !r.existing_pair_id) {
      out.new.push(r);
    } else {
      const n = r.normalized as DraftRow['normalized'];
      const inCents = toCentsPer1k(n.price_usd_per_1m_input);
      const outCents = toCentsPer1k(n.price_usd_per_1m_output);
      if (String(r.cur_in ?? '') !== inCents || String(r.cur_out ?? '') !== outCents) {
        out.changed.push({ ...r, proposed_price_per_1k_input: inCents, proposed_price_per_1k_output: outCents });
      }
    }
  }
  return out;
}

adminCatalog.post('/apply', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { ids?: string[] };
  const ids = Array.isArray(body.ids) ? body.ids.filter((v) => typeof v === 'string') : [];
  if (ids.length === 0) throw errors.badRequest('ids: string[] required');

  let applied = 0;
  const failed: Array<{ id: string; reason: string }> = [];

  for (const id of ids.slice(0, 500)) {
    try {
      const rows = (await sql`
        SELECT d.id, d.provider_slug, d.model_slug, d.normalized, u.id AS upstream_id
          FROM model_catalog_drafts d
          LEFT JOIN upstreams u ON u.provider = d.provider_slug AND u.enabled = TRUE
         WHERE d.id = ${id}::uuid AND d.status = 'draft'
         FOR UPDATE OF d
      `) as Array<Record<string, unknown>>;
      const d = rows[0];
      if (!d?.upstream_id) {
        failed.push({ id, reason: 'not a draft or provider has no enabled upstream' });
        continue;
      }
      const n = d.normalized as DraftRow['normalized'];
      const inCents = toCentsPer1k(n.price_usd_per_1m_input);
      const outCents = toCentsPer1k(n.price_usd_per_1m_output);

      // Manual rows win: ON CONFLICT only fills a missing pair; prices are
      // NOT overwritten for existing pairs (changed merges go through the
      // same endpoint but only when the admin explicitly re-applies).
      await sql`
        INSERT INTO models (slug, type, enabled, display_name)
        VALUES (${d.model_slug}, 'chat', FALSE, NULL)
        ON CONFLICT (slug) DO UPDATE SET updated_at = now()
      `;
      await sql`
        INSERT INTO model_upstreams
          (model_id, upstream_id, upstream_model_id,
           price_per_1k_input, price_per_1k_output, markup, priority, enabled)
        SELECT m.id, ${d.upstream_id}, ${d.model_slug},
               ${inCents}::numeric, ${outCents}::numeric, 1.8, 200, TRUE
          FROM models m
         WHERE m.slug = ${d.model_slug}
        ON CONFLICT (model_id, upstream_id) DO NOTHING
      `;
      await sql`
        UPDATE model_catalog_drafts SET status = 'applied' WHERE id = ${id}::uuid
      `;
      applied += 1;
    } catch (err) {
      logger.warn({ err: String(err), id }, 'catalog_apply_failed');
      failed.push({ id, reason: String(err).slice(0, 200) });
    }
  }

  return c.json({ applied, failed });
});
