import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/tma/agents/[id]/transfer/status?charge_id=<uuid>
 *
 * READ-ONLY status poll for the acquirer's transfer charge (R2). After the acquirer
 * signs the mint tx (TransferPanel), the original UI just showed "✓ отправлено" with
 * no way to know whether the transfer actually settled. This lets the client poll the
 * charge status until a terminal state.
 *
 * Money path UNTOUCHED: this only SELECTs transfer_charges.status. The authoritative
 * settle still happens on the Startonus webhook. Prepared statements only.
 *
 * Isolation: scoped to (id, charge_id, buyer_tg_user_id = caller) so a user can only
 * read the status of a charge THEY initiated — no cross-user oracle.
 *
 * Terminal: 'settled' (success) | 'failed'. Non-terminal: 'pending'.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  const chargeId = req.nextUrl.searchParams.get('charge_id');
  if (!chargeId || !UUID_RE.test(chargeId)) {
    return NextResponse.json({ error: 'invalid_charge_id' }, { status: 400 });
  }

  const rows = (await sql`
    SELECT status, kind, amount_credits::text AS amount_credits
    FROM transfer_charges
    WHERE id = ${chargeId}::uuid
      AND agent_id = ${params.id}::uuid
      AND buyer_tg_user_id = ${tgUserId}::bigint
    LIMIT 1
  `) as unknown as Array<{ status: string; kind: string; amount_credits: string }>;

  const c = rows[0];
  if (!c) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const terminal = c.status === 'settled' || c.status === 'failed';
  return NextResponse.json({
    status: c.status,
    kind: c.kind,
    amount_credits: c.amount_credits,
    terminal,
  });
}
