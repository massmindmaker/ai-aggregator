-- Phase 15+ — agent key-value memory
-- Backs the `memory` tool (set/get/list). Scoped per-agent so an agent can
-- persist small facts across runs (preferences, names, running notes).
-- Lightweight by design: short text keys/values, capped at the app layer.

CREATE TABLE IF NOT EXISTS agent_memory (
  agent_id   UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  PRIMARY KEY (agent_id, key)
);

CREATE INDEX IF NOT EXISTS idx_agent_memory_agent ON agent_memory(agent_id);
