import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RETIRED — the legacy speculative NFT-collectible catalog ("Знаки") purchase path.
 *
 * Founder decision #4 (/CLAUDE.md): NFT-as-speculation is removed from the product.
 * The Startonus minter is repurposed for the ONE sanctioned, non-speculative use —
 * the opt-in transferable-agent iNFT (Phase 16 / R1.4), via
 * `app/api/tma/agents/[id]/transfer` + `app/api/tma/agents/transfer/webhook`.
 *
 * This route previously called `generateInvoice` with the stale Phase-15 contract
 * ({collectionId, priceNanoTon, recipient}). The 16-05 client rewrite moved to the
 * live API ({id, address, owner, nftPrice}); rather than guess a (template,address)
 * mapping for the retired catalog and risk a wrong mint, the purchase path is closed.
 * Full deletion of the legacy nft/* routes + UI is tracked as NFT-removal cleanup.
 */
export async function POST() {
  return NextResponse.json(
    { error: 'feature_retired', message: 'NFT-каталог больше не доступен.' },
    { status: 410 },
  );
}
