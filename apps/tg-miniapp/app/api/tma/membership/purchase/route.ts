import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'node:crypto';
import postgres from 'postgres';
import { generateInvoice, tonToNano } from '@aiag/shared';
import { checkRateLimit } from '@/lib/rate-limit';
import { MEMBERSHIP_TIERS, isMembershipTier, currentMembershipTier } from '@/lib/membership';
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

/**
 * How fresh `chain_checked_at` must be, RELATIVE TO NOW, for the TTL sweep below to trust
 * "no evidence" as a definitive negative (issue #29 round 6, decision B). A single stamp
 * made once, right after the charge was created, does NOT prove the chain has been checked
 * recently enough to have caught a payment that landed just before this sweep runs — the
 * reconciler could have died minutes ago. Requiring RECENCY (not just "after created_at")
 * means the sweep can only fire while the reconciler is demonstrably alive and has looked
 * at this exact wallet inside the last few ticks.
 */
const CHAIN_CHECK_FRESHNESS_MIN = 5;

/** Per-tier Startonus mint-set template env var (issue #29 round 6, P0-1). ONE template per
 * tier — not one shared template for all three — so the tier is bakeable into the item's
 * own on-chain metadata (a `Tier` attribute) and readable by the reconciler from the CHAIN,
 * never from this request body / the `tg_membership_charges.tier` column it seeds. */
const MINT_TEMPLATE_ENV: Record<string, string> = {
  creator: 'STARTONUS_MINT_TEMPLATE_ID_CREATOR',
  builder: 'STARTONUS_MINT_TEMPLATE_ID_BUILDER',
  studio: 'STARTONUS_MINT_TEMPLATE_ID_STUDIO',
};

interface Body {
  tier: string;
}

interface PendingRow {
  id: string;
  tier: string;
  amount_nano_ton: string;
  invoice_to: string | null;
  invoice_amount: string | null;
  invoice_payload: string | null;
  invoice_valid_until: string | null;
}

function invoiceResponse(c: PendingRow) {
  return NextResponse.json({
    charge_id: c.id,
    tier: c.tier,
    amount_nano_ton: c.amount_nano_ton,
    transaction: {
      validUntil: Number(c.invoice_valid_until),
      messages: [
        {
          address: c.invoice_to,
          amount: c.invoice_amount,
          payload: c.invoice_payload,
        },
      ],
    },
    idempotent: true,
  });
}

