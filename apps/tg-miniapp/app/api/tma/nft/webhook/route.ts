import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

interface StartonusCallback {
  /** Same as we sent — our purchase_id UUID */
  userData?: string;
  /** Startonus event: invoice_paid | minted | failed */
  event?: string;
  /** TON tx hash */
  txHash?: string;
  /** Minted NFT contract address */
  nftAddress?: string;
  /** Error message if event=failed */
  error?: string;
}

/**
 * Receive Startonus mint lifecycle callbacks.
 *
 * Startonus does NOT sign webhooks. Защита через:
 *   1. Unguessable purchase_id UUID в userData
 *   2. nginx IP-allowlist (deploy задача)
 *   3. Идемпотентность — pending → paid → minted only forward
 */
export async function POST(req: NextRequest) {
  let body: StartonusCallback;
  try {
    body = (await req.json()) as StartonusCallback;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const { userData: purchaseId, event, txHash, nftAddress, error } = body;

  if (!purchaseId || !event) {
    return NextResponse.json({ error: 'missing_required' }, { status: 400 });
  }

  // Validate purchase exists
  const rows = (await sql`
    SELECT id::text, status, collection_id::text
    FROM nft_purchases
    WHERE id = ${purchaseId}::uuid
    LIMIT 1
  `) as unknown as Array<{ id: string; status: string; collection_id: string }>;
  const purchase = rows[0];
  if (!purchase) {
    // Unknown purchase_id — likely spoofed webhook
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  if (event === 'invoice_paid' || event === 'paid') {
    if (purchase.status !== 'pending') {
      return NextResponse.json({ ok: true, skipped: 'already_advanced' });
    }
    await sql`
      UPDATE nft_purchases
      SET status = 'paid', tx_hash = ${txHash ?? null}, paid_at = NOW()
      WHERE id = ${purchaseId}::uuid AND status = 'pending'
    `;
    return NextResponse.json({ ok: true });
  }

  if (event === 'minted') {
    if (purchase.status === 'minted') {
      return NextResponse.json({ ok: true, skipped: 'already_minted' });
    }
    await sql.begin(async (tx) => {
      await tx`
        UPDATE nft_purchases
        SET status = 'minted',
            tx_hash = COALESCE(${txHash ?? null}, tx_hash),
            nft_address = ${nftAddress ?? null},
            minted_at = NOW(),
            paid_at = COALESCE(paid_at, NOW())
        WHERE id = ${purchaseId}::uuid AND status <> 'minted'
      `;
      await tx`
        UPDATE nft_collections
        SET minted_count = minted_count + 1,
            updated_at = NOW()
        WHERE id = ${purchase.collection_id}::uuid
      `;
    });
    return NextResponse.json({ ok: true });
  }

  if (event === 'failed' || event === 'error') {
    await sql`
      UPDATE nft_purchases
      SET status = 'failed',
          error = ${error ?? 'unknown'}
      WHERE id = ${purchaseId}::uuid AND status NOT IN ('minted', 'failed')
    `;
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true, ignored: event });
}
