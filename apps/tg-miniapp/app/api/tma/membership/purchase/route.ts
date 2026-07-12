import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';
import { generateInvoice, tonToNano } from '@aiag/shared';
import { checkRateLimit } from '@/lib/rate-limit';
import { MEMBERSHIP_TIERS, isMembershipTier } from '@/lib/membership';
import { membershipCollectionAddress } from '@/lib/nft-ownership';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

/**
 * How long an unpaid 'pending' charge blocks a new purchase (HIGH-1). A charge older than
 * this can no longer be paid — the TON Connect invoice it belongs to has expired — so it is
 * swept to 'expired' and stops blocking. Generous enough to cover a slow wallet confirm.
 */
const PENDING_TTL_MIN = 15;

interface Body {
  tier: string;
}

/**
 * POST /api/tma/membership/purchase — membership-NFT purchase INITIATE (issue #29).
 *
 * Insert a `pending` tg_membership_charges row, ask Startonus to lazily mint one
 * membership-tier NFT item onto the caller's VERIFIED wallet, and hand the client a TON
 * Connect transaction to sign. Payment is on-chain TON — no crypto-credit debit.
 *
 * The membership is NOT granted here. It is granted when the CHAIN confirms the mint —
 * by the reconciler (apps/agent-worker/src/membership-reconciler.ts, the authoritative
 * path) or, as a fast path, by the webhook. The Startonus callback is never trusted on
 * its own: it is unsigned, unretried, and has no status endpoint to ask.
 *
 * 🔴 HIGH-A: the mint recipient is read from `ton_wallets` (ton-proof VERIFIED wallets
 * only) — NEVER from the request body. Taking it from the body let a caller mint the NFT
 * they paid for onto an arbitrary address, and, worse, made the recipient a client-chosen
 * value that the on-chain grant check is keyed on.
 */
