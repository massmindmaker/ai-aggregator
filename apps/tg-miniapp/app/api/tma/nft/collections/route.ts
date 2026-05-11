import { NextResponse } from 'next/server';
import postgres from 'postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

/**
 * Public list of NFT collections available to mint in TMA.
 * Only `status='active'` collections returned, sold-out filtered out.
 */
export async function GET() {
  try {
    const rows = (await sql`
      SELECT
        id::text,
        slug,
        name,
        description,
        image_url,
        price_nano_ton::text,
        minted_count,
        max_supply,
        startonus_collection_id
      FROM nft_collections
      WHERE status = 'active'
        AND (max_supply IS NULL OR minted_count < max_supply)
      ORDER BY created_at DESC
    `) as unknown as Array<{
      id: string;
      slug: string;
      name: string;
      description: string | null;
      image_url: string | null;
      price_nano_ton: string;
      minted_count: number;
      max_supply: number | null;
      startonus_collection_id: string | null;
    }>;
    return NextResponse.json({ collections: rows });
  } catch (e) {
    console.error('nft/collections error:', e);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
