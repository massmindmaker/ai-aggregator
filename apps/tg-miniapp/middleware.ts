import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify, errors } from 'jose';
import { isRevoked } from '@/lib/jwt-denylist';

// R0-5: fail hard at module load if TMA_JWT_SECRET is missing or too short.
// Throwing here causes Next to refuse to serve protected routes rather than
// silently accepting tokens forged with the dev-only fallback.
const RAW_SECRET = process.env.TMA_JWT_SECRET;
if (!RAW_SECRET || RAW_SECRET.length < 32) {
  throw new Error('TMA_JWT_SECRET unset or shorter than 32 chars — refusing to start');
}
const JWT_SECRET = new TextEncoder().encode(RAW_SECRET);

export const config = {
  matcher: ['/api/tma/:path*'],
};

export async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  // Public endpoints (no JWT required):
  //   /api/tma/auth/*           — verify endpoint
  //   /api/tma/mcp-oauth/callback — OAuth redirect target (no TMA JWT in the
  //                                 system browser; trust = single-use `state`)
  //   /api/tma/agents/.../transfer-offer — public acquirer offer read (the gift
  //                                 recipient/buyer is NOT the owner and has no token;
  //                                 non-sensitive SELECT + transferable-only filter)
  //   /api/tma/agents/transfer/webhook — Startonus mint callback (unsigned external
  //                                 caller, no TMA JWT; protected via nginx IP-allowlist
  //                                 + unguessable charge UUID + seller-guarded settle)
  if (
    path.startsWith('/api/tma/auth/') ||
    path === '/api/tma/mcp-oauth/callback' ||
    path === '/api/tma/agents/transfer/webhook' ||
    (path.startsWith('/api/tma/agents/') && path.endsWith('/transfer-offer')) ||
    path.startsWith('/api/tma/marketplace')
  ) {
    return NextResponse.next();
  }

  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return NextResponse.json({ error: 'no_token' }, { status: 401 });

  try {
    // R0-4: pin algorithm to HS256 (blocks alg-confusion / alg:none attacks),
    // and bind issuer + audience to match what auth/verify issues.
    const { payload } = await jwtVerify(token, JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'aiag-tma',
      audience: 'aiag-gateway',
    });

    // Live revocation: if this token's jti is on the denylist (stolen/logged-out),
    // reject it even though the signature is still valid. Only runs when the token
    // carries a jti AND the denylist store is configured — isRevoked() fails open
    // (returns false) on a missing store or a transient network error, so a Redis
    // blip never blocks legitimate users on the happy path.
    if (typeof payload.jti === 'string' && (await isRevoked(payload.jti))) {
      return NextResponse.json({ error: 'token_revoked' }, { status: 401 });
    }

    const reqHeaders = new Headers(req.headers);
    // R0-4 defense-in-depth: strip any inbound spoofed x-tma-user-id and the
    // CVE-2025-29927 bypass header before re-setting with the verified value.
    reqHeaders.delete('x-tma-user-id');
    reqHeaders.delete('x-middleware-subrequest');
    reqHeaders.set('x-tma-user-id', String(payload.sub ?? ''));

    return NextResponse.next({ request: { headers: reqHeaders } });
  } catch (err) {
    // Typed error handling — do NOT leak error message bodies to the client.
    if (err instanceof errors.JWTExpired) {
      return NextResponse.json({ error: 'token_expired' }, { status: 401 });
    }
    // Covers JOSEAlgNotAllowed, JWSSignatureVerificationFailed, JWTClaimValidationFailed, etc.
    return NextResponse.json({ error: 'invalid_token' }, { status: 401 });
  }
}
