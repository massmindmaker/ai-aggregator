import { NextRequest, NextResponse } from 'next/server';
import { probeExternalEndpoint, validateExternalUrl } from '@/lib/external-agent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/tma/agents/test-external
 * Body: { base_url: string, api_key: string }
 *
 * Used by the /agents/new "Свой агент" wizard. We don't persist anything —
 * just validate the URL (SSRF guard), then GET <base>/models with the
 * supplied bearer to confirm the endpoint is alive and the key is good.
 */
export async function POST(req: NextRequest) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: { base_url?: string; api_key?: string };
  try {
    body = (await req.json()) as { base_url?: string; api_key?: string };
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const base = body.base_url?.trim() ?? '';
  const key = body.api_key?.trim() ?? '';
  if (!base) return NextResponse.json({ error: 'base_url_required' }, { status: 400 });
  if (!key) return NextResponse.json({ error: 'api_key_required' }, { status: 400 });

  const guard = validateExternalUrl(base);
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: 400 });

  const probe = await probeExternalEndpoint(base, key);
  return NextResponse.json(probe, { status: probe.ok ? 200 : 502 });
}
