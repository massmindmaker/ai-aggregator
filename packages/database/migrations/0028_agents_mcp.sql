-- =============================================================================
-- 0028: agents MCP (skills) — attach one remote Streamable-HTTP MCP server.
--
-- feat-4 smallest slice: an agent can point at ONE user-supplied remote MCP
-- server (https only); the worker connects per-run (stateless, no resident
-- process — fits the 2GB VPS), lists its read-only tools, and dispatches them
-- through the existing OpenAI-style tool loop, SSRF-guarded via safeFetch.
--
--   mcp_endpoint_url    — the user's https MCP endpoint (NULL = no MCP attached)
--   mcp_auth_encrypted  — optional auth header value (e.g. "Bearer x"),
--                         AES-256-GCM base64 (same crypto as BYOK keys), NULL = none
--
-- Additive only. Idempotent (ADD COLUMN IF NOT EXISTS). Touches NO money path.
-- =============================================================================

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS mcp_endpoint_url   TEXT,
  ADD COLUMN IF NOT EXISTS mcp_auth_encrypted TEXT;
