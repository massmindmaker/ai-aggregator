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
// Ageing out stale 'pending' rows. A charge must always reach a terminal state so the user
// is never permanently blocked from re-buying (issue #29 DoD 6 — "ручной SQL как единственный
// выход не принимается"), but WHICH terminal state depends on payment evidence:
//   - no evidence  → 'expired'      (abandoned invoice; nothing was paid, nothing is lost)
//   - has evidence → 'needs_review' (we took real money and haven't delivered — never 'expired')
const EXPIRE_DAYS = 7;
const STUCK_DAYS = 7;

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
    //    This also recovers a 'needs_review' row: if the item finally shows up on chain days
    //    later, the charge settles and its failure_reason is cleared — the anomaly resolves
    //    itself and the user gets what they paid for.
    await sql`
      UPDATE tg_membership_charges
      SET status='settled', item_address = ${itemAddress}, failure_reason = NULL, settled_at = NOW()
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
    // 'needs_review' rows are swept TOO, not just 'pending'. A needs_review charge is one we
    // KNOW was paid but the chain has not shown the item for days. It is terminal only for
    // the "one live purchase" UNIQUE (so the user isn't blocked); we must keep asking the
    // chain about it, because if the indexer was simply down/behind, the membership is still
    // owed and gets granted the moment tonapi recovers. Money is never written off silently.
    pending = (await sql`
      SELECT id::text,
             tg_user_id::text AS tg_user_id,
             tier,
             recipient_address
      FROM tg_membership_charges
      WHERE status IN ('pending', 'needs_review') AND recipient_address IS NOT NULL
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

  // ── Ageing out old 'pending' rows — the two cases are NOT the same ──────────────────
  //
  // No dead ends (DoD 6): a stale charge must become terminal so the one-live-purchase
  // UNIQUE stops blocking the user forever. But "terminal" must never mean "silently
  // discard a payment". The ONLY thing that separates rubbish from real money here is
  // PAYMENT EVIDENCE (tx_hash / item_address, written by the webhook the moment a mint
  // callback arrives) — the exact same guard the purchase route's 15-minute TTL uses.
  // An earlier revision of this sweep had NO such guard: a wallet that tonapi kept failing
  // on (429/5xx for days) would have its PAID charge silently flipped to 'expired', the
  // screen would re-open, and the user would pay a second time. That is the bug this split
  // closes.

  // (1) NO evidence → abandoned invoice, genuinely rubbish. The user never paid (they
  //     rejected the wallet prompt / closed Telegram), so nothing is lost by expiring it.
  try {
    const expired = (await sql`
      UPDATE tg_membership_charges SET status = 'expired'
      WHERE status = 'pending'
        AND created_at < NOW() - make_interval(days => ${EXPIRE_DAYS})
        AND tx_hash IS NULL
        AND item_address IS NULL
      RETURNING id::text
    `) as unknown as Array<{ id: string }>;
    if (expired.length > 0) {
      console.log(`[membership-reconciler] expired ${expired.length} abandoned (unpaid) charge(s)`);
    }
  } catch (e) {
    console.error(`[membership-reconciler] expiry failed: ${(e as Error).message}`);
  }

  // (2) HAS evidence but the chain still hasn't shown the item → the user's money is REAL.
  //     This is an anomaly (mint never landed, or the indexer is badly behind), not garbage.
  //     It becomes 'needs_review': terminal for the UNIQUE (user is unblocked and may buy
  //     again) but STILL swept by this reconciler every tick, so a late-arriving item is
  //     still honoured. The reason is persisted in failure_reason and logged loudly, so it
  //     shows up in the DB and in the logs instead of dissolving into 'expired'.
  //     `settled_at IS NULL` is implied by status='pending'; we never touch settled rows.
  try {
    const stuck = (await sql`
      UPDATE tg_membership_charges
      SET status = 'needs_review',
          failure_reason = ${`paid_but_unconfirmed: on-chain item not found within ${STUCK_DAYS}d — needs manual review (funds are real)`}
      WHERE status = 'pending'
        AND created_at < NOW() - make_interval(days => ${STUCK_DAYS})
        AND (tx_hash IS NOT NULL OR item_address IS NOT NULL)
      RETURNING id::text, tg_user_id::text AS tg_user_id
    `) as unknown as Array<{ id: string; tg_user_id: string }>;
    for (const s of stuck) {
      // Loud: this is money we took and have not delivered on. Must be visible, never silent.
      console.error(
        `[membership-reconciler] NEEDS REVIEW — paid charge=${s.id} user=${s.tg_user_id} has payment evidence but no on-chain item after ${STUCK_DAYS}d. Still retried every tick; NOT expired.`,
      );
    }
  } catch (e) {
    console.error(`[membership-reconciler] needs-review sweep failed: ${(e as Error).message}`);
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
