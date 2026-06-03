import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

/**
 * GET /api/tma/wallet — list current user's linked TON wallets + balance.
 */
export async function GET(req: NextRequest) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const wallets = (await sql`
    SELECT id::text, address, public_key, is_verified,
           linked_at, last_seen_at
    FROM ton_wallets
    WHERE tg_user_id = ${tgUserId}::bigint
    ORDER BY last_seen_at DESC
  `) as unknown as Array<{
    id: string;
    address: string;
    public_key: string | null;
    is_verified: boolean;
    linked_at: string;
    last_seen_at: string;
  }>;

  const balanceRows = (await sql`
    SELECT balance_credits::text AS balance_credits
    FROM tg_user_balances
    WHERE tg_user_id = ${tgUserId}::bigint
    LIMIT 1
  `) as unknown as Array<{ balance_credits: string }>;

  // D-1: balance is integer US cents (1 credit = $0.01). Returned as a string.
  const balance_credits = balanceRows[0]?.balance_credits ?? '0';

  return NextResponse.json({ wallets, balance_credits });
}
