/**
 * models.dev catalog sync cron (native egress integration, T4).
 *
 * Gated by env MODELS_DEV_SYNC=on (off by default - zero behavior change
 * until ops enables it). Runs once at boot + every 24h. Upserts drafts via
 * ON CONFLICT (provider_slug, model_slug); applied/rejected rows are NEVER
 * refreshed back to draft.
 */
import { logger } from '../logger.js';
import { transformModelsDev } from './transform.js';

const INTERVAL_MS = 24 * 60 * 60 * 1000;
const MODELS_DEV_URL = 'https://models.dev/api.json';

type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;

export type SyncResult = { providersSeen: number; draftsUpserted: number };

export async function runCatalogSyncOnce(deps: {
  sql: SqlTag;
  fetchImpl?: typeof fetch;
}): Promise<SyncResult> {
  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch(MODELS_DEV_URL);
  if (!res.ok) throw new Error(`models.dev fetch failed: HTTP ${res.status}`);
  const apiJson: unknown = await res.json();

  const rows = transformModelsDev(apiJson);
  let upserted = 0;
  for (const r of rows) {
    // status stays untouched when the row is already applied/rejected:
    // the CASE keeps an existing non-draft status; a fresh insert is 'draft'.
    await deps.sql`
      INSERT INTO model_catalog_drafts
        (provider_slug, model_slug, raw, normalized, status)
      VALUES (${r.provider_slug}, ${r.model_slug},
              ${JSON.stringify(r.raw)}::jsonb,
              ${JSON.stringify(r.normalized)}::jsonb, 'draft')
      ON CONFLICT (provider_slug, model_slug) DO UPDATE SET
        raw        = EXCLUDED.raw,
        normalized = EXCLUDED.normalized,
        synced_at  = now(),
        status     = CASE WHEN model_catalog_drafts.status = 'draft'
                          THEN 'draft' ELSE model_catalog_drafts.status END
    `;
    upserted += 1;
  }
  logger.info(
    { providers: new Set(rows.map((r) => r.provider_slug)).size, drafts: upserted },
    'catalog_sync_done'
  );
  return { providersSeen: new Set(rows.map((r) => r.provider_slug)).size, draftsUpserted: upserted };
}

/** Boot wiring: no-op unless MODELS_DEV_SYNC=on. Mirrors other worker crons. */
export function startCatalogSyncCron(): void {
  if (process.env.MODELS_DEV_SYNC !== 'on') return;
  const run = () => {
    (async () => {
      const { sql } = await import('@aiag/database');
      await runCatalogSyncOnce({ sql: sql as unknown as SqlTag });
    })().catch((err) => logger.error({ err: String(err) }, 'catalog_sync_failed'));
  };
  run();
  const timer = setInterval(run, INTERVAL_MS);
  timer.unref?.();
}
