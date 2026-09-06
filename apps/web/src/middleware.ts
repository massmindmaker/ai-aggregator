import { NextResponse, type NextRequest } from 'next/server';

// Stub middleware (no auth-edge import) to avoid Node 22 + edge-runtime
// `Cannot redefine property: __import_unsupported` regression.
// Auth gating is enforced inside server components / route handlers via getServerSession.
export default function middleware(_req: NextRequest) {
  const response = NextResponse.next();
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  // K-2 (security audit t_408fc802): CSP against XSS/data-injection.
  // frame-src adds s3.timeweb.cloud on top of the audit recommendation —
  // the admin KYC queue embeds PDF documents from there in an <iframe>
  // (src/app/admin/kyc-queue/KycQueueClient.tsx) and default-src 'self'
  // would break that preview. img-src keeps the audit's https: wildcard:
  // raw <img> avatars (OAuth: lh3.googleusercontent.com, vk/yandex CDNs)
  // and next/image remote patterns (storage.yandexcloud.net etc.).
  response.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: https:; font-src 'self'; connect-src 'self'; " +
      "frame-src https://s3.timeweb.cloud; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  );
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|public|api/auth).*)'],
};
