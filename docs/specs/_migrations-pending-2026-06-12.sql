-- Pending prod migrations (apply MANUALLY on the VPS — no tracking).
-- Apply with: sudo -u postgres psql aiag -f _migrations-pending-2026-06-12.sql
-- (the app user `aiag` cannot ALTER; see docs/ARCHITECTURE.md deploy topology).

-- 2026-06-12 — direct-clone-a-specific-agent (founder decision: cloneable flag + route).
-- Lets an owner opt a specific agent in to being cloned by other users via
-- POST /api/tma/agents/[id]/clone. The clone copies only the spec (name,
-- system_prompt, tools, model_slug, mcp_endpoint_url) and never secrets/memory/history.
-- Default false → no agent is cloneable until its owner explicitly enables it.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS cloneable boolean NOT NULL DEFAULT false;
