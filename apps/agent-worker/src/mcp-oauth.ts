/**
 * MCP OAuth — worker-side token resolution (R19 / screen 30, THIN v1).
 *
 * The TMA owns the interactive authorization-code + PKCE leg. The stateless
 * worker only needs, at MCP connect time, to:
 *   1. read the agent's stored (encrypted) OAuth token,
 *   2. refresh it if expired/near-expiry (refresh_token grant via safeFetch),
 *   3. persist the rotated tokens with a GUARDED UPDATE (survive concurrent-run
 *      refresh races — public-client refresh-token rotation invalidates the old
 *      one, so the loser re-reads the freshly-stored token),
 *   4. hand back a `Bearer <access_token>` for the existing MCP transport.
 *
 * SECURITY: refresh hop via safeFetch (allowlist [] → SSRF-guarded, HTTPS-only).
 * Tokens are AES-256-GCM at rest and NEVER logged. No token passthrough: the
 * MCP token is only ever sent to the token endpoint / that MCP server.
 */

import { sql } from './db.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { safeFetch } from './safe-fetch.js';

const REFRESH_SKEW_MS = 60_000; // refresh if within 60s of expiry
const TOKEN_TIMEOUT_MS = 10_000;

interface OauthRow {
  server_url: string;
  token_endpoint: string;
  client_id: string;
  access_token_enc: string;
  refresh_token_enc: string | null;
  expires_at: string | null;
}

/**
 * Resolve a usable MCP Bearer for an agent that has an agent_mcp_oauth row.
 * Returns null when no OAuth row exists (caller falls back to the static-bearer
 * path) or when refresh fails (caller degrades to tool-less, never blocks run).
 */
export async function resolveMcpOauthBearer(agentId: string): Promise<string | null> {
  const rows = (await sql`
    SELECT server_url, token_endpoint, client_id,
           access_token_enc, refresh_token_enc,
           expires_at::text AS expires_at
    FROM agent_mcp_oauth
    WHERE agent_id = ${agentId}::uuid
    LIMIT 1
  `) as unknown as OauthRow[];
  const row = rows[0];
  if (!row) return null;

  const expMs = row.expires_at ? Date.parse(row.expires_at) : NaN;
  const stale = !Number.isNaN(expMs) && expMs - REFRESH_SKEW_MS <= Date.now();

  if (!stale || !row.refresh_token_enc) {
    // Fresh (or no refresh token to rotate) → use the stored access token.
    try {
      return decryptSecret(Buffer.from(row.access_token_enc, 'base64'));
    } catch {
      return null;
    }
  }

  // Stale + refreshable → refresh, then persist with a guarded UPDATE.
  let refreshToken: string;
  try {
    refreshToken = decryptSecret(Buffer.from(row.refresh_token_enc, 'base64'));
  } catch {
    return null;
  }

  const refreshed = await refreshToken_(row.token_endpoint, row.client_id, refreshToken, row.server_url);
  if (!refreshed) {
    // Refresh failed (revoked/expired): a concurrent run may have ALREADY rotated
    // the token in our DB. Re-read once — if it changed, use the fresh access
    // token; else give up (caller degrades tool-less).
    const reread = (await sql`
      SELECT access_token_enc, refresh_token_enc
      FROM agent_mcp_oauth WHERE agent_id = ${agentId}::uuid LIMIT 1
    `) as unknown as Array<{ access_token_enc: string; refresh_token_enc: string | null }>;
    const fresh = reread[0];
    if (fresh && fresh.refresh_token_enc !== row.refresh_token_enc) {
      try {
        return decryptSecret(Buffer.from(fresh.access_token_enc, 'base64'));
      } catch {
        return null;
      }
    }
    return null;
  }

  const newAccessEnc = encryptSecret(refreshed.accessToken).toString('base64');
  const newRefreshEnc = refreshed.refreshToken
    ? encryptSecret(refreshed.refreshToken).toString('base64')
    : row.refresh_token_enc; // some AS don't rotate — keep the old one
  const newExpires =
    refreshed.expiresInSec && refreshed.expiresInSec > 0
      ? new Date(Date.now() + refreshed.expiresInSec * 1000).toISOString()
      : null;

  // GUARDED UPDATE: only the run holding THIS refresh token wins; a concurrent
  // run that already rotated changed refresh_token_enc, so this affects 0 rows.
  const upd = (await sql`
    UPDATE agent_mcp_oauth
    SET access_token_enc  = ${newAccessEnc},
        refresh_token_enc = ${newRefreshEnc},
        expires_at        = ${newExpires},
        updated_at        = now()
    WHERE agent_id = ${agentId}::uuid
      AND refresh_token_enc = ${row.refresh_token_enc}
    RETURNING agent_id::text
  `) as unknown as Array<{ agent_id: string }>;

  if (upd.length === 0) {
    // Lost the race: another run rotated first. Re-read the winning access token.
    const reread = (await sql`
      SELECT access_token_enc FROM agent_mcp_oauth WHERE agent_id = ${agentId}::uuid LIMIT 1
    `) as unknown as Array<{ access_token_enc: string }>;
    const fresh = reread[0];
    if (!fresh) return null;
    try {
      return decryptSecret(Buffer.from(fresh.access_token_enc, 'base64'));
    } catch {
      return null;
    }
  }

  return refreshed.accessToken;
}

interface RefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresInSec: number | null;
}

/** refresh_token grant (+ RFC 8707 resource) via safeFetch. Null on failure. */
async function refreshToken_(
  tokenEndpoint: string,
  clientId: string,
  refreshToken: string,
  resource: string,
): Promise<RefreshResult | null> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    resource,
  });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TOKEN_TIMEOUT_MS);
  try {
    const res = await safeFetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
      signal: ctrl.signal,
      allowlist: [],
    });
    if (!res.ok) return null;
    const j = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!j || typeof j.access_token !== 'string') return null;
    return {
      accessToken: j.access_token,
      refreshToken: typeof j.refresh_token === 'string' ? j.refresh_token : null,
      expiresInSec: typeof j.expires_in === 'number' ? j.expires_in : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
