import crypto from 'node:crypto';

export interface TGUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  language_code?: string;
}

export type VerifyResult =
  | { ok: true; user: TGUser; authDate: Date; hash: string }
  | { ok: false; reason: string };

/**
 * Default freshness window for initData (seconds). initData is used exactly
 * once at login (we mint a 24h JWT on first verify), so a wide window only
 * widens the replay window. Tighten to 10 min; override via env.
 */
const DEFAULT_MAX_AGE_SEC = 600;

function initDataMaxAgeSec(): number {
  const raw = Number(process.env.TMA_INITDATA_MAX_AGE_SEC);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_AGE_SEC;
}

/**
 * Verify Telegram WebApp initData via HMAC-SHA256.
 * Algorithm: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * Secret-key derivation (per spec): secretKey = HMAC_SHA256(key='WebAppData', msg=bot_token),
 * then computedHash = HMAC_SHA256(key=secretKey, msg=data_check_string).
 */
export function verifyInitData(rawInitData: string, botToken: string): VerifyResult {
  const params = new URLSearchParams(rawInitData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'missing_hash' };
  params.delete('hash');

  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  // Constant-time compare. A plain `!==` short-circuits at the first differing
  // byte → timing oracle on the 64-hex-char digest. timingSafeEqual throws if
  // the buffers differ in length, so length-check first (a wrong-length hash is
  // a mismatch, not a 500). Buffer.from(hex) silently drops invalid/odd input,
  // so we also verify both decode to a full 32-byte SHA-256 digest.
  const expected = Buffer.from(computedHash, 'hex');
  const provided = Buffer.from(hash, 'hex');
  if (
    expected.length !== 32 ||
    provided.length !== expected.length ||
    !crypto.timingSafeEqual(expected, provided)
  ) {
    return { ok: false, reason: 'hash_mismatch' };
  }

  const authDate = Number(params.get('auth_date') ?? 0);
  if (!authDate) return { ok: false, reason: 'missing_auth_date' };
  const ageSec = Date.now() / 1000 - authDate;
  if (ageSec > initDataMaxAgeSec()) return { ok: false, reason: 'expired' };

  const userJson = params.get('user');
  if (!userJson) return { ok: false, reason: 'missing_user' };
  let user: TGUser;
  try {
    user = JSON.parse(userJson);
  } catch {
    return { ok: false, reason: 'invalid_user_json' };
  }

  // Surface the verified hash so the caller can use it as a one-shot replay nonce.
  return { ok: true, user, authDate: new Date(authDate * 1000), hash };
}
