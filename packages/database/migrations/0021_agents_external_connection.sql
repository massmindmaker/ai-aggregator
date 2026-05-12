-- Phase 15+ / Bring-Your-Own-Agent (Path 1 — OpenAI-compatible external endpoint)
-- The user pastes URL + API key in /agents/new. The worker hits that endpoint
-- instead of OpenRouter. Cost accounting is bypassed (user pays upstream).

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS connection_type            VARCHAR(20) NOT NULL DEFAULT 'aiag',
  ADD COLUMN IF NOT EXISTS external_base_url          TEXT,
  ADD COLUMN IF NOT EXISTS external_api_key_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS external_model_slug        TEXT;

-- Defensive — only two valid values for now.
ALTER TABLE agents
  ADD CONSTRAINT agents_connection_type_chk
  CHECK (connection_type IN ('aiag', 'external'));

-- An external agent without a base_url is meaningless; enforce at row level.
ALTER TABLE agents
  ADD CONSTRAINT agents_external_requires_url_chk
  CHECK (connection_type = 'aiag' OR external_base_url IS NOT NULL);
