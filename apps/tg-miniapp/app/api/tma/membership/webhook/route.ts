import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import postgres from 'postgres';
import { isMembershipTier, type MembershipTier } from '@/lib/membership';
import { checkMembershipNft } from '@/lib/nft-ownership';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

/**
 * Startonus mint callback.
 *
 * ⚠️ The ONLY documented shape of the live callback is `StartonusCallback` in
 * packages/shared/src/startonus.ts:72-81 — `{ success, item, owner, referrers, mint,
 * userData }`. It carries NO `event` and NO `txHash`. The Phase-16 transfer webhook was
 * written against an `{event, txHash}` shape and has never survived a real mint, so we do
 * NOT trust that shape here: an unrecognised callback would 400 and leave a PAID charge
 * stuck 'pending' forever (issue #29 review, P0).
 *
 * We therefore gate on `success === true` (documented) and accept the `{event, txHash}`
 * fields DEFENSIVELY when present. Neither shape is assumed to be the only one.
 */
interface MembershipCallback {
  /** Documented: the mint succeeded. */
  success?: boolean;
  /** Documented: minted TEP-62 item address on TON (on-chain-unique). */
  item?: string;
  /** Documented: echoed from GenerateInvoiceParams.userData = our charge UUID. */
  userData?: string;
  /** Defensive (undocumented, seen in the Phase-16 code): lifecycle event name. */
  event?: string;
  /** Defensive (undocumented): TON tx hash. Preferred as the dedup key when present. */
  txHash?: string;
  /** Defensive: legacy alias for `item`. */
  nftAddress?: string;
  error?: string;
}

interface ChargeRow {
  id: string;
  tg_user_id: string;
  tier: string;
  status: string;
  recipient_address: string | null;
}

/** Higher wins. Used so a re-purchase can only UPGRADE a tier, never silently downgrade. */
const TIER_RANK: Record<MembershipTier, number> = { creator: 1, builder: 2, studio: 3 };

/**
 * POST /api/tma/membership/webhook — membership-purchase mint FINALIZER (issue #29).
 *
 * AUTHZ — three independent layers, because Startonus does NOT sign its callbacks:
 *   1. shared token (`x-webhook-token` header, or `?token=` query — the outbound API only
 *      accepts a callbackUrl, so the query form is what Startonus actually sends);
 *   2. `userData` must be an UNGUESSABLE existing charge UUID;
 *   3. an ON-CHAIN re-check: the charge's recipient wallet must actually hold an item in
 *      the membership collection. A query-string token can leak into nginx access logs and
 *      the buyer knows their own charge_id, so (1)+(2) alone could let a forged callback
 *      mint a free membership. Only the chain can confirm the mint really happened.
 *
 * IDEMPOTENCY (lesson of closed issue #4): the grant is gated on
 * `INSERT INTO tg_membership_tx_claims ... ON CONFLICT (onchain_key) DO NOTHING RETURNING`
 * inside the SAME sql.begin as the grant + settle. `onchain_key = txHash ?? item` — both
 * are on-chain-unique identities of the same mint. A replayed callback hits the PK conflict,
 * gets 0 rows back, and returns before the grant — no second membership, ever.
 */
