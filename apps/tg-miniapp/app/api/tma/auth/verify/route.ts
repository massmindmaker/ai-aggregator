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

const REPLAY_TTL_SEC = Number(process.env.TMA_INITDATA_MAX_AGE_SEC) || 600;

/**
 * D-8: one-shot replay defense for a verified initData hash.
 * `SET <key> 1 NX EX <ttl>` succeeds only the first time within the TTL; a
 * second use of the same (already HMAC-valid) initData finds the key present
 * and is rejected as a replay. Bounds the replay window to a single use.
 *
 * FAIL-OPEN by design: if Redis is unreachable/errors, we ALLOW (and log a
 * warning) rather than locking out every user on a transient Redis blip. The
 * HMAC signature + max-age checks have already passed at this point, so a Redis
 * outage degrades us to "bounded-by-max-age replay window" — never to "no auth".
 *
 * @returns true if this is the first use (allow); false only on a confirmed replay.
 */
async function claimInitDataNonce(hash: string): Promise<boolean> {
  try {
    const IORedisMod = await import('ioredis');
    const IORedis = IORedisMod.default;
    const connection = new IORedis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
    });
    try {
      // 'OK' = we acquired the key (first use). null = key already existed (replay).
      const res = await connection.set(`tma:initdata:${hash}`, '1', 'EX', REPLAY_TTL_SEC, 'NX');
      return res === 'OK';
    } finally {
      await connection.quit().catch(() => connection.disconnect());
    }
  } catch (e) {
    // FAIL-OPEN: a transient Redis failure must not lock every user out.
    console.warn('[auth/verify] replay-nonce check skipped (Redis unavailable, fail-open)', e);
    return true;
  }
}

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

  const { user, authDate, hash } = result;

  // D-8: reject one-shot replay of an already-used (but still HMAC-valid) initData.
  // Fail-open inside claimInitDataNonce — Redis outage never blocks login.
  const fresh = await claimInitDataNonce(hash);
  if (!fresh) {
    return NextResponse.json(
      { error: 'invalid_init_data', reason: 'replayed' },
      { status: 401 },
    );
  }

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
