-- Phase 15 / Wave 04 hardening — external agent connection (BYO endpoint)
-- P1A-1: lets a user attach their own OpenAI-compatible endpoint instead of
-- relying on AIAG's bundled OpenRouter pipe.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS connection_type            VARCHAR(20) NOT NULL DEFAULT 'aiag',
  ADD COLUMN IF NOT EXISTS external_base_url          TEXT,
  ADD COLUMN IF NOT EXISTS external_api_key_encrypted BYTEA,
  ADD COLUMN IF NOT EXISTS external_api_key_hint      VARCHAR(8),
  ADD COLUMN IF NOT EXISTS external_model_slug        TEXT;

-- Sanity: connection_type can only be one of the two we support today.
ALTER TABLE agents
  DROP CONSTRAINT IF EXISTS agents_connection_type_chk;
ALTER TABLE agents
  ADD CONSTRAINT agents_connection_type_chk
  CHECK (connection_type IN ('aiag', 'external_openai'));

CREATE INDEX IF NOT EXISTS idx_agents_connection_type ON agents(connection_type);
