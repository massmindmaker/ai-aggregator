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
// already do for TON top-ups (topup-reconciler.ts).
//
// THE GRANT LIVES ONLY HERE. The TMA webhook does NOT grant — it only records a hint. So a
// forged callback cannot mint a membership: nothing is granted until an item is actually
// found ON CHAIN, in OUR collection, owned by the charge's ton-proof VERIFIED wallet.
//
// 🔴 TIER SAFETY (issue #29 P0-1). The chain does NOT tell us which charge an item belongs
// to: there is ONE mint template for all three tiers, so a minted item carries no tier and
// no charge id. We therefore cannot "look up" the tier — we can only make over-granting
// IMPOSSIBLE. Three rules do that together:
//   (1) a verified wallet maps to exactly ONE tg account (partial UNIQUE in 0048); if the DB
//       still shows several owners for a wallet, we refuse to grant and shout;
//   (2) candidate charges are restricted to that single owner — an item can never satisfy a
//       charge belonging to a different account;
//   (3) among that owner's candidate charges we grant the LOWEST tier (`byTierAsc`) — a
//       fail-safe that can only ever UNDER-deliver, never over-deliver.
// Opus's attack (account A opens `studio` and never pays; account B pays 2 TON for `creator`
// with the SAME wallet; A's studio charge swallows the item) dies at (1) and again at (2).
// PROPER LONG-TERM FIX: one mint template PER TIER, so the tier is readable from the item's
// on-chain metadata. That needs founder config in the Startonus panel + a live mint to verify
// the metadata shape — both out of bounds for this issue. Until then, rules (1)-(3) hold.

const TICK_MS = 30_000; // 30s — a user is waiting on the purchase screen (topups use 2 min)
const ITEMS_PAGE_LIMIT = 100;
const TONAPI_TIMEOUT_MS = 8_000; // never let a hung tonapi call wedge the tick
const FRESH_LIMIT = 200; // fresh pendings — the path a paying user is actually waiting on
const STUCK_LIMIT = 25; // stuck pool — small, and only swept every Nth tick
const STUCK_EVERY_N_TICKS = 20; // ≈ every 10 min at a 30s tick

// Ageing out stale 'pending' rows. A charge must always reach a terminal state so the user is
// never permanently blocked from re-buying (DoD 6), but WHICH terminal state depends on
// PAYMENT EVIDENCE:
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
 * tonapi filters by collection server-side, so a returned item simultaneously proves all three
 * things a grant requires: the item exists, it belongs to our collection, and this wallet owns
 * it.
 *
 * Returns null (NOT []) on any transport/API failure — the caller MUST distinguish "the chain
 * says this wallet holds nothing" from "we could not ask the chain". Only the former is a
 * negative answer; the latter must never age a charge out.
 */
