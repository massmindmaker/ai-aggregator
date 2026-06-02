import { NextResponse } from 'next/server';
import { SignJWT } from 'jose';
import postgres from 'postgres';
import { verifyInitData } from '@/lib/verify-init-data';

export const runtime = 'nodejs';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

// R0-5: fail hard at module load if TMA_JWT_SECRET is missing or too short.
// Never fall back to a hardcoded dev secret — the process must fail to serve
// rather than silently accept tokens forged with a known value.
const RAW_SECRET = process.env.TMA_JWT_SECRET;
if (!RAW_SECRET || RAW_SECRET.length < 32) {
  throw new Error('TMA_JWT_SECRET unset or shorter than 32 chars — refusing to start');
}
const JWT_SECRET = new TextEncoder().encode(RAW_SECRET);

export async function POST(req: Request) {
  const { initData } = await req.json().catch(() => ({}));
  if (typeof initData !== 'string') {
    return NextResponse.json({ error: 'init_data_required' }, { status: 400 });
  }
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return NextResponse.json({ error: 'bot_token_not_configured' }, { status: 503 });
  }

  const result = verifyInitData(initData, botToken);
  if (!result.ok) {
    return NextResponse.json(
      { error: 'invalid_init_data', reason: result.reason },
      { status: 401 },
    );
  }

  const { user, authDate } = result;

  await sql`
    INSERT INTO tg_users (telegram_id, first_name, last_name, username, photo_url, language_code, auth_date)
    VALUES (${user.id}, ${user.first_name ?? null}, ${user.last_name ?? null}, ${user.username ?? null}, ${user.photo_url ?? null}, ${user.language_code ?? null}, ${authDate})
    ON CONFLICT (telegram_id) DO UPDATE SET
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      username = EXCLUDED.username,
      photo_url = EXCLUDED.photo_url,
      language_code = EXCLUDED.language_code,
      auth_date = EXCLUDED.auth_date,
      updated_at = NOW()
  `;

  // R0-4: issue token with iss/aud matching the middleware's verify options,
  // and a jti (UUID) so a future revocation phase can key on it for denylist lookup.
  // crypto.randomUUID() is available on Node.js (runtime = 'nodejs') and in the
  // global Web Crypto API — no explicit import required.
  const token = await new SignJWT({
    sub: String(user.id),
    name: user.first_name,
    username: user.username,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer('aiag-tma')
    .setAudience('aiag-gateway')
    .setJti(crypto.randomUUID())
    .setExpirationTime('24h')
    .sign(JWT_SECRET);

  return NextResponse.json({ token, user });
}
