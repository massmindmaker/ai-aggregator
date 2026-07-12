// Creator membership gate (founder decision 2026-06-24).
//
// A membership = a row in `tg_memberships`. Holders may CREATE agents from scratch;
// non-holders are blocked at the create endpoints (but HIRE and create-from-template
// stay open). The flag
// is backed by NFT ownership when a collection is configured (see nft-ownership.ts) and
// synced into this table via POST /api/tma/membership. Founder is seeded by migration
// 0044 so the gate never fully locks creation out.
//
// These helpers accept the caller's existing `postgres` client so a route does NOT open
// a second connection pool (each route already makes its own `sql`).
import type { Sql } from 'postgres';

/**
 * Membership tiers (founder decision 2026-07-11, issue #29). Numbers are fixed
 * business constants, not a model/service price — no env override, mirrors how
 * `docs/superpowers/specs/2026-06-26-research-nft-membership.md:266-270` sets them.
 * `agentLimit`/`revSharePct` are recorded for future gates; THIS issue only wires the
 * purchase + the binary creator gate above (any tier passes it), per issue boundary.
 * `rank` orders the tiers (used to forbid buying a tier ≤ the caller's current one —
 * issue #29 round 6 MEDIUM: that purchase would take real TON and grant nothing new).
 */
export const MEMBERSHIP_TIERS = {
  creator: { label: 'Creator', priceTon: '2', agentLimit: 1, revSharePct: 0, rank: 1 },
  builder: { label: 'Builder', priceTon: '10', agentLimit: 5, revSharePct: 15, rank: 2 },
  studio: { label: 'Studio', priceTon: '30', agentLimit: 20, revSharePct: 30, rank: 3 },
} as const;

export type MembershipTier = keyof typeof MEMBERSHIP_TIERS;

export function isMembershipTier(v: unknown): v is MembershipTier {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(MEMBERSHIP_TIERS, v);
}

/**
 * True if `tgUserId` has a creator membership. Fail-CLOSED: any error returns false
 * (deny creation) — safer than fail-open for an access gate.
 *
 * 🔴 CONTRACT (issue #29 HIGH-D, migration 0052): a row with `tier IS NULL` counts ONLY
 * when `source = 'founder'` (0044's seed — the one deliberate infinite-access row). Any
 * other NULL-tier row is a legacy free grant from the removed pre-round-6 sync route
 * (bare NFT ownership, no payment) and must NOT pass this gate — that was exactly the bug
 * (a free membership beating a paid `studio`). `revoked_at IS NOT NULL` (the backfill flag
 * 0052 sets on those legacy rows) is excluded outright, belt-and-suspenders on top of the
 * source/tier check.
 */
export async function hasCreatorMembership(
  tgUserId: string | number,
  sql: Sql,
): Promise<boolean> {
  try {
    const rows = (await sql`
      SELECT 1 FROM tg_memberships
      WHERE tg_user_id = ${tgUserId}::bigint
        AND revoked_at IS NULL
        AND (source = 'founder' OR tier IS NOT NULL)
      LIMIT 1
    `) as unknown as Array<unknown>;
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * The caller's current PAID tier, or null (no membership / founder-seed row with no
 * tier / revoked legacy row). Used by the purchase route to reject "buy a tier ≤ what I
 * already have" (issue #29 round 6 MEDIUM) — never used to GRANT anything. Excludes
 * `revoked_at IS NOT NULL` rows (issue #29 HIGH-D, migration 0052) so a neutralized legacy
 * grant can never be read as "already holds a tier" either.
 */
export async function currentMembershipTier(
  tgUserId: string | number,
  sql: Sql,
): Promise<MembershipTier | null> {
  try {
    const rows = (await sql`
      SELECT tier FROM tg_memberships
      WHERE tg_user_id = ${tgUserId}::bigint AND revoked_at IS NULL
      LIMIT 1
    `) as unknown as Array<{ tier: string | null }>;
    const t = rows[0]?.tier;
    return t && isMembershipTier(t) ? t : null;
  } catch {
    return null;
  }
}

// 🔴 There is deliberately NO `grantMembership` export here anymore (issue #29 round 6,
// P0-2). It used to be called from the on-chain sync route (POST /api/tma/membership) the
// moment a wallet was seen to HOLD a collection item — no payment check, no idempotency
// key, no tier. Startonus items are not soulbound (no SBT support — researched 2026-07-12),
// so the SAME paid item could be moved wallet-to-wallet and re-synced by a new account
// every time, minting unlimited free memberships from one paid mint; the grant also wrote
// tier=NULL, which the creation gate reads as UNLIMITED (issue #32) — free beat `studio`.
// The ONLY path that may write `tg_memberships` now is
// apps/agent-worker/src/membership-reconciler.ts, gated on a PAID `tg_membership_charges`
// row AND a chain-confirmed item claimed exactly-once via `tg_membership_tx_claims`. Do
// not re-add a grant helper here without going through that reconciler.