export async function POST(req: NextRequest) {
  const WEBHOOK_SECRET = process.env.TRANSFER_WEBHOOK_SECRET;
  if (!WEBHOOK_SECRET || WEBHOOK_SECRET.length === 0) {
    console.error('[membership/webhook] TRANSFER_WEBHOOK_SECRET unset — refusing (fail-hard)');
    return NextResponse.json({ error: 'webhook_not_configured' }, { status: 503 });
  }
  {
    // Header first (nginx-injected / future signed path), query as the fallback that
    // Startonus actually uses today.
    const supplied =
      req.headers.get('x-webhook-token') ?? req.nextUrl.searchParams.get('token') ?? '';
    const got = Buffer.from(supplied);
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

  const { userData, success, event, txHash, item, nftAddress } = body;
  if (!userData) {
    return NextResponse.json({ error: 'missing_user_data' }, { status: 400 });
  }

  const rows = (await sql`
    SELECT id::text, tg_user_id::text AS tg_user_id, tier, status, recipient_address
    FROM tg_membership_charges WHERE id = ${userData}::uuid LIMIT 1
  `) as unknown as ChargeRow[];
  const c = rows[0];
  if (!c) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!isMembershipTier(c.tier)) {
    // The 0048 CHECK constraint already guarantees this; never trust it blindly right
    // before an INSERT that assumes the type.
    console.error('[membership/webhook] charge has invalid tier:', c.id, c.tier);
    return NextResponse.json({ error: 'invalid_charge_tier' }, { status: 500 });
  }
  const tier: MembershipTier = c.tier;

  // FAILURE — documented (`success:false`) or defensive (`event:'failed'|'error'`).
  if (success === false || event === 'failed' || event === 'error') {
    await sql`
      UPDATE tg_membership_charges SET status='failed'
      WHERE id = ${c.id}::uuid AND status NOT IN ('settled', 'failed')
    `;
    return NextResponse.json({ ok: true });
  }

  // Defensive: the Phase-16 shape's pre-mint events carry no minted item yet — record the
  // hash and wait for the real confirmation. The documented shape never sends these.
  if (event === 'invoice_paid' || event === 'paid') {
    await sql`
      UPDATE tg_membership_charges SET tx_hash = COALESCE(${txHash ?? null}, tx_hash)
      WHERE id = ${c.id}::uuid AND status = 'pending'
    `;
    return NextResponse.json({ ok: true });
  }

  // CONFIRMATION. Documented shape: `success === true`. Defensive: `event === 'minted'`.
  if (!(success === true || event === 'minted')) {
    return NextResponse.json({ ok: true, ignored: event ?? 'unknown' });
  }

  if (c.status === 'settled') return NextResponse.json({ ok: true, skipped: 'already_settled' });
  if (c.status === 'failed') return NextResponse.json({ ok: true, skipped: 'failed' });

  // Dedup key = the on-chain identity of this mint. `item` (documented) is the minted NFT
  // item address and is unique on chain; `txHash` (defensive) is preferred when present.
  const mintedItem = item ?? nftAddress ?? null;
  const onchainKey = txHash ?? mintedItem;
  if (!onchainKey) {
    // Fail-closed: with no on-chain identity we cannot prove exactly-once, so we refuse to
    // grant rather than risk an unguarded double-grant. The charge stays pending → the TTL
    // sweep in the purchase route releases the user (HIGH-1), and this is loud in the logs.
    console.error('[membership/webhook] confirmation with neither txHash nor item, charge:', c.id);
    return NextResponse.json({ error: 'missing_onchain_key' }, { status: 400 });
  }

  // PERSIST PAYMENT EVIDENCE BEFORE any path that can bail out below. Once we have an
  // on-chain identity for this charge, the user has (as far as we know) PAID. The TTL sweep
  // in the purchase route must therefore never expire this row — otherwise a charge stuck
  // behind a transient RPC failure would expire, the screen would re-open, and the user
  // could pay a SECOND time for the same membership. The sweep skips rows with evidence.
  await sql`
    UPDATE tg_membership_charges
    SET tx_hash      = COALESCE(${txHash ?? null}, tx_hash),
        item_address = COALESCE(${mintedItem}, item_address)
    WHERE id = ${c.id}::uuid AND status = 'pending'
  `;

  // ON-CHAIN RE-CHECK — the callback is unsigned; the chain is not.
  if (!c.recipient_address) {
    console.error('[membership/webhook] charge has no recipient_address, charge:', c.id);
    return NextResponse.json({ error: 'no_recipient_on_charge' }, { status: 400 });
  }
  const chain = await checkMembershipNft(c.recipient_address);
  if (chain.result === 'error' || chain.result === 'unconfigured') {
    // We could not ASK the chain (RPC down / collection unset). Not a denial: leave the
    // charge pending and 503 so the acquirer retries. Never grant on an unverified word.
    console.error('[membership/webhook] on-chain check unavailable:', chain.result, c.id);
    return NextResponse.json({ error: 'ownership_check_unavailable' }, { status: 503 });
  }
  if (chain.result !== 'owned') {
    // The chain says this wallet holds nothing in the collection → the callback is lying
    // (or wildly early). Do NOT grant. The charge stays pending; a genuine later callback,
    // once the item actually lands, will pass.
    console.error('[membership/webhook] callback claims mint but chain says not owned:', c.id);
    return NextResponse.json({ error: 'not_owned_on_chain' }, { status: 409 });
  }

  let alreadyClaimed = false;
  try {
    await sql.begin(async (sql) => {
      // a) CLAIM-GUARD: one on-chain mint <-> at most one membership grant, ever.
      //    0 rows ⇒ this mint was already claimed (a replayed callback) ⇒ no-op, no throw.
      const claim = (await sql`
        INSERT INTO tg_membership_tx_claims (onchain_key, charge_id, tg_user_id, tier)
        VALUES (${onchainKey}, ${c.id}::uuid, ${c.tg_user_id}::bigint, ${tier})
        ON CONFLICT (onchain_key) DO NOTHING
        RETURNING onchain_key
      `) as unknown as Array<{ onchain_key: string }>;
      if (claim.length === 0) {
        alreadyClaimed = true;
        return;
      }

      // b) GRANT. tg_memberships PK = tg_user_id (one row per user). LOW-1: a second
      //    purchase may only UPGRADE the tier — never downgrade a studio back to creator.
      await sql`
        INSERT INTO tg_memberships (tg_user_id, tier, nft_address, source)
        VALUES (${c.tg_user_id}::bigint, ${tier}, ${mintedItem}, 'nft')
        ON CONFLICT (tg_user_id) DO UPDATE SET
          tier = CASE
            WHEN ${TIER_RANK[tier]} >
                 COALESCE(CASE tg_memberships.tier
                   WHEN 'studio'  THEN 3
                   WHEN 'builder' THEN 2
                   WHEN 'creator' THEN 1
                 END, 0)
            THEN EXCLUDED.tier
            ELSE tg_memberships.tier
          END,
          nft_address = COALESCE(EXCLUDED.nft_address, tg_memberships.nft_address),
          source      = 'nft'
      `;

      // c) Settle the charge, guarded on NOT already settled (belt-and-suspenders on top
      //    of the claim gate).
      await sql`
        UPDATE tg_membership_charges
        SET status='settled',
            tx_hash      = COALESCE(${txHash ?? null}, tx_hash),
            item_address = COALESCE(${mintedItem}, item_address),
            settled_at   = NOW()
        WHERE id = ${c.id}::uuid AND status <> 'settled'
      `;
    });
  } catch (e) {
    // HIGH-1: mark the charge FAILED on any rollback so the buyer is never permanently
    // locked behind a stuck 'pending'. Guarded on 'pending' so a settled charge is never
    // overwritten. (The transfer webhook does this; ours previously did not.)
    console.error('membership finalize failed:', e);
    await sql`
      UPDATE tg_membership_charges SET status='failed'
      WHERE id = ${c.id}::uuid AND status = 'pending'
    `;
    return NextResponse.json({ ok: false, error: 'finalize_failed' }, { status: 500 });
  }

  if (alreadyClaimed) {
    return NextResponse.json({ ok: true, skipped: 'mint_already_claimed' });
  }
  return NextResponse.json({ ok: true });
}