export async function POST(req: NextRequest) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const rl = await checkRateLimit('membership', tgUserId);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'too_many_requests', retry_after: rl.retryAfter },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const { tier } = body;
  if (!isMembershipTier(tier)) {
    return NextResponse.json({ error: 'invalid_tier' }, { status: 400 });
  }

  // HIGH-A: recipient = the caller's latest ton-proof-VERIFIED wallet. Any address in the
  // request body is ignored outright. No verified wallet → no purchase (the user must
  // connect + prove their wallet first), because the on-chain grant check is keyed on this
  // address: a client-supplied one would let the caller point the check at someone else's
  // wallet that already holds a collection item.
  const wal = (await sql`
    SELECT address
    FROM ton_wallets
    WHERE tg_user_id = ${tgUserId}::bigint AND is_verified = true
    ORDER BY last_seen_at DESC
    LIMIT 1
  `) as unknown as Array<{ address: string }>;
  const recipientAddress = wal[0]?.address ?? null;
  if (!recipientAddress) {
    return NextResponse.json({ error: 'wallet_not_verified' }, { status: 403 });
  }

  // HIGH-1 (issue #29 review): a pending charge used to be a PERMANENT lock. If the user
  // rejected the wallet prompt or closed Telegram, no callback ever arrived, the row stayed
  // 'pending' forever, and EVERY future purchase 409'd — the screen became a dead end for
  // that user. Sweep pendings older than the TTL to 'expired': they can no longer be settled
  // anyway (the TON Connect invoice's validUntil has long passed).
  //
  // CRITICAL GUARD — never expire a charge that carries PAYMENT EVIDENCE (tx_hash/item_address
  // written by the webhook the moment a mint callback arrives). Such a charge is paid but not
  // yet finalized (e.g. the on-chain re-check hit a transient RPC failure and 503'd for a
  // retry). Expiring it would re-open the purchase screen and let the user pay a SECOND time
  // for a membership they already bought. A paid-but-unsettled charge keeps blocking (409) —
  // which is correct: they must not be charged twice.
  await sql`
    UPDATE tg_membership_charges
    SET status = 'expired'
    WHERE tg_user_id = ${tgUserId}::bigint
      AND status = 'pending'
      AND created_at < NOW() - ${`${PENDING_TTL_MIN} minutes`}::interval
      AND tx_hash IS NULL
      AND item_address IS NULL
  `;

  const priceTon = MEMBERSHIP_TIERS[tier].priceTon;
  const amountNanoTon = tonToNano(priceTon);

  // MEDIUM-2 (TOCTOU): no SELECT-then-INSERT race. The partial UNIQUE
  // uq_membership_charges_one_pending (tg_user_id) WHERE status='pending' (migration 0048)
  // is the invariant; a still-live pending charge (or a concurrent second call) makes this
  // INSERT raise 23505, which we map to a clean 409.
  let chargeId: string;
  try {
    const ins = (await sql`
      INSERT INTO tg_membership_charges (
        tg_user_id, tier, amount_nano_ton, status, recipient_address, created_at
      )
      VALUES (
        ${tgUserId}::bigint, ${tier}, ${amountNanoTon.toString()}::bigint, 'pending',
        ${recipientAddress}, NOW()
      )
      RETURNING id::text
    `) as unknown as Array<{ id: string }>;
    const id = ins[0]?.id;
    if (!id) return NextResponse.json({ error: 'insert_failed' }, { status: 500 });
    chargeId = id;
  } catch (e) {
    if ((e as { code?: string }).code === '23505') {
      return NextResponse.json({ error: 'purchase_pending' }, { status: 409 });
    }
    throw e;
  }

  // ONE env var names the membership collection — the SAME one the ownership check reads
  // (src/lib/nft-ownership.ts). Minting into collection A while checking ownership against
  // collection B would let a user pay and never be seen as a member (issue #29 review).
  // STARTONUS_MEMBERSHIP_MINT_TEMPLATE_ID is a DIFFERENT entity: a Startonus mint-set
  // template id (an integer), not an address — mirrors STARTONUS_AGENT_MINT_TEMPLATE_ID.
  const secret = process.env.STARTONUS_SECRET;
  const collectionAddress = membershipCollectionAddress();
  const mintTemplateId = process.env.STARTONUS_MEMBERSHIP_MINT_TEMPLATE_ID;
  if (!secret || !collectionAddress || !mintTemplateId) {
    await sql`UPDATE tg_membership_charges SET status='failed' WHERE id = ${chargeId}::uuid`;
    return NextResponse.json({ error: 'minter_not_configured' }, { status: 503 });
  }

  const publicBase = process.env.PUBLIC_BASE_URL ?? 'https://app.ai-aggregator.ru';
  // Same shared secret as the transfer webhook (issue #29 contract). It rides in the query
  // string because `generateInvoice` only accepts a `callbackUrl` — the Startonus API has
  // NO header option (packages/shared/src/startonus.ts:49-50), so we cannot move it to a
  // header on the outbound side. The webhook therefore ACCEPTS the token in a header (for
  // an nginx-injected / future path) and falls back to the query param, and — because a
  // query token can leak into access logs — the grant additionally requires an ON-CHAIN
  // ownership re-check. The token alone does not authorize a grant (MEDIUM-1).
  const webhookToken = process.env.TRANSFER_WEBHOOK_SECRET;
  const callbackUrl = `${publicBase}/tg/api/tma/membership/webhook${webhookToken ? `?token=${encodeURIComponent(webhookToken)}` : ''}`;

  try {
    const invoice = await generateInvoice({
      templateId: Number(mintTemplateId),
      address: collectionAddress,
      secret,
      owner: { tgId: Number(tgUserId), wallet: recipientAddress },
      nftPrice: amountNanoTon,
      // LOW-2: no `nftData` — the card's name/description/image come from the Startonus
      // mint-set template (`templateId`), configured once in the minter panel. The previous
      // code pointed `image` at /tg/og/membership/<tier>.png, a route that does NOT exist:
      // that 404 would have been frozen into the NFT's on-chain metadata forever. Tier is
      // recorded in OUR DB (tg_memberships.tier), which is the source of truth anyway.
      userData: chargeId,
      callbackUrl,
    });

    await sql`
      UPDATE tg_membership_charges SET startonus_invoice_id = ${invoice.id}
      WHERE id = ${chargeId}::uuid
    `;

    return NextResponse.json({
      charge_id: chargeId,
      tier,
      amount_nano_ton: amountNanoTon.toString(),
      transaction: {
        validUntil: invoice.validUntil,
        messages: [
          {
            address: invoice.to,
            amount: invoice.value,
            payload: invoice.payload,
          },
        ],
      },
    });
  } catch (e) {
    console.error('membership invoice failed:', e);
    await sql`UPDATE tg_membership_charges SET status='failed' WHERE id = ${chargeId}::uuid`;
    return NextResponse.json({ error: 'minter_unavailable' }, { status: 502 });
  }
}
