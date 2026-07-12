import { sql } from './db.js';

// Server-side reconciler for membership-NFT purchases (issue #29).
//
// WHY THIS IS THE AUTHORITATIVE PATH — facts about the Startonus API (docs research
// 2026-07-12, bot.startonus.com/docs + OpenAPI):
//   - there is NO GET endpoint for a mint's status (the whole API is one POST
//     generate-invoice + fire-and-forget callbacks) → a reconciler over THEIR API is
//     impossible; we must read the chain itself;
//   - callbacks are NOT retried → one pm2 restart during a deploy loses the callback
//     forever and the user is left having paid with no membership;
//   - callbacks are NOT signed and cannot carry custom headers → a callback is a hint,
//     never proof.
// So the SOURCE OF TRUTH IS THE BLOCKCHAIN, read here via tonapi.io. This mirrors what we
// already do for TON top-ups (topup-reconciler.ts): the client/callback path is a nicety;
// this tick is what actually guarantees the user gets what they paid for.
//
// THE GRANT LIVES ONLY HERE. The TMA webhook does NOT grant — it only records the item
// address the callback claims (evidence) and handles the error branch. That means a forged
// callback cannot mint a membership no matter what it says: nothing is granted until an
// item is actually found ON CHAIN, in OUR collection, owned by the charge's ton-proof
// VERIFIED recipient wallet. It also means the grant SQL exists in exactly one place.

const TICK_MS = 30_000; // 30s — a user is waiting on the purchase screen (topups use 2 min)
const ITEMS_PAGE_LIMIT = 100;
// A pending charge that the chain never confirms is an abandoned/failed invoice. It must
// still reach a TERMINAL state so the user is never permanently blocked from re-buying
// (issue #29 DoD 6 — "ручной SQL как единственный выход не принимается").
const EXPIRE_DAYS = 7;

interface PendingCharge {
  id: string;
  tg_user_id: string;
  tier: string;
  recipient_address: string;
}

/** tonapi.io NFT item (docs.tonconsole.com/tonapi/rest-api/nft). */
interface TonapiNftItem {
  address?: string;
  owner?: { address?: string };
  collection?: { address?: string };
}

/**
 * Items in OUR membership collection currently owned by `owner`, straight from the chain.
 *
 * tonapi filters by collection server-side, so a returned item simultaneously proves all
 * three things the grant requires: the item exists, it belongs to our collection, and this
 * wallet owns it. Returns null (NOT []) on any transport/API failure so the caller can tell
 * "chain says none" apart from "we could not ask" — the latter must never expire a charge.
 */
async function fetchOwnedCollectionItems(
  owner: string,
  collection: string,
): Promise<TonapiNftItem[] | null> {
  const base = (process.env.TONAPI_BASE_URL ?? 'https://tonapi.io/v2').replace(/\/$/, '');
  const url = new URL(`${base}/accounts/${encodeURIComponent(owner)}/nfts`);
  url.searchParams.set('collection', collection);
  url.searchParams.set('limit', String(ITEMS_PAGE_LIMIT));
  // Exclude items the indexer flags as scam/non-verified copies of a collection.
  url.searchParams.set('indirect_ownership', 'false');

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (process.env.TONAPI_KEY) headers.Authorization = `Bearer ${process.env.TONAPI_KEY}`;

  try {
    const r = await fetch(url.toString(), { headers });
    if (!r.ok) {
      console.warn(`[membership-reconciler] tonapi ${r.status} — tick skipped for ${owner}`);
      return null;
    }
    const j = (await r.json()) as { nft_items?: TonapiNftItem[]; items?: TonapiNftItem[] };
    return j.nft_items ?? j.items ?? [];
  } catch (e) {
    console.warn(`[membership-reconciler] tonapi fetch failed: ${(e as Error).message}`);
    return null;
  }
}

/** Higher wins — a re-purchase may only UPGRADE a tier, never silently downgrade it. */
const TIER_RANK: Record<string, number> = { creator: 1, builder: 2, studio: 3 };

/**
 * Grant ONE membership against ONE on-chain item, exactly once.
 *
 * The claim table (PK = onchain_key = the item's on-chain address) is the exactly-once
 * guard, exactly like tg_topup_tx_claims for top-ups (lesson of issue #4). Claim + grant +
 * settle happen in ONE transaction: if the claim insert returns 0 rows the item was already
 * used to grant a membership, so we grant nothing and settle nothing here.
 *
 * Returns true only if THIS call performed the grant.
 */
