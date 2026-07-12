import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';
import { hasCreatorMembership } from '@/lib/membership';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

/**
 * GET /api/tma/membership — is the caller a creator (may create agents from scratch)?
 * Pure DB read of `tg_memberships`. Never writes.
 */
export async function GET(req: NextRequest) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const isMember = await hasCreatorMembership(tgUserId, sql);
  return NextResponse.json({ is_member: isMember });
}

/**
 * POST /api/tma/membership — "refresh my status" (issue #29 round 6, P0-2 FIX).
 *
 * 🔴 THIS ROUTE NO LONGER GRANTS MEMBERSHIP. It used to sync a membership the moment the
 * caller's verified TON wallet was seen to HOLD an item in the membership collection — no
 * payment check, no idempotency key, no tier read. That was exploitable for real:
 * Startonus items are NOT soulbound (no SBT support, researched 2026-07-12), so ONE paid
 * mint could be moved to a second wallet, that wallet's owner hits this route, and gets a
 * free membership — repeatably, to as many accounts as the item is forwarded to. The old
 * grant also wrote `tier=NULL`, which the creation gate (#32) reads as UNLIMITED — the
 * free path was strictly better than paying for `studio`.
 *
 * The ONLY path that may write `tg_memberships` is now
 * apps/agent-worker/src/membership-reconciler.ts: it requires a PAID
 * `tg_membership_charges` row for THIS user AND a chain-confirmed collection item, claimed
 * exactly-once via `tg_membership_tx_claims` (one on-chain item → at most one grant, ever).
 * Holding the NFT is necessary but never sufficient.
 *
 * This route is now a pure DB re-read — identical to GET, exposed as POST only so the
 * existing "Проверить членство" button (apps/tg-miniapp/app/agents/page.tsx) keeps doing
 * something useful: it re-reads `tg_memberships` in case the reconciler granted since the
 * page loaded, without a full app reload. It performs NO on-chain check and NO write.
 */
export async function POST(req: NextRequest) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const isMember = await hasCreatorMembership(tgUserId, sql);
  return NextResponse.json({ is_member: isMember });
}
