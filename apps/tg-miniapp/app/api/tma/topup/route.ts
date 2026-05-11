import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

/**
 * GET /api/tma/topup — top-up history for current user (latest 20).
 */
export async function GET(req: NextRequest) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const rows = (await sql`
    SELECT id::text,
           wallet_address,
           amount_nano_ton::text AS amount_nano_ton,
           rate_rub_per_ton::text AS rate_rub_per_ton,
           amount_rub::text AS amount_rub,
           status,
           tx_hash,
           comment_tag,
           created_at,
           confirmed_at
    FROM tg_topups
    WHERE tg_user_id = ${tgUserId}::bigint
    ORDER BY created_at DESC
    LIMIT 20
  `) as unknown as Array<{
    id: string;
    wallet_address: string;
    amount_nano_ton: string;
    rate_rub_per_ton: string;
    amount_rub: string;
    status: string;
    tx_hash: string | null;
    comment_tag: string;
    created_at: string;
    confirmed_at: string | null;
  }>;

  return NextResponse.json({ topups: rows });
}
