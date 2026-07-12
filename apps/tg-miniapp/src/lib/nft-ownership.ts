// On-chain membership-NFT ownership check (TonCenter v3).
//
// 🔴 issue #29 round 6 (P0-2): as of this round, NOTHING in the app calls this module.
// The on-chain sync route (app/api/tma/membership/route.ts) used to call it to GRANT a
// membership on bare wallet ownership — that was the P0-2 hole (Startonus items are not
// soulbound; the same paid item, forwarded wallet-to-wallet, minted unlimited free
// memberships). The route no longer does that; the only grant path is
// apps/agent-worker/src/membership-reconciler.ts, keyed on a PAID charge + a chain-claimed
// item, not on bare ownership. This module is kept — read-only, harmless on its own — for
// a possible future "your wallet holds a membership item" INFO banner. It must NEVER be
// wired to a grant again; ownership ≠ payment.
//
// ONE env var names the membership collection: MEMBERSHIP_NFT_COLLECTION_ADDRESS. The
// purchase/mint path (app/api/tma/membership/purchase) MUST read the SAME var — minting
// into one collection while checking ownership against another means a user pays and the
// system never sees their membership (issue #29 review). Never introduce a second address
// var for this collection.
//
// Never throws. Returns a DISCRIMINATED outcome instead of a bare boolean: an unconfigured
// collection and an RPC failure are NOT the same thing as "this wallet owns nothing", and
// callers must be able to tell them apart (a silent `false` reads as a definitive "not a
// member" and hides a misconfiguration).
//
// Env style mirrors jetton.ts: TONCENTER_API_URL (default https://toncenter.com/api/v3)
// + optional X-API-Key from TONCENTER_API_KEY.

const TONCENTER_BASE = process.env.TONCENTER_API_URL ?? 'https://toncenter.com/api/v3';

export type OwnershipCheck =
  /** MEMBERSHIP_NFT_COLLECTION_ADDRESS is not set — the on-chain path is OFF. Not a verdict. */
  | { result: 'unconfigured' }
  /** No wallet to check (caller has no verified TON wallet). Not a verdict about the chain. */
  | { result: 'no_wallet' }
  /** RPC unreachable / non-2xx / timeout. Not a verdict — the chain was never answered. */
  | { result: 'error' }
  /** The chain answered: the wallet holds at least one item in the collection. */
  | { result: 'owned' }
  /** The chain answered: the wallet holds no item in the collection. */
  | { result: 'not_owned' };

/** The single source of truth for the membership collection address (see note above). */
export function membershipCollectionAddress(): string | null {
  const v = process.env.MEMBERSHIP_NFT_COLLECTION_ADDRESS?.trim();
  return v ? v : null;
}

/**
 * Does `walletAddress` own an NFT item in the membership collection?
 *
 * Only 'owned' authorizes a grant. Every other outcome is a REASON, not a denial the
 * caller may present as "you are not a member".
 */
export async function checkMembershipNft(walletAddress: string): Promise<OwnershipCheck> {
  const collection = membershipCollectionAddress();
  if (!collection) return { result: 'unconfigured' };
  if (!walletAddress?.trim()) return { result: 'no_wallet' };

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
    if (!res.ok) {
      console.error('[nft-ownership] TonCenter non-2xx:', res.status);
      return { result: 'error' };
    }
    const j = (await res.json()) as { nft_items?: unknown[]; items?: unknown[] };
    const items = Array.isArray(j.nft_items)
      ? j.nft_items
      : Array.isArray(j.items)
        ? j.items
        : [];
    return items.length > 0 ? { result: 'owned' } : { result: 'not_owned' };
  } catch (e) {
    console.error('[nft-ownership] TonCenter check failed:', e);
    return { result: 'error' };
  } finally {
    clearTimeout(timer);
  }
}
