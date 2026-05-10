/**
 * POST /api/admin/auth
 *
 * Step-up authentication for /admin/*. Even if the user already has a
 * NextAuth session with role=admin, they MUST re-enter their password here
 * to get the aiag_admin_session cookie. The /admin/* layout requires both.
 *
 * Body: { email: string, password: string }
 * Response 200: sets aiag_admin_session cookie, returns { ok: true }
 * Response 401: { error: 'invalid' | 'not_admin' | 'inactive' }
 */
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';
import { users } from '@aiag/database/schema';
import { eq } from '@aiag/database';
import {
  ADMIN_COOKIE_NAME,
  ADMIN_COOKIE_MAX_AGE_S,
  signAdminSession,
} from '@/lib/admin/session';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let body: { email?: unknown; password?: unknown } = {};
  try {
    body = (await req.json()) as { email?: unknown; password?: unknown };
  } catch {
    /* empty */
  }
  const email = typeof body.email === 'string' ? body.email.toLowerCase().trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password) {
    return NextResponse.json({ error: 'invalid' }, { status: 401 });
  }

  let user;
  try {
    user = await db.query.users.findFirst({ where: eq(users.email, email) });
  } catch {
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
  if (!user || !user.passwordHash) {
    return NextResponse.json({ error: 'invalid' }, { status: 401 });
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    return NextResponse.json({ error: 'invalid' }, { status: 401 });
  }
  if (user.isBanned || user.isActive === false) {
    return NextResponse.json({ error: 'inactive' }, { status: 401 });
  }
  if (user.role !== 'admin') {
    return NextResponse.json({ error: 'not_admin' }, { status: 401 });
  }

  const token = signAdminSession(user.id);
  const cookieStore = await cookies();
  cookieStore.set({
    name: ADMIN_COOKIE_NAME,
    value: token,
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: ADMIN_COOKIE_MAX_AGE_S,
  });

  return NextResponse.json({ ok: true });
}
