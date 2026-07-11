import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import postgres from 'postgres';
import { isMembershipTier, type MembershipTier } from '@/lib/membership';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

/** Startonus mint callback payload — same rewritten shape as the transfer webhook. */
interface MembershipCallback {
  success?: boolean;
  /** Our tg_membership_charges.id UUID */
  userData?: string;
  /** Startonus event: invoice_paid | paid | minted | failed | error */
  event?: string;
  /** TON tx hash */
  txHash?: string;
  /** Minted NFT item contract address */
  item?: string;
  nftAddress?: string;
  error?: string;
}

interface ChargeRow {
  id: string;
  tg_user_id: string;
  tier: string;
  status: string;
}

/**
 * POST /api/tma/membership/webhook — membership-purchase mint FINALIZER (issue #29).
 *
 * Mirrors the KEYSTONE transfer webhook (…/agents/transfer/webhook) exactly, including
 * its auth model: Startonus does not sign callbacks, so we authenticate via the SAME
 * shared TRANSFER_WEBHOOK_SECRET token (issue contract), plus the userData charge UUID
 * is unguessable.
 *
 * IDEMPOTENCY (issue #29 / lesson of closed issue #4): a membership is granted ONLY
 * after `INSERT INTO tg_membership_tx_claims ... ON CONFLICT (tx_hash) DO NOTHING
 * RETURNING` returns a row, inside the SAME sql.begin as the grant + the charge settle.
 * A replayed 'minted' callback for the same tx_hash hits the PK conflict, the INSERT
 * returns 0 rows, the transaction body returns early — no second membership row is
 * ever written (grantMembership's own ON CONFLICT(tg_user_id) upsert would already be
 * a no-op-ish update, but the tx-claim gate is what proves "this exact payment was
 * only ever applied once", matching the topup dedup precedent).
 */
export async function POST(req: NextRequest) {
  const WEBHOOK_SECRET = process.env.TRANSFER_WEBHOOK_SECRET;
  if (!WEBHOOK_SECRET || WEBHOOK_SECRET.length === 0) {
    console.error('[membership/webhook] TRANSFER_WEBHOOK_SECRET unset — refusing (fail-hard)');
    return NextResponse.json({ error: 'webhook_not_configured' }, { status: 503 });
  }
  {
    const got = Buffer.from(req.nextUrl.searchParams.get('token') ?? '');
    const want = Buffer.from(WEBHOOK_SECRET);
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  let body: MembershipCallback;
  try {
    body = (await req.json()) as MembershipCallback;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const { userData, event, txHash, item, nftAddress } = body;
  if (!userData || !event) {
    return NextResponse.json({ error: 'missing_required' }, { status: 400 });
  }

  const rows = (await sql`
    SELECT id::text, tg_user_id::text AS tg_user_id, tier, status
    FROM tg_membership_charges WHERE id = ${userData}::uuid LIMIT 1
  `) as unknown as ChargeRow[];
  const c = rows[0];
  if (!c) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!isMembershipTier(c.tier)) {
    // Defence-in-depth: the DB CHECK constraint (0048) already guarantees this, but
    // never trust a value blindly right before an INSERT that assumes the type.
    console.error('[membership/webhook] charge has invalid tier:', c.id, c.tier);
    return NextResponse.json({ error: 'invalid_charge_tier' }, { status: 500 });
  }
  const tier: MembershipTier = c.tier;

  if (event === 'failed' || event === 'error') {
    await sql`
      UPDATE tg_membership_charges SET status='failed'
      WHERE id = ${c.id}::uuid AND status NOT IN ('settled', 'failed')
    `;
    return NextResponse.json({ ok: true });
  }

  if (event === 'invoice_paid' || event === 'paid') {
    // Record the tx hash; leave status pending — the 'minted' event does the grant.
    await sql`
      UPDATE tg_membership_charges SET tx_hash = COALESCE(${txHash ?? null}, tx_hash)
      WHERE id = ${c.id}::uuid AND status = 'pending'
    `;
    return NextResponse.json({ ok: true });
  }

  if (event === 'minted') {
    if (c.status === 'settled') {
      return NextResponse.json({ ok: true, skipped: 'already_settled' });
    }
    if (c.status === 'failed') {
      return NextResponse.json({ ok: true, skipped: 'failed' });
    }
    if (!txHash) {
      // Fail-closed: without a tx_hash we cannot prove exactly-once via the claims
      // table, so we refuse to grant rather than risk an unguarded double-grant.
      console.error('[membership/webhook] minted event with no txHash, charge:', c.id);
      return NextResponse.json({ error: 'missing_tx_hash' }, { status: 400 });
    }

    let alreadyClaimed = false;
    try {
      await sql.begin(async (sql) => {
        // a) CLAIM-GUARD: one on-chain tx <-> at most one membership grant, ever.
        //    0 rows returned ⇒ this tx_hash was already claimed (replay of this same
        //    webhook, or — defence in depth — any other charge) ⇒ no-op, no throw.
        const claim = (await sql`
          INSERT INTO tg_membership_tx_claims (tx_hash, charge_id, tg_user_id, tier)
          VALUES (${txHash}, ${c.id}::uuid, ${c.tg_user_id}::bigint, ${tier})
          ON CONFLICT (tx_hash) DO NOTHING
          RETURNING tx_hash
        `) as unknown as Array<{ tx_hash: string }>;
        if (claim.length === 0) {
          alreadyClaimed = true;
          return;
        }

        // b) GRANT the membership (tg_memberships PK = tg_user_id — one row per user;
        //    a later, higher tier purchase upgrades it in place).
        await sql`
          INSERT INTO tg_memberships (tg_user_id, tier, nft_address, source)
          VALUES (${c.tg_user_id}::bigint, ${tier}, ${item ?? nftAddress ?? null}, 'nft')
          ON CONFLICT (tg_user_id) DO UPDATE SET
            tier        = EXCLUDED.tier,
            nft_address = COALESCE(EXCLUDED.nft_address, tg_memberships.nft_address),
            source      = 'nft'
        `;

        // c) Settle the charge + record the tx hash, guarded on NOT already settled
        //    (belt-and-suspenders on top of the tx-claim gate above).
        await sql`
          UPDATE tg_membership_charges
          SET status='settled', tx_hash = ${txHash}, settled_at = NOW()
          WHERE id = ${c.id}::uuid AND status <> 'settled'
        `;
      });
    } catch (e) {
      console.error('membership finalize failed:', e);
      return NextResponse.json({ ok: false, error: 'finalize_failed' }, { status: 500 });
    }

    if (alreadyClaimed) {
      return NextResponse.json({ ok: true, skipped: 'tx_already_claimed' });
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true, ignored: event });
}
