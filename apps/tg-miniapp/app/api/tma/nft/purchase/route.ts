import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';
import { generateInvoice } from '@aiag/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

interface Body {
  collection_slug: string;
  recipient_address: string;
}

/**
 * Initiate NFT purchase:
 *   1. Validate active collection + supply not exhausted
 *   2. Insert nft_purchases row (status='pending')
 *   3. Call Startonus generate-invoice with our purchase_id as userData
 *   4. Return TON Connect transaction params
 *
 * Mint happens async — Startonus sends callback to /api/tma/nft/webhook
 * after the user's TON transaction confirms on-chain.
 */
export async function POST(req: NextRequest) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const { collection_slug, recipient_address } = body;
  if (!collection_slug || typeof collection_slug !== 'string') {
    return NextResponse.json({ error: 'collection_slug_required' }, { status: 400 });
  }
  if (!recipient_address || typeof recipient_address !== 'string') {
    return NextResponse.json({ error: 'recipient_address_required' }, { status: 400 });
  }

  // Load collection
  const rows = (await sql`
    SELECT id::text, slug, startonus_collection_id,
           price_nano_ton::text, minted_count, max_supply
    FROM nft_collections
    WHERE slug = ${collection_slug} AND status = 'active'
    LIMIT 1
  `) as unknown as Array<{
    id: string;
    slug: string;
    startonus_collection_id: string | null;
    price_nano_ton: string;
    minted_count: number;
    max_supply: number | null;
  }>;
  const col = rows[0];
  if (!col) {
    return NextResponse.json({ error: 'collection_not_found' }, { status: 404 });
  }
  if (col.max_supply != null && col.minted_count >= col.max_supply) {
    return NextResponse.json({ error: 'sold_out' }, { status: 409 });
  }
  if (!col.startonus_collection_id) {
    return NextResponse.json(
      { error: 'collection_not_configured', message: 'Startonus collection_id not set' },
      { status: 503 },
    );
  }

  const startonusSecret = process.env.STARTONUS_SECRET;
  if (!startonusSecret) {
    return NextResponse.json(
      { error: 'startonus_not_configured' },
      { status: 503 },
    );
  }

  // Insert pending purchase
  const ins = (await sql`
    INSERT INTO nft_purchases (
      collection_id, tg_user_id, recipient_address, price_nano_ton, status, created_at
    )
    VALUES (
      ${col.id}::uuid,
      ${tgUserId}::bigint,
      ${recipient_address},
      ${col.price_nano_ton}::bigint,
      'pending',
      NOW()
    )
    RETURNING id::text
  `) as unknown as Array<{ id: string }>;
  const purchaseId = ins[0]?.id;
  if (!purchaseId) {
    return NextResponse.json({ error: 'insert_failed' }, { status: 500 });
  }

  // Call Startonus
  const publicBase = process.env.PUBLIC_BASE_URL ?? 'https://app.ai-aggregator.ru';
  const callbackUrl = `${publicBase}/tg/api/tma/nft/webhook`;

  try {
    const invoice = await generateInvoice({
      secret: startonusSecret,
      collectionId: col.startonus_collection_id,
      priceNanoTon: col.price_nano_ton,
      recipient: recipient_address,
      userData: purchaseId,
      callbackUrl,
    });

    // Store Startonus invoice id for reconciliation
    await sql`
      UPDATE nft_purchases
      SET startonus_invoice_id = ${invoice.id}
      WHERE id = ${purchaseId}::uuid
    `;

    return NextResponse.json({
      purchase_id: purchaseId,
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
    // Mark purchase as failed so it doesn't pile up as pending
    const err = e instanceof Error ? e.message : 'startonus_error';
    await sql`
      UPDATE nft_purchases
      SET status = 'failed', error = ${err}
      WHERE id = ${purchaseId}::uuid
    `;
    console.error('Startonus generate-invoice failed:', e);
    return NextResponse.json({ error: 'minter_unavailable', detail: err }, { status: 502 });
  }
}
