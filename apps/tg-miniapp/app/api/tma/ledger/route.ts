import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

interface LedgerRow {
  id: string;
  kind: string;
  delta_credits: string;
  ref_kind: string | null;
  balance_after: string | null;
  created_at: string;
}

/**
 * GET /api/tma/ledger — лента движения средств пользователя (P1-9 аудита).
 * Источник = append-only tg_ledger_entries (неизменяемая денежная истина D-1):
 * kinds: topup / run_debit / rent_debit / rent_credit / transfer_debit /
 * transfer_credit. Только чтение, скоуп по x-tma-user-id.
 */
export async function GET(req: NextRequest) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  try {
    const rows = (await sql`
      SELECT id::text, kind, delta_credits::text, ref_kind,
             balance_after::text, created_at
      FROM tg_ledger_entries
      WHERE tg_user_id = ${tgUserId}::bigint
      ORDER BY created_at DESC
      LIMIT 50
    `) as unknown as LedgerRow[];
    return NextResponse.json({ entries: rows });
  } catch (e) {
    console.error('ledger fetch error:', e);
    return NextResponse.json({ error: 'fetch_failed' }, { status: 500 });
  }
}