async function fetchOwnedCollectionItems(
  owner: string,
  collection: string,
): Promise<TonapiNftItem[] | null> {
  const base = (process.env.TONAPI_BASE_URL ?? 'https://tonapi.io/v2').replace(/\/$/, '');
  const url = new URL(`${base}/accounts/${encodeURIComponent(owner)}/nfts`);
  url.searchParams.set('collection', collection);
  url.searchParams.set('limit', String(ITEMS_PAGE_LIMIT));
  url.searchParams.set('indirect_ownership', 'false');

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (process.env.TONAPI_KEY) headers.Authorization = `Bearer ${process.env.TONAPI_KEY}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TONAPI_TIMEOUT_MS);
  try {
    const r = await fetch(url.toString(), { headers, signal: ctrl.signal });
    if (!r.ok) {
      // 429 (no TONAPI_KEY = ~1 req/s public ceiling) lands here too — NOT a negative answer.
      console.warn(`[membership-reconciler] tonapi ${r.status} — cannot confirm ${owner}`);
      return null;
    }
    const j = (await r.json()) as { nft_items?: TonapiNftItem[]; items?: TonapiNftItem[] };
    return j.nft_items ?? j.items ?? [];
  } catch (e) {
    console.warn(`[membership-reconciler] tonapi fetch failed: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Tier order. Used to grant the LOWEST candidate tier (fail-safe) and to never downgrade. */
const TIER_RANK: Record<string, number> = { creator: 1, builder: 2, studio: 3 };
const byTierAsc = (a: PendingCharge, b: PendingCharge): number =>
  (TIER_RANK[a.tier] ?? 99) - (TIER_RANK[b.tier] ?? 99);

/**
 * The single tg account that has ton-proof VERIFIED this wallet.
 * Returns null if zero — or, critically, MORE THAN ONE (0048 forbids that going forward; a
 * legacy duplicate is an anomaly we refuse to grant on rather than guess).
 */
async function soleVerifiedOwner(address: string): Promise<string | null> {
  const rows = (await sql`
    SELECT DISTINCT tg_user_id::text AS tg_user_id
    FROM ton_wallets
    WHERE address = ${address} AND is_verified = true
    LIMIT 2
  `) as unknown as Array<{ tg_user_id: string }>;
  if (rows.length !== 1) {
    if (rows.length > 1) {
      console.error(
        `[membership-reconciler] AMBIGUOUS WALLET ${address} verified by multiple accounts — refusing to grant (P0-1 guard)`,
      );
    }
    return null;
  }
  return rows[0]!.tg_user_id;
}

/**
 * Grant ONE membership against ONE on-chain item, exactly once.
 *
 * The claim table (PK = onchain_key = the item's on-chain address) is the exactly-once guard,
 * exactly like tg_topup_tx_claims for top-ups (lesson of issue #4). Claim + grant + settle
 * happen in ONE transaction: if the claim insert returns 0 rows the item was already used, so
 * we grant nothing and settle nothing here.
 */
async function grantAgainstItem(c: PendingCharge, itemAddress: string): Promise<boolean> {
  if (!itemAddress) return false;
  let granted = false;

  await sql.begin(async (sql) => {
    const claim = (await sql`
      INSERT INTO tg_membership_tx_claims (onchain_key, charge_id, tg_user_id, tier)
      VALUES (${itemAddress}, ${c.id}::uuid, ${c.tg_user_id}::bigint, ${c.tier})
      ON CONFLICT (onchain_key) DO NOTHING
      RETURNING onchain_key
    `) as unknown as Array<{ onchain_key: string }>;
    if (claim.length === 0) return; // item already used — not ours to grant

    // tg_memberships PK = tg_user_id (one row per user); a higher tier upgrades, never down.
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

    // SETTLE (terminal). Also recovers a 'needs_review'/'failed' row whose item finally showed
    // up: the charge settles and its failure_reason clears — the anomaly resolves itself.
    await sql`
      UPDATE tg_membership_charges
      SET status='settled', item_address = ${itemAddress}, failure_reason = NULL, settled_at = NOW()
      WHERE id = ${c.id}::uuid AND status <> 'settled'
    `;
    granted = true;
  });

  return granted;
}

/**
 * Reconcile ONE pool of charges against the chain.
 *
 * Shared by the fresh-pending pass and the (rare) stuck pass so both get the identical safety
 * rules. Groups by wallet → one tonapi call per wallet, not per charge.
 */
async function reconcilePool(pool: PendingCharge[], collection: string): Promise<void> {
  const byRecipient = new Map<string, PendingCharge[]>();
  for (const c of pool) {
    const list = byRecipient.get(c.recipient_address) ?? [];
    list.push(c);
    byRecipient.set(c.recipient_address, list);
  }

  for (const [recipient, charges] of byRecipient) {
    // P0-1 rule (1): the wallet must map to exactly one tg account.
    const owner = await soleVerifiedOwner(recipient);
    if (!owner) continue;

    // P0-1 rule (2): only that owner's charges may be satisfied by this wallet's items.
    const candidates = charges.filter((c) => c.tg_user_id === owner);
    if (candidates.length === 0) continue;

    const items = await fetchOwnedCollectionItems(recipient, collection);
    if (items === null) continue; // could not ask the chain — retry next tick, age out nothing

    // HIGH-3: the chain ANSWERED (even if empty). Record that, so the purchase route's
    // 15-minute TTL may expire this charge — and ONLY then. Without a definitive negative,
    // a lost callback + a 429-ing tonapi would expire a PAID charge and bill the user twice.
    await sql`
      UPDATE tg_membership_charges
      SET chain_checked_at = NOW()
      WHERE id = ANY(${candidates.map((c) => c.id)}::uuid[])
    `;

    const addresses = items.map((i) => i.address).filter((a): a is string => !!a);
    if (addresses.length === 0) continue; // chain says: nothing minted (yet)

    // P0-1 rule (3): LOWEST tier first — we cannot tell which charge an item belongs to, so we
    // may only ever under-deliver. (An honest user has exactly one candidate, so this is a
    // no-op for them; it only bites in the anomalous multi-charge case.)
    for (const c of [...candidates].sort(byTierAsc)) {
      for (const addr of addresses) {
        try {
          // HIGH-3: the reconciler writes the payment evidence ITSELF the moment it sees the
          // item on chain. Evidence no longer depends on the (unreliable) callback arriving.
          await sql`
            UPDATE tg_membership_charges
            SET item_address = COALESCE(item_address, ${addr})
            WHERE id = ${c.id}::uuid AND status = 'pending'
          `;
          const granted = await grantAgainstItem(c, addr);
          if (granted) {
            console.log(
              `[membership-reconciler] granted charge=${c.id} user=${c.tg_user_id} tier=${c.tier} item=${addr}`,
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
}

let tickCount = 0;
let ticking = false; // MEDIUM: anti-overlap — a slow tick must not be re-entered by the next

/** One reconcile tick. Exported so it is unit-testable, like runTopupReconcileTick. */
export async function runMembershipReconcileTick(): Promise<void> {
  const collection = process.env.MEMBERSHIP_NFT_COLLECTION_ADDRESS?.trim();
  if (!collection) return; // not configured — startMembershipReconciler() already shouted

  if (ticking) {
    console.warn('[membership-reconciler] previous tick still running — skipping this one');
    return;
  }
  ticking = true;
  tickCount += 1;

  try {
    // ── Pass 1: FRESH pendings. Priority path — a user is on the screen waiting. ──────────
    // P0-2: this pool is queried ALONE. Previously `status IN ('pending','needs_review')` with
    // one LIMIT 200 meant a growing (and permanent) needs_review backlog would crowd out every
    // new purchase — we would take money and never grant. The pools are now separate queries
    // with separate limits, so needs_review can NEVER starve a fresh purchase.
    let fresh: PendingCharge[] = [];
    try {
      fresh = (await sql`
        SELECT id::text, tg_user_id::text AS tg_user_id, tier, recipient_address
        FROM tg_membership_charges
        WHERE status = 'pending' AND recipient_address IS NOT NULL
        ORDER BY created_at ASC
        LIMIT ${FRESH_LIMIT}
      `) as unknown as PendingCharge[];
    } catch (e) {
      console.error(`[membership-reconciler] pending query failed: ${(e as Error).message}`);
    }
    if (fresh.length > 0) await reconcilePool(fresh, collection);

    // ── Pass 2: STUCK pool — paid, but the chain never showed the item. Rare + rate-limited.
    // Includes 'failed' rows that carry payment evidence (HIGH-4): a forged/erroneous error
    // callback must not be able to bury a charge the user actually paid for.
    if (tickCount % STUCK_EVERY_N_TICKS === 0) {
      try {
        const stuck = (await sql`
          SELECT id::text, tg_user_id::text AS tg_user_id, tier, recipient_address
          FROM tg_membership_charges
          WHERE status IN ('needs_review', 'failed')
            AND recipient_address IS NOT NULL
            AND (tx_hash IS NOT NULL OR item_address IS NOT NULL)
          ORDER BY created_at ASC
          LIMIT ${STUCK_LIMIT}
        `) as unknown as PendingCharge[];
        if (stuck.length > 0) await reconcilePool(stuck, collection);

        // VISIBILITY: the stuck pool must never grow silently (it is money we owe).
        const cnt = (await sql`
          SELECT COUNT(*)::text AS n FROM tg_membership_charges
          WHERE status = 'needs_review'
        `) as unknown as Array<{ n: string }>;
        const n = Number(cnt[0]?.n ?? '0');
        if (n > 0) {
          console.error(
            `[membership-reconciler] ALERT: ${n} charge(s) in needs_review (paid, undelivered). Still retried; investigate.`,
          );
        }
      } catch (e) {
        console.error(`[membership-reconciler] stuck sweep failed: ${(e as Error).message}`);
      }
    }

    // ── Ageing out old 'pending' rows — the two cases are NOT the same ────────────────────
    //
    // (1) NO payment evidence → abandoned invoice. The user never paid (rejected the wallet
    //     prompt / closed Telegram), so expiring it loses nothing. `chain_checked_at` is NOT
    //     required here: after EXPIRE_DAYS the TON Connect invoice is long dead anyway.
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

    // (2) HAS evidence but the chain still hasn't shown the item → the money is REAL. This is
    //     an anomaly, not garbage. 'needs_review' is terminal for the one-live-purchase UNIQUE
    //     (the user is unblocked) but the stuck pass above KEEPS retrying it, so a late item is
    //     still honoured. Reason is persisted AND logged — never silent, never 'expired'.
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
        console.error(
          `[membership-reconciler] NEEDS REVIEW — paid charge=${s.id} user=${s.tg_user_id}: payment evidence but no on-chain item after ${STUCK_DAYS}d. Still retried; NOT expired.`,
        );
      }
    } catch (e) {
      console.error(`[membership-reconciler] needs-review sweep failed: ${(e as Error).message}`);
    }
  } finally {
    ticking = false;
  }
}

/** Start the resident reconciler loop. Same shape as startTopupReconciler. */
export function startMembershipReconciler(): { stop: () => void } {
  if (!process.env.MEMBERSHIP_NFT_COLLECTION_ADDRESS?.trim()) {
    // LOUD: silence here used to mean "memberships are sold but never granted".
    console.error(
      '[membership-reconciler] DISABLED — MEMBERSHIP_NFT_COLLECTION_ADDRESS is not set. ' +
        'Membership purchases will NOT be granted. Set it (and TONAPI_KEY) in the env.',
    );
  } else if (!process.env.TONAPI_KEY) {
    // Public tonapi is ~1 req/s → 429s. Each wallet costs one request per tick.
    console.warn(
      '[membership-reconciler] TONAPI_KEY not set — using public tonapi rate limits; ' +
        'expect 429s beyond ~25-30 pending wallets per tick. Set TONAPI_KEY on prod.',
    );
  }
  const timer = setInterval(() => {
    void runMembershipReconcileTick();
  }, TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[membership-reconciler] reconcile-tick every ${TICK_MS / 1000}s`);
  return { stop: () => clearInterval(timer) };
}
