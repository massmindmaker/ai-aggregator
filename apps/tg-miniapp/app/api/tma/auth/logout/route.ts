import { NextResponse } from 'next/server';
import { jwtVerify, errors } from 'jose';
import { revoke } from '@/lib/jwt-denylist';

export const runtime = 'nodejs';

// Mirror the verify route: fail hard at module load if the secret is unusable,
// rather than silently accepting/rejecting tokens with a bad key.
const RAW_SECRET = process.env.TMA_JWT_SECRET;
if (!RAW_SECRET || RAW_SECRET.length < 32) {
  throw new Error('TMA_JWT_SECRET unset or shorter than 32 chars — refusing to start');
}
const JWT_SECRET = new TextEncoder().encode(RAW_SECRET);

/**
 * POST /api/tma/auth/logout
 *
 * Revokes the caller's own token: verifies the Bearer JWT, takes its `jti`, and
 * adds it to the denylist with a TTL = the token's remaining lifetime, so the
 * "пропуск" stops working immediately even though the signature stays valid until
 * its natural exp.
 *
 * This route is public in the middleware matcher (under /api/tma/auth/*), so it
 * verifies the token itself. No body required — it acts on the presented token.
 *
 * Soft degradation: if the denylist store (Upstash) is not configured, revoke()
 * is a no-op (logged once) and this still returns 200 — the client clears its
 * local token regardless.
 */
export async function POST(req: Request) {
  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) {
    return NextResponse.json({ error: 'no_token' }, { status: 401 });
  }

  let payload;
  try {
    ({ payload } = await jwtVerify(token, JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'aiag-tma',
      audience: 'aiag-gateway',
    }));
  } catch (err) {
    // Expired tokens are already useless — treat logout as a success no-op.
    if (err instanceof errors.JWTExpired) {
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: 'invalid_token' }, { status: 401 });
  }

  const jti = typeof payload.jti === 'string' ? payload.jti : null;
  if (jti && typeof payload.exp === 'number') {
    const ttl = payload.exp - Math.floor(Date.now() / 1000);
    if (ttl > 0) {
      await revoke(jti, ttl);
    }
  }

  return NextResponse.json({ ok: true });
}
