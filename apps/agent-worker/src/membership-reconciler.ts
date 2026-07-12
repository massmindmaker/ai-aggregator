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
// 🔴 TIER SAFETY (issue #29, P0-1 — REWORKED round 6). The earlier revision matched items to
// charges by "lowest-tier-first" heuristic because ONE mint template served all three tiers,
// so a minted item carried no tier of its own. That is fixed at the source now: the purchase
// route (apps/tg-miniapp/app/api/tma/membership/purchase/route.ts) mints through a SEPARATE
// Startonus template PER TIER (env STARTONUS_MINT_TEMPLATE_ID_CREATOR/_BUILDER/_STUDIO), and
// each template bakes a `Tier` attribute into the item's own off-chain metadata. The tier is
// therefore read from the CHAIN (the item's `metadata.attributes`), never from
// `tg_membership_charges.tier` — that DB column is only the buyer's REQUESTED tier and is
// treated as untrusted input, exactly like the request body that seeded it.
//
// Matching an item to a specific charge still needs care (the chain has no notion of "this
// item belongs to charge X"), so three rules apply together:
//   (1) a verified wallet maps to exactly ONE tg account (partial UNIQUE in 0048); if the DB
//       still shows several owners for a wallet, we refuse to grant and shout;
//   (2) candidate charges are restricted to that single owner — an item can never satisfy a
//       charge belonging to a different account;
//   (3) FAIL-CLOSED on tier: for each candidate charge, we grant only against an item whose
//       OWN on-chain tier equals the charge's requested tier (`resolveGrantItem`). If the
//       webhook already hinted a specific item (`charge.item_address`) and THAT item's tier
//       attribute cannot be read, we do NOT fall back to the DB tier — the charge is flagged
//       `needs_review` with a loud log instead. "Take the tier from the charge like before"
//       is exactly the bug being closed here; it is never an acceptable fallback.
const TICK_MS = 30_000; // 30s — a user is waiting on the purchase screen (topups use 2 min)
const ITEMS_PAGE_LIMIT = 100;
const TONAPI_TIMEOUT_MS = 8_000; // never let a hung tonapi call wedge the tick
const FRESH_LIMIT = 200; // DB rows considered per fresh-pool query per tick
const STUCK_LIMIT = 25; // stuck pool — small, and only swept every Nth tick
const STUCK_EVERY_N_TICKS = 20; // ≈ every 10 min at a 30s tick

// HIGH-3 (issue #29 round 6): a `pending` charge is FREE to create (rate-limited, but no
// payment required) and costs one tonapi request per DISTINCT wallet, per tick, for up to
// 7 days (EXPIRE_DAYS) before it ages out. A sybil could open hundreds of these to burn the
// tick's tonapi budget and delay a PAYING user's grant. The fix: split the fresh pool into
// evidence-bearing charges (tx_hash/item_address already seen — a real payment signal) and
// bare charges (free, sybil-prone), and spend the tick's tonapi-request budget on the
// evidence pool FIRST, unconditionally, before a single request goes to a bare charge. Bare
// charges only get whatever budget is left over.
const REQUEST_BUDGET_NO_KEY = 20; // public tonapi ≈1 rps; margin under the 30s-tick ceiling
const REQUEST_BUDGET_WITH_KEY = 100; // keyed tonapi tolerates far more; still capped per tick

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
  /** The webhook's (unauthoritative) hint of which on-chain item this charge minted. */
  item_address: string | null;
}

/** tonapi.io NFT item (docs.tonconsole.com/tonapi/rest-api/nft). `metadata` carries the
 *  parsed off-chain TEP-64 content (name/description/image/attributes) — tonapi resolves it
 *  automatically on this endpoint, no extra query param needed. This is where the mint-time
 *  `Tier` attribute lives (P0-1 fix, issue #29 round 6). */
interface TonapiNftItem {
  address?: string;
  owner?: { address?: string };
  collection?: { address?: string };
  metadata?: { attributes?: Array<{ trait_type?: string; value?: unknown }> };
}

type Tier = 'creator' | 'builder' | 'studio';
const VALID_TIERS: readonly Tier[] = ['creator', 'builder', 'studio'];

/**
 * P0-1 FIX (issue #29 round 6): the tier is read from the ITEM'S OWN on-chain metadata,
 * never from `tg_membership_charges.tier` (a DB row seeded by the buyer's own request body
 * — untrustworthy as a grant input). Fail-CLOSED: any metadata shape we don't recognize
 * returns null, and null NEVER grants (see `resolveGrantItem`).
 */
