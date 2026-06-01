-- =============================================================================
-- 0026: Provider catalog + agent credentials (P0 MVP foundation)
--
-- FOUNDATION SLICE — additive only. Changes NO execution path.
-- Does NOT touch the worker, gateway, or any UI.
--
-- Agent columns reused from prior migrations (no new columns added):
--   connection_type          — 0021_agents_external_connection.sql
--   external_base_url        — 0021_agents_external_connection.sql
--   external_api_key_encrypted — 0021_agents_external_connection.sql
--   external_api_key_hint    — 0021_agents_external_connection.sql (populated by route.ts)
--   external_model_slug      — 0021_agents_external_connection.sql
--   (constraint fix)         — 0022_agents_connection_type_fix.sql
--
-- New additions in THIS migration:
--   1. `providers` table — seeded catalog of BYO-key-compatible providers
--   2. `agent_provider_credentials` — per-agent encrypted credential store
--   3. Four new nullable columns on `agents`:
--      provider_id, model_id, auth_ref, base_url_override
--      (these co-exist with the legacy external_* columns for backward-compat;
--       the worker uses provider_id IS NOT NULL as the "new path" discriminator)
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
--             INSERT ... ON CONFLICT DO NOTHING.
-- Safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. providers — seeded catalog of BYO-key providers (OpenAI-compatible or near)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS providers (
  id                VARCHAR(64) PRIMARY KEY,
  name              TEXT        NOT NULL,
  api_base          TEXT,                        -- default OpenAI-compatible base URL; NULL for custom
  auth_kind         VARCHAR(16) NOT NULL DEFAULT 'api_key',  -- only 'api_key' for MVP; no oauth
  enabled           BOOLEAN     NOT NULL DEFAULT true,
  requires_base_url BOOLEAN     NOT NULL DEFAULT false,      -- true for the 'custom' sentinel provider
  sort              INT         NOT NULL DEFAULT 100,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT providers_auth_kind_chk CHECK (auth_kind IN ('api_key'))
);

-- Seed: 8 providers (all OpenAI-compatible wire format, all api_key auth)
-- ON CONFLICT DO NOTHING → safe to re-run; ops can UPDATE manually afterwards.
INSERT INTO providers (id, name, api_base, auth_kind, enabled, requires_base_url, sort) VALUES
  ('openai',     'OpenAI',     'https://api.openai.com/v1',        'api_key', true,  false, 10),
  ('anthropic',  'Anthropic',  'https://api.anthropic.com/v1',     'api_key', true,  false, 20),
  ('google',     'Google (Gemini)', 'https://generativelanguage.googleapis.com/v1beta/openai', 'api_key', true, false, 30),
  ('deepseek',   'DeepSeek',   'https://api.deepseek.com/v1',      'api_key', true,  false, 40),
  ('mistral',    'Mistral',    'https://api.mistral.ai/v1',        'api_key', true,  false, 50),
  ('groq',       'Groq',       'https://api.groq.com/openai/v1',   'api_key', true,  false, 60),
  ('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1',     'api_key', true,  false, 70),
  ('custom',     'Custom (OpenAI-compatible)', NULL,               'api_key', true,  true,  99)
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2. agent_provider_credentials — encrypted per-agent BYO key store
--
-- Crypto: AES-256-GCM (iv 12 bytes | ciphertext | tag 16 bytes), same format
-- as apps/tg-miniapp/src/lib/crypto.ts encryptSecret() / decryptSecret().
-- Key env: TMA_KEY_ENCRYPTION_KEY (already provisioned).
-- The raw key is NEVER stored in plaintext; only ciphertext + the last-4 hint.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_provider_credentials (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    UUID        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  provider_id VARCHAR(64) NOT NULL REFERENCES providers(id),
  base_url    TEXT,                   -- effective base URL (override for custom provider)
  model_id    TEXT,                   -- upstream model id the user selected
  enc_key     TEXT        NOT NULL,   -- AES-256-GCM ciphertext (base64 or hex, matches crypto.ts output)
  key_hint    TEXT,                   -- last 4 chars displayed in UI e.g. '***abcd'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- MVP: one external connection per agent
  UNIQUE (agent_id)
);

CREATE INDEX IF NOT EXISTS idx_apc_agent_id ON agent_provider_credentials(agent_id);

-- -----------------------------------------------------------------------------
-- 3. New nullable columns on agents (additive; legacy external_* stay in place)
--
-- provider_id     → links to providers(id); NULL means legacy aiag/external_openai path
-- model_id        → the upstream model the user picked (from provider catalog)
-- auth_ref        → FK to agent_provider_credentials(id); NULL for aiag kind
-- base_url_override → per-agent base URL override (used by 'custom' provider)
-- -----------------------------------------------------------------------------
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS provider_id        VARCHAR(64) REFERENCES providers(id),
  ADD COLUMN IF NOT EXISTS model_id           TEXT,
  ADD COLUMN IF NOT EXISTS auth_ref           UUID,
  ADD COLUMN IF NOT EXISTS base_url_override  TEXT;

-- auth_ref is a soft FK to agent_provider_credentials; we keep it nullable UUID
-- (not a hard FK) to avoid circular dependency issues during inserts where
-- the credential row is created before auth_ref is set.
-- Worker resolves: agents.auth_ref → agent_provider_credentials.id.
