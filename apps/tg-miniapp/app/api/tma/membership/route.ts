import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';
import { hasCreatorMembership, grantMembership } from '@/lib/membership';
import { checkMembershipNft } from '@/lib/nft-ownership';

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
 * Reads the caller's latest VERIFIED TON wallet; if it owns a membership-NFT item in the
 * MEMBERSHIP_NFT_COLLECTION_ADDRESS collection (the SAME collection the purchase route
 * mints into), grants membership.
 *
 * Never 500s. Always returns an explicit `reason` alongside `synced:false` so an
 * unconfigured collection or a dead RPC is DISTINGUISHABLE from a genuine "this wallet
 * owns nothing" (issue #29 review — a silent `false` hid a misconfiguration and read as
 * a definitive non-membership verdict).
 *   reason: 'owned' | 'not_owned' | 'no_wallet' | 'unconfigured' | 'error' | 'grant_failed'
 * Only 'owned' grants. `unconfigured`/`error` mean "unknown", NOT "not a member" — the
 * DB stays the source of truth for ownership either way (`is_member` is the DB verdict).
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
    return NextResponse.json({ is_member: current, synced: false, reason: 'no_wallet' });
  }

  const check = await checkMembershipNft(address);
  if (check.result !== 'owned') {
    // 'unconfigured' / 'error' are NOT denials — surface them as-is. The on-chain sync
    // is a convenience path; the DB (fed by the purchase webhook) remains authoritative.
    if (check.result === 'unconfigured') {
      console.error('[membership] MEMBERSHIP_NFT_COLLECTION_ADDRESS unset — on-chain sync is OFF');
    }
    return NextResponse.json({ is_member: current, synced: false, reason: check.result });
  }

  try {
    await grantMembership(tgUserId, sql, { source: 'nft' });
  } catch {
    // DB hiccup on the grant — don't 500; report not-synced, the user can retry.
    return NextResponse.json({ is_member: current, synced: false, reason: 'grant_failed' });
  }

  return NextResponse.json({ is_member: true, synced: true, reason: 'owned' });
}
