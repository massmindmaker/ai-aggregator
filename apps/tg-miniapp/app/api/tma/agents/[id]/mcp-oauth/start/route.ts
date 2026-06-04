import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';
import { validateExternalUrl } from '@/lib/external-agent';
import {
  discoverMcpOauth,
  canonicalResource,
  makePkce,
  makeState,
  buildAuthorizeUrl,
} from '@/lib/mcp-oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Flow TTL: short — the user only needs to bounce out to the browser and back.
const FLOW_TTL_SEC = 600;

interface StartBody {
  server_url?: string;
  client_id?: string;
  authorization_server?: string; // optional AS issuer override (no-discovery path)
  scope?: string;
}

/**
 * POST /api/tma/agents/[id]/mcp-oauth/start
 *
 * Authed (middleware injects x-tma-user-id from the verified JWT) + agent
 * ownership re-checked at the SQL level. Probes the MCP server (RFC 9728/8414
 * discovery via safeFetch), generates PKCE + state, stores the transient flow
 * row server-side keyed by `state`, and returns the full authorize URL for the
 * TMA to openLink() out to the system browser.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  let body: StartBody;
  try {
    body = (await req.json()) as StartBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  // Ownership: the agent must belong to this user and be live.
  const owned = (await sql`
    SELECT id::text FROM agents
    WHERE id = ${params.id}::uuid AND tg_user_id = ${tgUserId}::bigint AND status != 'deleted'
    LIMIT 1
  `) as unknown as Array<{ id: string }>;
  if (owned.length === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const serverUrl = body.server_url?.trim();
  if (!serverUrl) return NextResponse.json({ error: 'server_url_required' }, { status: 400 });
  // SSRF pre-flight (the deep validation also happens inside safeFetch on every hop).
  const guard = validateExternalUrl(serverUrl);
  if (!guard.ok) return NextResponse.json({ error: `mcp_${guard.reason}` }, { status: 400 });

  const clientId = body.client_id?.trim();
  if (!clientId) {
    // DCR is deferred in v1 → the user must paste a pre-registered client_id.
    return NextResponse.json({ error: 'client_id_required' }, { status: 400 });
  }
  if (body.authorization_server?.trim()) {
    const asGuard = validateExternalUrl(body.authorization_server.trim());
    if (!asGuard.ok) return NextResponse.json({ error: `as_${asGuard.reason}` }, { status: 400 });
  }

  // Discover authorization + token endpoints (best-effort, SSRF-guarded).
  const disc = await discoverMcpOauth(serverUrl, body.authorization_server?.trim() || null);
  if (!disc) {
    return NextResponse.json({ error: 'oauth_discovery_failed' }, { status: 502 });
  }

  const resource = canonicalResource(serverUrl);
  const { codeVerifier, codeChallenge } = makePkce();
  const state = makeState();
  const redirectUri = `${publicOrigin(req)}/tg/mcp-oauth/callback`;
  // Prefer a caller-requested scope; else the AS-advertised set (joined); else none.
  const scope = body.scope?.trim() || (disc.scopesSupported?.join(' ') || '') || null;

  // Persist the transient flow (verifier server-side ONLY, never to the webview).
  await sql`
    INSERT INTO mcp_oauth_flow
      (state, agent_id, tg_user_id, code_verifier, server_url, token_endpoint,
       client_id, redirect_uri, scope, expires_at)
    VALUES
      (${state}, ${params.id}::uuid, ${tgUserId}::bigint, ${codeVerifier}, ${resource},
       ${disc.tokenEndpoint}, ${clientId}, ${redirectUri}, ${scope},
       now() + ${`${FLOW_TTL_SEC} seconds`}::interval)
  `;

  const authorizeUrl = buildAuthorizeUrl({
    authorizationEndpoint: disc.authorizationEndpoint,
    clientId,
    redirectUri,
    codeChallenge,
    state,
    resource,
    scope,
  });

  return NextResponse.json({ authorize_url: authorizeUrl });
}

/**
 * Public HTTPS origin behind nginz. Prefer the explicit env (stable, matches the
 * redirect_uri the user pre-registered with their AS); fall back to forwarded
 * headers. The redirect_uri MUST be exact-match + HTTPS.
 */
function publicOrigin(req: NextRequest): string {
  const env = process.env.TMA_PUBLIC_ORIGIN?.trim();
  if (env) return env.replace(/\/+$/, '');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? 'ai-aggregator.ru';
  return `https://${host}`;
}
