import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/tma/membership/purchase/status?charge_id=<uuid>
 *
 * READ-ONLY status poll for the caller's own membership purchase charge (mirrors
 * agents/[id]/transfer/status). Scoped to (charge_id, tg_user_id = caller) — no
 * cross-user oracle. The authoritative settle still happens on the webhook.
 */
export async function GET(req: NextRequest) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const chargeId = req.nextUrl.searchParams.get('charge_id');
  if (!chargeId || !UUID_RE.test(chargeId)) {
    return NextResponse.json({ error: 'invalid_charge_id' }, { status: 400 });
  }

  const rows = (await sql`
    SELECT status, tier
    FROM tg_membership_charges
    WHERE id = ${chargeId}::uuid AND tg_user_id = ${tgUserId}::bigint
    LIMIT 1
  `) as unknown as Array<{ status: string; tier: string }>;

  const c = rows[0];
  if (!c) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // Terminal = anything the reconciler will not turn into a grant on its own within the
  // client's polling window. 'expired' (abandoned, unpaid) and 'needs_review' (paid but the
  // chain never showed the item — flagged for a human, still retried server-side) are both
  // terminal FOR THE CLIENT: it must stop polling rather than spin forever.
  const terminal = ['settled', 'failed', 'expired', 'needs_review'].includes(c.status);
  return NextResponse.json({ status: c.status, tier: c.tier, terminal });
}
