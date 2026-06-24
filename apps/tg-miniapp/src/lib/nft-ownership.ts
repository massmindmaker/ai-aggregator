// On-chain membership-NFT ownership check (TonCenter v3).
//
// Used by the membership sync route to verify that a user's verified TON wallet owns an
// NFT item in the membership collection. Disabled (returns false) until
// MEMBERSHIP_NFT_COLLECTION_ADDRESS is configured — so the gate degrades to the founder
// seed + manual grants while no collection exists. Never throws: any error / timeout →
// false (fail-closed for the gate).
//
// Env style mirrors jetton.ts: TONCENTER_API_URL (default https://toncenter.com/api/v3)
// + optional X-API-Key from TONCENTER_API_KEY.

const TONCENTER_BASE = process.env.TONCENTER_API_URL ?? 'https://toncenter.com/api/v3';

/**
 * True if `walletAddress` owns at least one NFT item in the membership collection.
 * Returns false (does NOT throw) when the collection is unconfigured or on any RPC error.
 */
export async function ownsMembershipNft(walletAddress: string): Promise<boolean> {
  const collection = process.env.MEMBERSHIP_NFT_COLLECTION_ADDRESS?.trim();
  if (!collection) return false; // on-chain path disabled until the collection exists
  if (!walletAddress?.trim()) return false;

  const base = TONCENTER_BASE.replace(/\/$/, '');
  const url =
    `${base}/nft/items` +
    `?collection_address=${encodeURIComponent(collection)}` +
    `&owner_address=${encodeURIComponent(walletAddress.trim())}` +
    `&limit=1`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const apiKey = process.env.TONCENTER_API_KEY;
    if (apiKey) headers['X-API-Key'] = apiKey;

    const res = await fetch(url, { method: 'GET', headers, cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) return false;
    const j = (await res.json()) as { nft_items?: unknown[]; items?: unknown[] };
    const items = Array.isArray(j.nft_items)
      ? j.nft_items
      : Array.isArray(j.items)
        ? j.items
        : [];
    return items.length > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
