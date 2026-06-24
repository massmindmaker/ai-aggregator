import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';
import { hasCreatorMembership, grantMembership } from '@/lib/membership';
import { ownsMembershipNft } from '@/lib/nft-ownership';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

/**
 * GET /api/tma/membership — is the caller a creator (may create agents from scratch)?
 */
export async function GET(req: NextRequest) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const isMember = await hasCreatorMembership(tgUserId, sql);
  return NextResponse.json({ is_member: isMember });
}

/**
 * POST /api/tma/membership — sync membership from on-chain NFT ownership.
 * Reads the caller's latest VERIFIED TON wallet; if it owns a membership-NFT item, grants
 * membership. Never 500s on the on-chain path — degrades to { synced:false }.
 */
export async function POST(req: NextRequest) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const current = await hasCreatorMembership(tgUserId, sql);

  // Latest verified wallet for the caller (only is_verified=true rows count).
  let address: string | null = null;
  try {
    const rows = (await sql`
      SELECT address
      FROM ton_wallets
      WHERE tg_user_id = ${tgUserId}::bigint AND is_verified = true
      ORDER BY last_seen_at DESC
      LIMIT 1
    `) as unknown as Array<{ address: string }>;
    address = rows[0]?.address ?? null;
  } catch {
    address = null;
  }

  if (!address) {
    return NextResponse.json({ is_member: current, synced: false });
  }

  // On-chain check is best-effort: ownsMembershipNft never throws (false on error/timeout
  // or when the collection is unconfigured).
  const owns = await ownsMembershipNft(address);
  if (!owns) {
    return NextResponse.json({ is_member: current, synced: false });
  }

  try {
    await grantMembership(tgUserId, sql, { source: 'nft' });
  } catch {
    // DB hiccup on the grant — don't 500; report not-synced, the user can retry.
    return NextResponse.json({ is_member: current, synced: false });
  }

  return NextResponse.json({ is_member: true, synced: true });
}