/**
 * POST /api/tma/membership/purchase — membership-NFT purchase INITIATE (issue #29).
 *
 * Insert a `pending` tg_membership_charges row, ask Startonus to lazily mint one
 * membership-tier NFT item onto the caller's VERIFIED wallet, and hand the client a TON
 * Connect transaction to sign. Payment is on-chain TON — no crypto-credit debit.
 *
 * The membership is NOT granted here. It is granted when the CHAIN confirms the mint —
 * by the reconciler (apps/agent-worker/src/membership-reconciler.ts, the ONLY authoritative
 * path). The Startonus callback is never trusted on its own: it is unsigned, unretried, and
 * has no status endpoint to ask.
 *
 * 🔴 HIGH-A: the mint recipient is read from `ton_wallets` (ton-proof VERIFIED wallets
 * only) — NEVER from the request body.
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

  // HIGH-A: recipient = the caller's latest ton-proof-VERIFIED wallet. No verified wallet →
  // no purchase (the user must connect + prove their wallet first).
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

  // MEDIUM (issue #29 round 6): buying a tier ≤ what the caller already holds takes real
  // TON and grants nothing new. Reject on the way in, with an explicit reason.
  const heldTier = await currentMembershipTier(tgUserId, sql);
  if (heldTier && MEMBERSHIP_TIERS[tier].rank <= MEMBERSHIP_TIERS[heldTier].rank) {
    return NextResponse.json(
      { error: 'tier_not_higher', current_tier: heldTier },
      { status: 400 },
    );
  }

  // HIGH-1 (issue #29 review): sweep abandoned pendings so a rejected wallet prompt doesn't
  // permanently 409 every future purchase.
  //
  // 🔴 HIGH-3 / decision B (round 6): "no evidence" is NOT enough to expire — evidence is
  // written by the callback/reconciler, and both are declared unreliable. We additionally
  // require chain_checked_at to be RECENT (not merely "after created_at" — a single stamp
  // from minutes ago, before the reconciler stalled, used to satisfy that). Only a chain
  // check made in roughly the last reconciler tick may retire a charge as unpaid; anything
  // older means we cannot vouch that a just-landed payment would already be visible, so we
  // do NOT expire — better a charge sits pending a little longer than a paid user gets
  // billed twice.
  await sql`
    UPDATE tg_membership_charges
    SET status = 'expired'
    WHERE tg_user_id = ${tgUserId}::bigint
      AND status = 'pending'
      AND created_at < NOW() - ${`${PENDING_TTL_MIN} minutes`}::interval
      AND tx_hash IS NULL
      AND item_address IS NULL
      AND chain_checked_at IS NOT NULL
      AND chain_checked_at > NOW() - ${`${CHAIN_CHECK_FRESHNESS_MIN} minutes`}::interval
  `;

  // Decision B (issue #29 round 6): AT MOST ONE active charge per user, and a repeat "buy"
  // returns the SAME invoice — never a second one. Minting a second Startonus invoice for a
  // charge that already has a live, signable TON Connect transaction risks a genuine double
  // payment for a single grant (the user could sign both). So: if a pending charge already
  // exists, hand back its STORED invoice instead of creating anything.
  const existing = (await sql`
    SELECT id::text, tier, amount_nano_ton::text AS amount_nano_ton,
           invoice_to, invoice_amount, invoice_payload, invoice_valid_until::text AS invoice_valid_until
    FROM tg_membership_charges
    WHERE tg_user_id = ${tgUserId}::bigint AND status = 'pending'
    LIMIT 1
  `) as unknown as Array<PendingRow>;
  if (existing[0]) {
    const c = existing[0];
    if (c.invoice_to && c.invoice_amount && c.invoice_payload && c.invoice_valid_until) {
      return invoiceResponse(c);
    }
    // Pending but the invoice was never persisted (e.g. crashed between INSERT and the
    // invoice UPDATE below) — nothing safe to replay yet. Ask the client to retry shortly;
    // do NOT mint a second invoice for the same charge.
    return NextResponse.json({ error: 'purchase_pending' }, { status: 409 });
  }

  const priceTon = MEMBERSHIP_TIERS[tier].priceTon;
  const amountNanoTon = tonToNano(priceTon);

  // MEDIUM-2 (TOCTOU): no SELECT-then-INSERT race beyond the read above — the partial
  // UNIQUE uq_membership_charges_one_pending (tg_user_id) WHERE status='pending' (0048) is
  // the invariant; a concurrent second call collides on 23505, handled below by re-reading
  // and replaying the winner's invoice (same contract as the `existing` branch above).
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
      const winner = (await sql`
        SELECT id::text, tier, amount_nano_ton::text AS amount_nano_ton,
               invoice_to, invoice_amount, invoice_payload, invoice_valid_until::text AS invoice_valid_until
        FROM tg_membership_charges
        WHERE tg_user_id = ${tgUserId}::bigint AND status = 'pending'
        LIMIT 1
      `) as unknown as Array<PendingRow>;
      if (winner[0]?.invoice_to) return invoiceResponse(winner[0]);
      return NextResponse.json({ error: 'purchase_pending' }, { status: 409 });
    }
    throw e;
  }

  // P0-1 (issue #29 round 6): ONE mint-set template PER TIER — the collection address is
  // still shared (the ownership/reconciler check is keyed on the collection, unchanged),
  // but the template picks the metadata (incl. a `Tier` attribute) baked into the minted
  // item, which is how the reconciler reads the tier from the CHAIN instead of trusting
  // this row. Without the tier's own template id, we refuse to mint at all — fail-closed,
  // never fall back to a shared/default template.
  const secret = process.env.STARTONUS_SECRET;
  const collectionAddress = membershipCollectionAddress();
  const mintTemplateId = process.env[MINT_TEMPLATE_ENV[tier]!];
  // MEDIUM (issue #29 round 6): a dedicated webhook secret for membership, separate from
  // Phase-16's TRANSFER_WEBHOOK_SECRET, so a leak on one surface does not compromise both.
  const webhookSecret = process.env.MEMBERSHIP_WEBHOOK_SECRET;
  if (!secret || !collectionAddress || !mintTemplateId || !webhookSecret) {
    console.error(
      `[membership/purchase] not configured for tier=${tier}: ` +
        `secret=${!!secret} collection=${!!collectionAddress} ` +
        `template(${MINT_TEMPLATE_ENV[tier]})=${!!mintTemplateId} webhookSecret=${!!webhookSecret}`,
    );
    await sql`UPDATE tg_membership_charges SET status='failed' WHERE id = ${chargeId}::uuid`;
    return NextResponse.json({ error: 'minter_not_configured' }, { status: 503 });
  }

  const publicBase = process.env.PUBLIC_BASE_URL ?? 'https://app.ai-aggregator.ru';
  // Startonus cannot send custom headers on its callback (only a plain callbackUrl —
  // packages/shared/src/startonus.ts:49-50 / their OpenAPI has no header option), so SOME
  // token must ride in the query string, where it can leak into access logs. We reduce the
  // blast radius two ways: (1) a secret dedicated to this route (above), and (2) the token
  // itself is NOT the raw secret — it's HMAC-SHA256(MEMBERSHIP_WEBHOOK_SECRET, chargeId), so
  // a leaked token authenticates callbacks for THIS ONE charge only. Even a fully leaked
  // token cannot be replayed against any other charge, and cannot be used to derive the
  // master secret. The webhook route still accepts a header first (for a future/nginx-
  // injected path) and additionally never grants on the callback alone (see webhook route).
  const chargeToken = createHmac('sha256', webhookSecret).update(chargeId).digest('hex');
  const callbackUrl = `${publicBase}/tg/api/tma/membership/webhook?token=${encodeURIComponent(chargeToken)}`;

  try {
    const invoice = await generateInvoice({
      templateId: Number(mintTemplateId),
      address: collectionAddress,
      secret,
      owner: { tgId: Number(tgUserId), wallet: recipientAddress },
      nftPrice: amountNanoTon,
      // LOW-2: no `nftData` — the card's name/description/image/attributes (incl. `Tier`)
      // come from the per-tier Startonus mint-set template, configured once per tier in the
      // minter panel.
      userData: chargeId,
      callbackUrl,
    });

    // Decision B: PERSIST the invoice so a repeat "buy" call can replay it instead of
    // minting a second one.
    await sql`
      UPDATE tg_membership_charges
      SET startonus_invoice_id = ${invoice.id},
          invoice_to = ${invoice.to},
          invoice_amount = ${invoice.value},
          invoice_payload = ${invoice.payload},
          invoice_valid_until = ${invoice.validUntil}
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