async function grantAgainstItem(c: PendingCharge, itemAddress: string): Promise<boolean> {
  if (!itemAddress) return false;
  let granted = false;

  await sql.begin(async (sql) => {
    // a) CLAIM-GUARD: one on-chain item <-> at most one membership grant, ever. A replayed
    //    callback, a concurrent webhook, or a second reconciler tick all collide here.
    const claim = (await sql`
      INSERT INTO tg_membership_tx_claims (onchain_key, charge_id, tg_user_id, tier)
      VALUES (${itemAddress}, ${c.id}::uuid, ${c.tg_user_id}::bigint, ${c.tier})
      ON CONFLICT (onchain_key) DO NOTHING
      RETURNING onchain_key
    `) as unknown as Array<{ onchain_key: string }>;
    if (claim.length === 0) return; // item already used — not ours to grant

    // b) GRANT. tg_memberships PK = tg_user_id (one row per user); a higher tier upgrades.
    await sql`
      INSERT INTO tg_memberships (tg_user_id, tier, nft_address, source)
      VALUES (${c.tg_user_id}::bigint, ${c.tier}, ${itemAddress}, 'nft')
      ON CONFLICT (tg_user_id) DO UPDATE SET
        tier = CASE
          WHEN ${TIER_RANK[c.tier] ?? 0} >
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

    // c) SETTLE the charge (terminal). Guarded so a settled charge is never rewritten.
    await sql`
      UPDATE tg_membership_charges
      SET status='settled', item_address = ${itemAddress}, settled_at = NOW()
      WHERE id = ${c.id}::uuid AND status <> 'settled'
    `;
    granted = true;
  });

  return granted;
}

/** One reconcile tick. Exported so it is unit-testable, like runTopupReconcileTick. */
export async function runMembershipReconcileTick(): Promise<void> {
  const collection = process.env.MEMBERSHIP_NFT_COLLECTION_ADDRESS?.trim();
  if (!collection) return; // membership purchase not configured on this box

  let pending: PendingCharge[];
  try {
    pending = (await sql`
      SELECT id::text,
             tg_user_id::text AS tg_user_id,
             tier,
             recipient_address
      FROM tg_membership_charges
      WHERE status = 'pending' AND recipient_address IS NOT NULL
      ORDER BY created_at ASC
      LIMIT 200
    `) as unknown as PendingCharge[];
  } catch (e) {
    console.error(`[membership-reconciler] pending query failed: ${(e as Error).message}`);
    return;
  }

  // One tonapi call per distinct recipient wallet, not per charge.
  const byRecipient = new Map<string, PendingCharge[]>();
  for (const c of pending) {
    const list = byRecipient.get(c.recipient_address) ?? [];
    list.push(c);
    byRecipient.set(c.recipient_address, list);
  }

  for (const [recipient, charges] of byRecipient) {
    const items = await fetchOwnedCollectionItems(recipient, collection);
    if (items === null) continue; // could not ask the chain — retry next tick, expire nothing

    // Item addresses this wallet actually holds in our collection, per the chain.
    const addresses = items.map((i) => i.address).filter((a): a is string => !!a);
    if (addresses.length === 0) continue; // nothing minted (yet) — stays pending

    for (const c of charges) {
      // Try each held item until one is unclaimed. A wallet that already spent its item on
      // an earlier settled charge has no free item left → this charge stays pending, and a
      // forged/duplicate callback can never re-use an item that is already claimed.
      for (const addr of addresses) {
        try {
          const granted = await grantAgainstItem(c, addr);
          if (granted) {
            console.log(
              `[membership-reconciler] granted membership charge=${c.id} user=${c.tg_user_id} tier=${c.tier} item=${addr}`,
            );
            break;
          }
        } catch (e) {
          console.error(
            `[membership-reconciler] grant failed charge=${c.id} item=${addr}: ${(e as Error).message}`,
          );
        }
      }
    }
  }

  // No dead ends (DoD 6): a charge the chain never confirms must still become terminal, so
  // the one-pending-per-user UNIQUE stops blocking the user forever. Conservative window —
  // the sweep above runs every 30s, so a real mint is picked up within a minute of landing;
  // a week-old pending row is an abandoned invoice, not lost money.
  try {
    const expired = (await sql`
      UPDATE tg_membership_charges SET status = 'expired'
      WHERE status = 'pending' AND created_at < NOW() - make_interval(days => ${EXPIRE_DAYS})
      RETURNING id::text
    `) as unknown as Array<{ id: string }>;
    if (expired.length > 0) {
      console.log(`[membership-reconciler] expired ${expired.length} abandoned charge(s)`);
    }
  } catch (e) {
    console.error(`[membership-reconciler] expiry failed: ${(e as Error).message}`);
  }
}

/** Start the resident reconciler loop. Same shape as startTopupReconciler. */
export function startMembershipReconciler(): { stop: () => void } {
  const timer = setInterval(() => {
    void runMembershipReconcileTick();
  }, TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[membership-reconciler] reconcile-tick every ${TICK_MS / 1000}s`);
  return { stop: () => clearInterval(timer) };
}
