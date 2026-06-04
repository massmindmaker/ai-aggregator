-- 0033_template_ratings.sql
-- Wave 1 / Creator-economy slice — template ratings (discovery signal, NO money path).
--
-- Apply on prod manually (the app `aiag` role cannot ALTER — packages/database/CLAUDE.md):
--   sudo -u postgres psql aiag -f 0033_template_ratings.sql
-- Additive + idempotent: re-running is a no-op (CREATE TABLE/INDEX IF NOT EXISTS).
--
-- DEPENDS ON 0031_agent_templates.sql (agent_templates must already exist on prod).
--
-- One row per (template, rater). The UNIQUE(template_id, rater_tg_user_id) is what
-- the rate route's UPSERT keys off: a re-rate UPDATEs the existing row instead of
-- duplicating. stars is bounded 1..5 by a DB-level CHECK (defense-in-depth — the
-- route also validates, but prod migrations are hand-run and a future caller could
-- bypass the route). This table touches NO balance and NO money path.

CREATE TABLE IF NOT EXISTS template_ratings (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id        UUID NOT NULL REFERENCES agent_templates(id),
  rater_tg_user_id   BIGINT NOT NULL,
  stars              SMALLINT NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment            TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (template_id, rater_tg_user_id)
);

CREATE INDEX IF NOT EXISTS idx_template_ratings_template
  ON template_ratings(template_id);
