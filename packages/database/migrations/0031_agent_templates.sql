-- 0031_agent_templates.sql
-- Wave 1 / Slice 1 — publish an agent as a public template + browse + clone-FREE.
-- NO money path in this slice (paid rent is Slice 2).
--
-- Apply on prod manually (the app `aiag` role cannot ALTER — packages/database/CLAUDE.md):
--   sudo -u postgres psql aiag -f 0031_agent_templates.sql
-- Additive + idempotent: re-running is a no-op (CREATE TABLE/INDEX IF NOT EXISTS).
--
-- SECURITY (share-spec, keep-secrets — enforced at the SCHEMA level):
--   This table has ZERO secret columns. There is NO *_api_key*, NO *_auth*, NO
--   *_encrypted column. A provider key / MCP auth token CANNOT leak into a template
--   because there is physically nowhere to store it. Only the publicly shareable
--   spec lives here. mcp_endpoint_url is the (shareable) URL; the auth token is NOT.

CREATE TABLE IF NOT EXISTS agent_templates (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_tg_user_id  BIGINT NOT NULL,                  -- matches agents.tg_user_id (the publisher)

  -- SHAREABLE PUBLIC SPEC (no secrets) ------------------------------------
  name               TEXT,
  description        TEXT,
  system_prompt      TEXT,
  model_slug         TEXT,                             -- model NAME only
  tools              JSONB NOT NULL DEFAULT '[]',       -- skills + tool defs
  mcp_endpoint_url   TEXT,                             -- shareable URL; the AUTH token is NOT stored
  suggested_skills   JSONB NOT NULL DEFAULT '[]',

  -- MONEY / ACCESS (Slice 2 uses price_credits; Slice 1 only reads NULL=free)
  price_credits      BIGINT,                           -- NULL = free; else author rent (US cents), > 0
  visibility         TEXT NOT NULL DEFAULT 'public',   -- 'public' | 'unlisted' | 'private'
  fork_parent_id     UUID,                             -- lineage / remix (single-hop), nullable

  clone_count        INT NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_templates_public
  ON agent_templates(visibility, created_at DESC) WHERE visibility = 'public';
CREATE INDEX IF NOT EXISTS idx_agent_templates_author
  ON agent_templates(author_tg_user_id, created_at DESC);
