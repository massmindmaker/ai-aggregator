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
  | { ok: true; user: TGUser; authDate: Date }
  | { ok: false; reason: string };

/**
 * Verify Telegram WebApp initData via HMAC-SHA256.
 * Algorithm: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
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

  if (computedHash !== hash) return { ok: false, reason: 'hash_mismatch' };

  const authDate = Number(params.get('auth_date') ?? 0);
  if (!authDate) return { ok: false, reason: 'missing_auth_date' };
  const ageSec = Date.now() / 1000 - authDate;
  if (ageSec > 86400) return { ok: false, reason: 'expired' };

  const userJson = params.get('user');
  if (!userJson) return { ok: false, reason: 'missing_user' };
  let user: TGUser;
  try {
    user = JSON.parse(userJson);
  } catch {
    return { ok: false, reason: 'invalid_user_json' };
  }

  return { ok: true, user, authDate: new Date(authDate * 1000) };
}
