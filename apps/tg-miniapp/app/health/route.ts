import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Liveness probe for the deploy script + pm2 healthcheck.
// Kept dependency-free on purpose — TMA's DB hits happen via `postgres` only
// inside /api/tma/* routes, and we don't want a misconfigured DATABASE_URL
// to fail the basic liveness check during a rolling deploy.
export function GET() {
  return NextResponse.json({
    ok: true,
    service: 'tg-miniapp',
    uptime_s: process.uptime(),
    ts: Date.now(),
  });
}
