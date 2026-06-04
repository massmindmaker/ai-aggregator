/**
 * MCP OAuth 2.1 + PKCE (S256) helpers — THIN v1 (R19 / screen 30).
 *
 * Implements the OAuth-2.1 subset the MCP Authorization spec (rev 2025-06-18)
 * profiles, scoped to authorization-code + PKCE S256 ONLY:
 *   - RFC 9728 protected-resource metadata discovery (+ WWW-Authenticate hint)
 *   - RFC 8414 authorization-server metadata discovery
 *   - PKCE S256 (code_verifier / code_challenge)
 *   - RFC 8707 `resource` audience binding (canonical MCP URI)
 *   - authorization-code token exchange + refresh-token grant
 *
 * DCR (RFC 7591) is DEFERRED: the caller supplies a manually-configured
 * client_id (the spec-sanctioned no-DCR fallback). Discovery is best-effort —
 * a server may not serve RFC 9728/8414, in which case the caller can pass an
 * explicit authorization_server / endpoints override.
 *
 * SECURITY (load-bearing):
 *  - EVERY outbound hop goes through `safeFetch` with allowlist `[]` → full SSRF
 *    validation (HTTPS-only, IP-range blocked, socket-pinned anti-rebind,
 *    per-redirect re-validated). Discovery/token URLs are attacker-influenced
 *    (they come from the user-supplied MCP server / its metadata), so they MUST
 *    be SSRF-guarded exactly like the MCP transport already is.
 *  - Tokens are never logged here. The caller encrypts them at rest (AES-256-GCM
 *    base64) before they touch the DB.
 */

import { createHash, randomBytes } from 'node:crypto';
import { safeFetch } from './safe-fetch';

const DISCOVERY_TIMEOUT_MS = 8000;
const TOKEN_TIMEOUT_MS = 10_000;

/** Base64URL (no padding) of a buffer. */
function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PKCE pair: high-entropy verifier + its S256 challenge. */
export function makePkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = b64url(randomBytes(48)); // 64-char URL-safe verifier
  const codeChallenge = b64url(createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

/** Opaque high-entropy CSRF/state nonce (also the flow-row PK). */
export function makeState(): string {
  return b64url(randomBytes(32));
}

/**
 * Canonicalize an MCP server URL into the RFC 8707 `resource` value: lowercase
 * scheme + host, strip default port, strip fragment, strip a trailing slash on
 * the path. Getting this wrong → the AS issues a token the MCP server rejects
 * with a permanent 401, so canonicalization is correctness-critical.
 */
export function canonicalResource(raw: string): string {
  const u = new URL(raw);
  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();
  u.hash = '';
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) {
    u.port = '';
  }
  let s = u.toString();
  // Drop a lone trailing slash (but keep "https://host/" → "https://host").
  if (s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

async function fetchJson(url: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await safeFetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: ctrl.signal,
      allowlist: [],
    });
    if (!res.ok) return null;
    return (await res.json().catch(() => null)) as Record<string, unknown> | null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export interface DiscoveredEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scopesSupported?: string[];
}

/**
 * Discover authorization + token endpoints for an MCP server, best-effort:
 *   1. Probe the MCP URL (no token) → read `WWW-Authenticate` for a
 *      resource-metadata URL hint (RFC 9728 §5.1).
 *   2. GET <mcp>/.well-known/oauth-protected-resource → `authorization_servers`.
 *   3. GET <as>/.well-known/oauth-authorization-server → endpoints (RFC 8414).
 * `asOverride` short-circuits steps 1–2 when the user pasted an AS issuer.
 *
 * All hops via safeFetch (SSRF). Returns null if endpoints can't be resolved.
 */
