import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';

const JWT_SECRET = new TextEncoder().encode(
  process.env.TMA_JWT_SECRET ?? 'dev-only-change-in-prod',
);

export const config = {
  matcher: ['/api/tma/:path*'],
};

export async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  if (path.startsWith('/api/tma/auth/')) return NextResponse.next();

  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return NextResponse.json({ error: 'no_token' }, { status: 401 });

  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    const reqHeaders = new Headers(req.headers);
    reqHeaders.set('x-tma-user-id', String(payload.sub ?? ''));
    return NextResponse.next({ request: { headers: reqHeaders } });
  } catch {
    return NextResponse.json({ error: 'invalid_token' }, { status: 401 });
  }
}
