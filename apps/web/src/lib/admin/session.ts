// Lightweight admin step-up session — separate from the NextAuth session.
// A logged-in user with role=admin still has to pass through /admin-login
// (password) to get this cookie before /admin/* layouts render. Reduces
// blast radius if a user laptop is unlocked with a regular session active.
//
// Token format: base64url(`${userId}:${expiry_ms}:${hmac_sha256}`)
// Signed with NEXTAUTH_SECRET. TTL: 4 hours.

import { createHmac, timingSafeEqual } from 'node:crypto';

const ADMIN_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

function getSecret(): string {
  const s = process.env.NEXTAUTH_SECRET;
  if (!s) throw new Error('NEXTAUTH_SECRET is required for admin session signing');
  return s;
}

export function signAdminSession(userId: string): string {
  const expiry = Date.now() + ADMIN_TTL_MS;
  const payload = `${userId}:${expiry}`;
  const hmac = createHmac('sha256', getSecret()).update(payload).digest('base64url');
  return Buffer.from(`${payload}:${hmac}`, 'utf8').toString('base64url');
}

export async function verifyAdminSession(
  token: string | undefined,
  expectedUserId: string
): Promise<boolean> {
  if (!token) return false;
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const parts = decoded.split(':');
    if (parts.length !== 3) return false;
    const [userId, expStr, hmac] = parts;
    if (userId !== expectedUserId) return false;
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || exp < Date.now()) return false;
    const expected = createHmac('sha256', getSecret())
      .update(`${userId}:${expStr}`)
      .digest('base64url');
    const a = Buffer.from(hmac);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export const ADMIN_COOKIE_NAME = 'aiag_admin_session';
export const ADMIN_COOKIE_MAX_AGE_S = ADMIN_TTL_MS / 1000;