export async function discoverMcpOauth(
  mcpUrl: string,
  asOverride?: string | null,
): Promise<DiscoveredEndpoints | null> {
  const resource = canonicalResource(mcpUrl);
  let asIssuer = asOverride?.trim() || '';

  if (!asIssuer) {
    // (1) unauthenticated probe → parse WWW-Authenticate resource hint.
    let resourceMetaUrl = `${resource}/.well-known/oauth-protected-resource`;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), DISCOVERY_TIMEOUT_MS);
      const probe = await safeFetch(mcpUrl, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: ctrl.signal,
        allowlist: [],
      }).finally(() => clearTimeout(t));
      const wa = probe.headers.get('www-authenticate');
      const m = wa?.match(/resource_metadata="?([^",\s]+)"?/i);
      if (m?.[1]) resourceMetaUrl = new URL(m[1], resource).toString();
    } catch {
      // probe failure is non-fatal — fall through to the well-known default.
    }

    // (2) protected-resource metadata → authorization_servers[0].
    const prm = await fetchJson(resourceMetaUrl, DISCOVERY_TIMEOUT_MS);
    const servers = prm && Array.isArray(prm.authorization_servers)
      ? (prm.authorization_servers as unknown[])
      : [];
    const first = servers.find((s) => typeof s === 'string') as string | undefined;
    if (first) asIssuer = first;
  }

  if (!asIssuer) return null;

  // (3) AS metadata (RFC 8414). Try the issuer's well-known, both common shapes.
  const issuer = asIssuer.replace(/\/+$/, '');
  const asMetaUrls = [
    `${issuer}/.well-known/oauth-authorization-server`,
    `${issuer}/.well-known/openid-configuration`,
  ];
  for (const url of asMetaUrls) {
    const meta = await fetchJson(url, DISCOVERY_TIMEOUT_MS);
    const authEp = meta?.authorization_endpoint;
    const tokEp = meta?.token_endpoint;
    if (typeof authEp === 'string' && typeof tokEp === 'string') {
      const methods = Array.isArray(meta?.code_challenge_methods_supported)
        ? (meta!.code_challenge_methods_supported as unknown[])
        : null;
      // If the AS advertises PKCE methods, it MUST include S256 (we only do S256).
      if (methods && !methods.includes('S256')) continue;
      return {
        authorizationEndpoint: authEp,
        tokenEndpoint: tokEp,
        scopesSupported: Array.isArray(meta?.scopes_supported)
          ? (meta!.scopes_supported as unknown[]).filter((x): x is string => typeof x === 'string')
          : undefined,
      };
    }
  }
  return null;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresInSec: number | null;
  scope: string | null;
}

function parseTokenResponse(j: Record<string, unknown> | null): TokenResponse | null {
  if (!j || typeof j.access_token !== 'string') return null;
  return {
    accessToken: j.access_token,
    refreshToken: typeof j.refresh_token === 'string' ? j.refresh_token : null,
    expiresInSec: typeof j.expires_in === 'number' ? j.expires_in : null,
    scope: typeof j.scope === 'string' ? j.scope : null,
  };
}

/**
 * Exchange an authorization `code` for tokens (PKCE + RFC 8707 resource).
 * SSRF-guarded. Returns null on any non-2xx / unparseable response.
 */
export async function exchangeCode(args: {
  tokenEndpoint: string;
  code: string;
  codeVerifier: string;
  clientId: string;
  redirectUri: string;
  resource: string;
}): Promise<TokenResponse | null> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: args.code,
    code_verifier: args.codeVerifier,
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    resource: args.resource,
  });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TOKEN_TIMEOUT_MS);
  try {
    const res = await safeFetch(args.tokenEndpoint, {
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
    return parseTokenResponse((await res.json().catch(() => null)) as Record<string, unknown> | null);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Build the full authorize URL (response_type=code + PKCE S256 + state + the
 * RFC 8707 `resource` audience). `scope` omitted when empty.
 */
export function buildAuthorizeUrl(args: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  resource: string;
  scope?: string | null;
}): string {
  const u = new URL(args.authorizationEndpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', args.clientId);
  u.searchParams.set('redirect_uri', args.redirectUri);
  u.searchParams.set('code_challenge', args.codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', args.state);
  u.searchParams.set('resource', args.resource);
  if (args.scope?.trim()) u.searchParams.set('scope', args.scope.trim());
  return u.toString();
}
