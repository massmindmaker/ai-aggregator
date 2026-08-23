-- 0065_model_catalog_drafts.sql
-- T4 of docs/superpowers/plans/2026-08-22-native-egress-integration.md:
-- staging area for models.dev catalog sync.
--
-- The sync cron (apps/worker/src/catalog/sync-cron.ts) upserts every model
-- from https://models.dev/api.json here as status='draft'. NOTHING lands in
-- the live `models`/`model_upstreams` registry until an admin explicitly
-- approves it via POST /api/admin/catalog/apply — manual registry entries are
-- always stronger (merge layers: manual > synced > nothing).
--
-- Idempotency: CREATE TABLE IF NOT EXISTS + COMMENT are no-ops on re-run
-- (same convention as 0062/0064).

CREATE TABLE IF NOT EXISTS model_catalog_drafts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_slug VARCHAR(64) NOT NULL,
  model_slug    VARCHAR(256) NOT NULL,
  raw           JSONB NOT NULL,
  normalized    JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'applied', 'rejected')),
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_slug, model_slug)
);

CREATE INDEX IF NOT EXISTS idx_model_catalog_drafts_status
  ON model_catalog_drafts (status);

COMMENT ON TABLE model_catalog_drafts IS
  'Staging for models.dev catalog sync (native egress integration T4, '
  '2026-08-22). Rows are proposals only: apply moves them into '
  'models/model_upstreams with enabled=true on the model row left FALSE so '
  'the founder flips visibility manually. Re-sync refreshes draft rows but '
  'never touches applied/rejected ones.';

COMMENT ON COLUMN model_catalog_drafts.normalized IS
  '{price_usd_per_1m_input, price_usd_per_1m_output, context_window, '
  'input_modalities[], output_modalities} — converted to our cents-per-1k '
  'price columns at apply time (usd_per_1m * 0.1).';

COMMENT ON COLUMN model_catalog_drafts.status IS
  '''draft'' = awaiting review, ''applied'' = merged into the registry by '
  'POST /api/admin/catalog/apply, ''rejected'' = admin declined.';
