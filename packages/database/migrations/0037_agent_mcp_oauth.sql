-- =============================================================================
-- 0037: MCP servers via OAuth 2.1 + PKCE (S256) — THIN v1 (R19 / screen 30).
--
-- Adds OAUTH-protected remote MCP servers on top of the existing BASIC MCP
-- (agents.mcp_endpoint_url + agents.mcp_auth_encrypted static bearer, 0028).
-- The OAuth dance is plain HTTPS (no Hermes, no per-user process): the stateless
-- worker reads a stored (refreshable) access token instead of a static bearer.
--
-- Scope: authorization-code + PKCE S256 ONLY (DCR deferred — a manually-pasted
-- client_id is the spec-sanctioned fallback; best-effort RFC 9728/8414 discovery).
--
-- Two tables:
--
--  agent_mcp_oauth  — the DURABLE per-agent token record. One row per agent (the
--    agent already has ONE mcp_endpoint_url). Tokens are AES-256-GCM base64,
--    EXACTLY like BYOK keys (encryptSecret(value).toString('base64')) — NEVER
--    plaintext. Decrypted only at use time inside the worker/route.
--      server_url      — canonical MCP server URI = the RFC 8707 `resource`
--                        (token audience). Lowercase scheme/host, no trailing /.
--      token_endpoint  — AS token endpoint (discovered, used for exchange+refresh)
--      client_id       — OAuth public client id (manually configured or DCR'd)
--      access_token_enc/refresh_token_enc — AES-256-GCM base64 (refresh rotated)
--      expires_at      — access-token expiry (refresh-if-stale guard in worker)
--      scope           — granted scope (UI shows read-only, never the token)
--
--  mcp_oauth_flow   — the TRANSIENT PKCE state, keyed by `state` (CSRF nonce).
--    Single-use, short TTL (expires_at). The `code_verifier` lives server-side
--    ONLY (never in the webview), so the browser hop can't lose/leak it.
--
-- Additive only. Idempotent (CREATE TABLE IF NOT EXISTS). Touches NO money path
-- (OAuth-MCP is the user's OWN provider → 0 commission, like basic MCP).
--
-- PROD: migrations are MANUAL + UNTRACKED and the app role can't ALTER/CREATE.
-- Apply via `sudo -u postgres psql aiag` per the aiag-deploy recipe. Re-running
-- is safe (IF NOT EXISTS). DML-safe: no data backfill, no money columns touched.
-- =============================================================================

CREATE TABLE IF NOT EXISTS agent_mcp_oauth (
  agent_id          UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  server_url        TEXT        NOT NULL,   -- canonical MCP URI = RFC 8707 resource (audience)
  token_endpoint    TEXT        NOT NULL,   -- AS token endpoint (exchange + refresh)
  client_id         TEXT        NOT NULL,   -- OAuth public client id
  access_token_enc  TEXT        NOT NULL,   -- AES-256-GCM base64 (NEVER plaintext)
  refresh_token_enc TEXT,                   -- AES-256-GCM base64, rotated each refresh (NULL = none)
  expires_at        TIMESTAMPTZ,            -- access-token expiry
  scope             TEXT,                   -- granted scope (read-only in UI)
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mcp_oauth_flow (
  state          TEXT        PRIMARY KEY,   -- CSRF nonce + flow lookup key (single-use)
  agent_id       UUID        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tg_user_id     BIGINT      NOT NULL,      -- owner who started the flow (ownership re-check)
  code_verifier  TEXT        NOT NULL,      -- PKCE verifier — SERVER-SIDE ONLY, never in webview
  server_url     TEXT        NOT NULL,      -- canonical MCP URI (RFC 8707 resource)
  token_endpoint TEXT        NOT NULL,
  client_id      TEXT        NOT NULL,
  redirect_uri   TEXT        NOT NULL,      -- exact-match redirect (must equal callback)
  scope          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL       -- short TTL; callback rejects if past
);

-- Sweep helper: the callback deletes the consumed row; this index lets a future
-- janitor cheaply drop expired/abandoned flows. Cheap, additive.
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_flow_expires ON mcp_oauth_flow (expires_at);
