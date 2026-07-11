import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';
import { generateInvoice, tonToNano } from '@aiag/shared';
import { checkRateLimit } from '@/lib/rate-limit';
import { MEMBERSHIP_TIERS, isMembershipTier } from '@/lib/membership';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

interface Body {
  tier: string;
  recipient_address: string;
}

/**
 * POST /api/tma/membership/purchase — membership-NFT purchase INITIATE (issue #29).
 *
 * Mirrors the transferable-agent transfer/route.ts pattern exactly (same minter, same
 * TON Connect flow): insert a `pending` tg_membership_charges row, ask Startonus to
 * lazily mint one membership-tier NFT item onto the CALLER's own wallet, and hand the
 * client a TON Connect transaction to sign. Payment is on-chain TON — no crypto-credit
 * debit (issue boundary). Ownership/grant happens ONLY on the webhook 'minted' confirm
 * (…/api/tma/membership/webhook), never here.
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
  const { tier, recipient_address } = body;
  if (!isMembershipTier(tier)) {
    return NextResponse.json({ error: 'invalid_tier' }, { status: 400 });
  }
  if (!recipient_address || typeof recipient_address !== 'string') {
    return NextResponse.json({ error: 'recipient_address_required' }, { status: 400 });
  }

  // A pending charge already in flight for this user → let it resolve first (mirrors
  // the transfer route's single-pending-charge rule; avoids double invoices/mints).
  const pend = (await sql`
    SELECT id::text FROM tg_membership_charges
    WHERE tg_user_id = ${tgUserId}::bigint AND status = 'pending' LIMIT 1
  `) as unknown as Array<{ id: string }>;
  if (pend.length > 0) {
    return NextResponse.json({ error: 'purchase_pending' }, { status: 409 });
  }

  const priceTon = MEMBERSHIP_TIERS[tier].priceTon;
  const amountNanoTon = tonToNano(priceTon);

  const ins = (await sql`
    INSERT INTO tg_membership_charges (tg_user_id, tier, amount_nano_ton, status, created_at)
    VALUES (${tgUserId}::bigint, ${tier}, ${amountNanoTon.toString()}::bigint, 'pending', NOW())
    RETURNING id::text
  `) as unknown as Array<{ id: string }>;
  const chargeId = ins[0]?.id;
  if (!chargeId) {
    return NextResponse.json({ error: 'insert_failed' }, { status: 500 });
  }

  const secret = process.env.STARTONUS_SECRET;
  const collectionAddress = process.env.STARTONUS_MEMBERSHIP_COLLECTION_ADDRESS;
  const mintTemplateId = process.env.STARTONUS_MEMBERSHIP_MINT_TEMPLATE_ID;
  if (!secret || !collectionAddress || !mintTemplateId) {
    await sql`UPDATE tg_membership_charges SET status='failed' WHERE id = ${chargeId}::uuid`;
    return NextResponse.json({ error: 'minter_not_configured' }, { status: 503 });
  }

  const publicBase = process.env.PUBLIC_BASE_URL ?? 'https://app.ai-aggregator.ru';
  // Same shared secret as the transfer webhook (issue #29 contract: "под тем же
  // shared-токеном, что transfer-вебхук").
  const webhookToken = process.env.TRANSFER_WEBHOOK_SECRET;
  const callbackUrl = `${publicBase}/tg/api/tma/membership/webhook${webhookToken ? `?token=${encodeURIComponent(webhookToken)}` : ''}`;
  const tierMeta = MEMBERSHIP_TIERS[tier];

  try {
    const invoice = await generateInvoice({
      templateId: Number(mintTemplateId),
      address: collectionAddress,
      secret,
      owner: { tgId: Number(tgUserId), wallet: recipient_address },
      nftPrice: amountNanoTon,
      nftData: {
        name: `AIAG Membership — ${tierMeta.label}`,
        description: `Членство уровня ${tierMeta.label}: создание агентов с нуля, лимит ${tierMeta.agentLimit} агент(ов).`,
        image: `${publicBase}/tg/og/membership/${tier}.png`,
        attributes: [{ type: 'tier', value: tier }],
      },
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
