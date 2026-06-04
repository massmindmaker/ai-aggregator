import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';
import { encryptSecret } from '@/lib/crypto';
import { exchangeCode } from '@/lib/mcp-oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

interface FlowRow {
  agent_id: string;
  tg_user_id: string;
  code_verifier: string;
  server_url: string;
  token_endpoint: string;
  client_id: string;
  redirect_uri: string;
  scope: string | null;
}

/**
 * POST /api/tma/mcp-oauth/callback  — called by the public callback PAGE.
 *
 * NOT JWT-authed: the OAuth redirect lands the user in the system browser with
 * no TMA token. Trust comes from the single-use, short-TTL `state` (CSRF nonce)
 * that only our /start route could have minted and stored server-side. This
 * route is in the middleware public-allowlist.
 *
 * Steps: load the flow by `state` (reject missing/expired → single-use by
 * deleting it), exchange the code at token_endpoint (PKCE + RFC 8707 resource,
 * SSRF-guarded), encrypt access+refresh tokens (AES-256-GCM base64, like BYOK),
 * UPSERT agent_mcp_oauth, delete the flow row. Never returns the token.
 */
export async function POST(req: NextRequest) {
  let body: { code?: string; state?: string };
  try {
    body = (await req.json()) as { code?: string; state?: string };
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const code = body.code?.trim();
  const state = body.state?.trim();
  if (!code || !state) return NextResponse.json({ error: 'missing_code_or_state' }, { status: 400 });

  // Single-use: atomically claim + delete the flow row keyed by state. A second
  // callback with the same state finds nothing (replay/CSRF defense). The
  // expires_at guard rejects a stale flow in the same statement.
  const flows = (await sql`
    DELETE FROM mcp_oauth_flow
    WHERE state = ${state} AND expires_at > now()
    RETURNING agent_id::text, tg_user_id::text, code_verifier, server_url,
              token_endpoint, client_id, redirect_uri, scope
  `) as unknown as FlowRow[];
  const flow = flows[0];
  if (!flow) return NextResponse.json({ error: 'invalid_or_expired_state' }, { status: 400 });

  // Exchange the authorization code for tokens (PKCE + resource audience).
  const tok = await exchangeCode({
    tokenEndpoint: flow.token_endpoint,
    code,
    codeVerifier: flow.code_verifier,
    clientId: flow.client_id,
    redirectUri: flow.redirect_uri,
    resource: flow.server_url,
  });
  if (!tok) return NextResponse.json({ error: 'token_exchange_failed' }, { status: 502 });

  const accessEnc = encryptSecret(tok.accessToken).toString('base64');
  const refreshEnc = tok.refreshToken ? encryptSecret(tok.refreshToken).toString('base64') : null;
  const expiresAt =
    tok.expiresInSec && tok.expiresInSec > 0
      ? new Date(Date.now() + tok.expiresInSec * 1000).toISOString()
      : null;
  const scope = tok.scope ?? flow.scope;

  // UPSERT the durable token record (one row per agent).
  await sql`
    INSERT INTO agent_mcp_oauth
      (agent_id, server_url, token_endpoint, client_id, access_token_enc,
       refresh_token_enc, expires_at, scope, updated_at)
    VALUES
      (${flow.agent_id}::uuid, ${flow.server_url}, ${flow.token_endpoint},
       ${flow.client_id}, ${accessEnc}, ${refreshEnc}, ${expiresAt}, ${scope}, now())
    ON CONFLICT (agent_id) DO UPDATE SET
      server_url        = EXCLUDED.server_url,
      token_endpoint    = EXCLUDED.token_endpoint,
      client_id         = EXCLUDED.client_id,
      access_token_enc  = EXCLUDED.access_token_enc,
      refresh_token_enc = EXCLUDED.refresh_token_enc,
      expires_at        = EXCLUDED.expires_at,
      scope             = EXCLUDED.scope,
      updated_at        = now()
  `;

  // Mirror the basic-MCP endpoint column so the worker's MCP-attach path fires
  // and the agent-detail UI shows the server as connected. The OAuth row takes
  // priority over any static bearer at run time.
  await sql`
    UPDATE agents SET mcp_endpoint_url = ${flow.server_url}, updated_at = now()
    WHERE id = ${flow.agent_id}::uuid
  `;

  return NextResponse.json({ ok: true });
}
