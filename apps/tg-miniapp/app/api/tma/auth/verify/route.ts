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

// Free-first-run grant (canon §6, founder-approved): a brand-new user gets a
// one-time welcome grant of credits so they can try an agent WITHOUT topping up
// (виральный онбординг). Value in US cents (1 credit = 1 cent). Default = 30000
// = $300 = 300 кр. Override via FREE_FIRST_RUN_CREDITS. Set to 0 to disable.
const FREE_GRANT_CREDITS = (() => {
  const raw = Number(process.env.FREE_FIRST_RUN_CREDITS);
  return Number.isInteger(raw) && raw >= 0 ? raw : 30_000;
})();

/**
 * Idempotently grant the one-time free-first-run credits to a user.
 *
 * MONEY-PATH SAFETY: this is purely ADDITIVE (a +credit, never a debit) and is
 * completely separate from settleRun — it touches only tg_user_balances (upsert)
 * and tg_ledger_entries (append-only). It does NOT touch the worker, gateway,
 * markup, or any debit path.
 *
 * IDEMPOTENCY: exactly one grant per user, FOREVER (anti-abuse). The ledger's
 * partial unique index `uq_ledger_ref (ref_kind, ref_id, kind) WHERE ref_id IS
 * NOT NULL` is the guard. ref_id is a UUID, so we derive a STABLE per-user UUID
 * from the telegram id via `md5(<id>)::uuid` (deterministic, no extension). The
 * INSERT uses `ON CONFLICT … DO NOTHING RETURNING` — if a grant row already
 * exists (any prior login, any concurrent request) it inserts nothing, RETURNING
 * is empty, and the balance is left untouched. The balance upsert runs ONLY when
 * the ledger row was actually inserted, so the +credit can never post twice.
 * Both statements run in ONE sql.begin → all-or-nothing.
 *
 * Failure here must NEVER block login — the caller swallows errors.
 */
async function grantFreeFirstRun(tgUserId: number): Promise<boolean> {
  if (FREE_GRANT_CREDITS <= 0) return false;
  let granted = false;
  await sql.begin(async (sql) => {
    // 1) Claim the one-and-only grant slot for this user (append-only ledger).
    //    Deterministic ref_id = md5(tg_user_id)::uuid → at most one 'free_grant'
    //    ledger row per user, enforced by uq_ledger_ref. balance_after is filled
    //    in step 2's RETURNING; here we provisionally set it equal to the delta
    //    and correct it after the upsert (kept consistent below).
    const claimed = (await sql`
      INSERT INTO tg_ledger_entries
        (tg_user_id, delta_credits, kind, ref_kind, ref_id, balance_after)
      VALUES
        (${tgUserId}::bigint, ${FREE_GRANT_CREDITS}, 'free_grant', 'free_grant',
         md5(${String(tgUserId)})::uuid, 0)
      ON CONFLICT (ref_kind, ref_id, kind) WHERE ref_id IS NOT NULL DO NOTHING
      RETURNING id::text
    `) as unknown as Array<{ id: string }>;

    // Already granted on a previous login (or a concurrent request won) → no-op.
    if (claimed.length === 0) return;

    // 2) Apply the +credit to the cached balance (upsert: creates the row if the
    //    user has none). Only reached when step 1 actually inserted the grant row.
    const bal = (await sql`
      INSERT INTO tg_user_balances (tg_user_id, balance_credits, updated_at)
      VALUES (${tgUserId}::bigint, ${FREE_GRANT_CREDITS}::bigint, NOW())
      ON CONFLICT (tg_user_id) DO UPDATE
        SET balance_credits = tg_user_balances.balance_credits + EXCLUDED.balance_credits,
            updated_at = NOW()
      RETURNING balance_credits::text AS balance_credits
    `) as unknown as Array<{ balance_credits: string }>;

    // 3) Backfill the ledger row's materialized balance_after now that we know it.
    await sql`
      UPDATE tg_ledger_entries
      SET balance_after = ${bal[0]!.balance_credits}::bigint
      WHERE id = ${claimed[0]!.id}::bigint
    `;

    granted = true;
  });
  return granted;
}

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

  // Free-first-run: grant one-time welcome credits (idempotent — at most once per
  // user, ever). Purely additive; never touches the debit/settle path. Must not
  // block login, so swallow any error and fall through to issuing the token.
  let freeGrantApplied = false;
  try {
    freeGrantApplied = await grantFreeFirstRun(user.id);
  } catch (e) {
    console.warn('[auth/verify] free-first-run grant skipped (non-fatal)', e);
  }

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

  // `freeGrant` lets the client surface a one-time "300 кр на старт" hint right
  // after the welcome credits land. `freeGrantCredits` is the configured amount
  // (cents) for display; null when grants are disabled.
  return NextResponse.json({
    token,
    user,
    freeGrant: freeGrantApplied,
    freeGrantCredits: FREE_GRANT_CREDITS > 0 ? FREE_GRANT_CREDITS : null,
  });
}