function extractTierFromItem(item: TonapiNftItem): Tier | null {
  const attrs = item.metadata?.attributes;
  if (!Array.isArray(attrs)) return null;
  for (const a of attrs) {
    const key = String(a?.trait_type ?? '')
      .trim()
      .toLowerCase();
    if (key !== 'tier') continue;
    const v = String(a?.value ?? '')
      .trim()
      .toLowerCase();
    if ((VALID_TIERS as readonly string[]).includes(v)) return v as Tier;
  }
  return null;
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

/** Tier order — used ONLY to never downgrade an existing membership on grant (below). Tier
 *  MATCHING (which item satisfies which charge) no longer uses rank; see resolveGrantItem. */
const TIER_RANK: Record<string, number> = { creator: 1, builder: 2, studio: 3 };

/**
 * Resolve, for ONE candidate charge, which on-chain item (if any) satisfies it — or that it
 * must be flagged `needs_review` because the only evidence we have points at an item whose
 * tier we cannot read (P0-1 fail-closed, issue #29 round 6).
 *
 *   1. If the webhook already hinted a specific item (`c.item_address`) and that address is
 *      one of THIS owner's items with an UNREADABLE tier → 'needs_review'. This is the exact
 *      fail-closed case: we know precisely which item is this charge's, and we refuse to
 *      grant off `c.tier` (untrusted DB input) when the chain can't confirm it.
 *   2. If that hinted address instead resolves to a READABLE tier → grant against it (most
 *      precise match available).
 *   3. Otherwise (no hint yet, or the hinted item isn't currently visible) fall back to
 *      matching by the charge's requested tier against the owner's readable-tier items. Safe
 *      because at most one charge per user is ever 'pending' at a time (0048's partial
 *      UNIQUE); the rare multi-charge case (stuck pool) still only grants a tier-EXACT match.
 */
function resolveGrantItem(
  c: PendingCharge,
  byTier: Map<Tier, string[]>,
  unknownItems: string[],
): { addr: string; tier: Tier } | 'needs_review' | null {
  if (c.item_address) {
    if (unknownItems.includes(c.item_address)) return 'needs_review';
    for (const [tier, addrs] of byTier) {
      if (addrs.includes(c.item_address)) return { addr: c.item_address, tier };
    }
    // hinted item not in the current owned-items snapshot (indexing lag, or it was already
    // claimed by another charge) — fall through to a tier-based match below.
  }
  const tier = c.tier as Tier;
  const addrs = byTier.get(tier) ?? [];
  return addrs.length > 0 ? { addr: addrs[0]!, tier } : null;
}

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
 * `tier` is the CHAIN-derived tier (from `resolveGrantItem`/`extractTierFromItem`), never
 * `c.tier` — P0-1's whole point is that the grant must never trust the DB row for the tier
 * it hands out. The claim table (PK = onchain_key = the item's on-chain address) is the
 * exactly-once guard, exactly like tg_topup_tx_claims for top-ups (lesson of issue #4).
 * Claim + grant + settle happen in ONE transaction: if the claim insert returns 0 rows the
 * item was already used, so we grant nothing and settle nothing here.
 */
async function grantAgainstItem(c: PendingCharge, itemAddress: string, tier: Tier): Promise<boolean> {
  if (!itemAddress) return false;
  let granted = false;

  await sql.begin(async (sql) => {
    const claim = (await sql`
      INSERT INTO tg_membership_tx_claims (onchain_key, charge_id, tg_user_id, tier)
      VALUES (${itemAddress}, ${c.id}::uuid, ${c.tg_user_id}::bigint, ${tier})
      ON CONFLICT (onchain_key) DO NOTHING
      RETURNING onchain_key
    `) as unknown as Array<{ onchain_key: string }>;
    if (claim.length === 0) return; // item already used — not ours to grant

    // tg_memberships PK = tg_user_id (one row per user); a higher tier upgrades, never down.
    await sql`
      INSERT INTO tg_memberships (tg_user_id, tier, nft_address, source)
      VALUES (${c.tg_user_id}::bigint, ${tier}, ${itemAddress}, 'nft')
      ON CONFLICT (tg_user_id) DO UPDATE SET
        tier = CASE
          WHEN ${TIER_RANK[tier] ?? 0} >
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

    // SETTLE (terminal). `tier` is overwritten with the chain-confirmed value — the charge
    // row now records what was ACTUALLY granted, not merely what was requested. Also
    // recovers a 'needs_review'/'failed' row whose item finally showed up: the charge
    // settles and its failure_reason clears — the anomaly resolves itself.
    await sql`
      UPDATE tg_membership_charges
      SET status='settled', item_address = ${itemAddress}, tier = ${tier},
          failure_reason = NULL, settled_at = NOW()
      WHERE id = ${c.id}::uuid AND status <> 'settled'
    `;
    granted = true;
  });

  return granted;
}

/**
 * Reconcile ONE pool of charges against the chain.
 *
 * Shared by every pass so all get the identical safety rules. Groups by wallet → one tonapi
 * call per wallet, not per charge. `walletBudget` caps how many DISTINCT wallets this call
 * may spend a tonapi request on (HIGH-3) — the rest are left for the next tick. Returns how
 * many requests were actually spent, so the caller can deduct it from the tick's budget.
 */
async function reconcilePool(
  pool: PendingCharge[],
  collection: string,
  walletBudget: number,
): Promise<number> {
  const byRecipient = new Map<string, PendingCharge[]>();
  for (const c of pool) {
    const list = byRecipient.get(c.recipient_address) ?? [];
    list.push(c);
    byRecipient.set(c.recipient_address, list);
  }

  let requestsUsed = 0;
  for (const [recipient, charges] of byRecipient) {
    if (requestsUsed >= walletBudget) break; // HIGH-3: budget exhausted — retry next tick

    // P0-1 rule (1): the wallet must map to exactly one tg account.
    const owner = await soleVerifiedOwner(recipient);
    if (!owner) continue;

    // P0-1 rule (2): only that owner's charges may be satisfied by this wallet's items.
    const candidates = charges.filter((c) => c.tg_user_id === owner);
    if (candidates.length === 0) continue;

    requestsUsed++;
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

    // P0-1 rule (3): bucket every owned item by ITS OWN on-chain tier. An item whose tier
    // attribute is missing/unrecognized goes in `unknownItems` and can only ever push a
    // charge to `needs_review` — never a grant off the DB tier.
    const byTier = new Map<Tier, string[]>();
    const unknownItems: string[] = [];
    for (const item of items) {
      if (!item.address) continue;
      const t = extractTierFromItem(item);
      if (t) byTier.set(t, [...(byTier.get(t) ?? []), item.address]);
      else unknownItems.push(item.address);
    }
    if (byTier.size === 0 && unknownItems.length === 0) continue; // chain says: nothing minted (yet)

    for (const c of candidates) {
      const resolved = resolveGrantItem(c, byTier, unknownItems);

      if (resolved === 'needs_review') {
        try {
          const flagged = (await sql`
            UPDATE tg_membership_charges
            SET status = 'needs_review',
                failure_reason = 'tier_unreadable: the item this charge minted (per the webhook hint) has no recognizable Tier attribute on chain — refusing to grant off the DB tier (P0-1 fail-closed)'
            WHERE id = ${c.id}::uuid AND status = 'pending'
            RETURNING id
          `) as unknown as Array<{ id: string }>;
          if (flagged.length > 0) {
            console.error(
              `[membership-reconciler] NEEDS REVIEW (fail-closed) — charge=${c.id} user=${c.tg_user_id}: hinted item=${c.item_address} has no readable Tier attribute; NOT granting from DB tier.`,
            );
          }
        } catch (e) {
          console.error(
            `[membership-reconciler] fail-closed flag failed charge=${c.id}: ${(e as Error).message}`,
          );
        }
        continue;
      }

      if (!resolved) continue; // nothing to match yet — retry next tick

      const { addr, tier } = resolved;
      try {
        // HIGH-3: the reconciler writes the payment evidence ITSELF the moment it sees the
        // item on chain. Evidence no longer depends on the (unreliable) callback arriving.
        await sql`
          UPDATE tg_membership_charges
          SET item_address = COALESCE(item_address, ${addr})
          WHERE id = ${c.id}::uuid AND status = 'pending'
        `;
        const granted = await grantAgainstItem(c, addr, tier);
        if (granted) {
          console.log(
            `[membership-reconciler] granted charge=${c.id} user=${c.tg_user_id} tier=${tier} item=${addr}`,
          );
        }
      } catch (e) {
        console.error(
          `[membership-reconciler] grant failed charge=${c.id} item=${addr}: ${(e as Error).message}`,
        );
      }
    }
  }
  return requestsUsed;
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
    const requestBudget = process.env.TONAPI_KEY ? REQUEST_BUDGET_WITH_KEY : REQUEST_BUDGET_NO_KEY;
    let budgetLeft = requestBudget;

    // ── Pass 1a: EVIDENCE-bearing fresh pendings. Priority path — real payment already seen
    // (tx_hash/item_address), a user is on the screen waiting. HIGH-3: queried and spent
    // FIRST, unconditionally, before a single tonapi request goes to a free/evidence-free row.
    let evidenceFresh: PendingCharge[] = [];
    try {
      evidenceFresh = (await sql`
        SELECT id::text, tg_user_id::text AS tg_user_id, tier, recipient_address, item_address
        FROM tg_membership_charges
        WHERE status = 'pending' AND recipient_address IS NOT NULL
          AND (tx_hash IS NOT NULL OR item_address IS NOT NULL)
        ORDER BY created_at ASC
        LIMIT ${FRESH_LIMIT}
      `) as unknown as PendingCharge[];
    } catch (e) {
      console.error(`[membership-reconciler] evidence-pending query failed: ${(e as Error).message}`);
    }
    if (evidenceFresh.length > 0) {
      budgetLeft -= await reconcilePool(evidenceFresh, collection, budgetLeft);
    }

    // ── Pass 1b: BARE fresh pendings — free to create, the sybil surface (HIGH-3). Only
    // spends whatever tonapi-request budget Pass 1a left over, so a pile of free pending rows
    // can, at worst, delay OTHER free rows — never a charge that has already shown payment.
    if (budgetLeft > 0) {
      let bareFresh: PendingCharge[] = [];
      try {
        bareFresh = (await sql`
          SELECT id::text, tg_user_id::text AS tg_user_id, tier, recipient_address, item_address
          FROM tg_membership_charges
          WHERE status = 'pending' AND recipient_address IS NOT NULL
            AND tx_hash IS NULL AND item_address IS NULL
          ORDER BY created_at ASC
          LIMIT ${FRESH_LIMIT}
        `) as unknown as PendingCharge[];
      } catch (e) {
        console.error(`[membership-reconciler] bare-pending query failed: ${(e as Error).message}`);
      }
      if (bareFresh.length > 0) await reconcilePool(bareFresh, collection, budgetLeft);
    }

    // ── Pass 2: STUCK pool — paid-or-uncertain, chain never (yet) settled it. Rare + rate-
    // limited (every STUCK_EVERY_N_TICKS). MEDIUM-1 (round 6): NO evidence filter here
    // anymore — every 'needs_review'/'failed' row is swept, not just ones already carrying
    // tx_hash/item_address. A charge that an error callback flipped to 'failed' BEFORE any
    // evidence existed used to be invisible to every pool forever (the webhook route's
    // HIGH-4 guard only protects evidence-bearing rows); now it is still periodically
    // re-checked against the chain and can self-heal to 'settled' if the mint actually went
    // through despite the error report.
    if (tickCount % STUCK_EVERY_N_TICKS === 0) {
      try {
        const stuck = (await sql`
          SELECT id::text, tg_user_id::text AS tg_user_id, tier, recipient_address, item_address
          FROM tg_membership_charges
          WHERE status IN ('needs_review', 'failed')
            AND recipient_address IS NOT NULL
          ORDER BY created_at ASC
          LIMIT ${STUCK_LIMIT}
        `) as unknown as PendingCharge[];
        if (stuck.length > 0) await reconcilePool(stuck, collection, STUCK_LIMIT);

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
    //     prompt / closed Telegram), so expiring it SHOULD lose nothing — but only if the
    //     chain has actually been checked RECENTLY (decision B, round 6): requiring merely
    //     "chain_checked_at is set" (even from once, days ago, before e.g.
    //     MEMBERSHIP_NFT_COLLECTION_ADDRESS was unset or tonapi was down) does NOT prove a
    //     payment landing just before this sweep would have been seen. Only a check inside
    //     the last day — well under EXPIRE_DAYS — is trusted as a live negative answer.
    try {
      const expired = (await sql`
        UPDATE tg_membership_charges SET status = 'expired'
        WHERE status = 'pending'
          AND created_at < NOW() - make_interval(days => ${EXPIRE_DAYS})
          AND tx_hash IS NULL
          AND item_address IS NULL
          AND chain_checked_at IS NOT NULL
          AND chain_checked_at > NOW() - INTERVAL '1 day'
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
