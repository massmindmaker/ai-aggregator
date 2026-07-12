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
import type { Sql, TransactionSql } from 'postgres';

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
// tier=NULL, which the creation gate used to read as UNLIMITED (issue #32) — free beat
// `studio`. That NULL-tier hole is closed below (`capFromTierRows`) by requiring
// `source = 'founder'` for a NULL tier to mean unlimited, mirroring `hasCreatorMembership`.
// The ONLY path that may write `tg_memberships` now is
// apps/agent-worker/src/membership-reconciler.ts, gated on a PAID `tg_membership_charges`
// row AND a chain-confirmed item claimed exactly-once via `tg_membership_tx_claims`. Do
// not re-add a grant helper here without going through that reconciler.

// ---- Agent quotas by membership tier (issue #32, hardened for #29's contract) -----
//
// Tiers are sold as "1 agent / 5 agents / 20 agents" on /membership but until now
// `tg_memberships.tier` was never read — every holder got the same unlimited creation
// right. This section makes the tier actually cap the number of agents a user OWNS.
//
// THE CAP IS ON OWNED AGENTS, NOT ON ONE ROUTE. As of issue #34 (clone UI removed,
// `agents/[id]/clone` deleted), exactly THREE routes INSERT INTO agents: from-scratch
// create (`POST /api/tma/agents`), create-from-template (`POST
// /api/tma/templates/[id]/create`, formerly `.../clone`), and a first-time rent
// (`POST /api/tma/templates/[id]/rent`, renewals excluded — they clone nothing). Every
// one of them goes through `assertAgentQuota` in the SAME transaction as its INSERT, or
// the tier means nothing again (buy the 2-TON creator tier, create your 1 agent, then
// get 19 more for free through a path that forgot to check).
//
// CAP RESOLUTION — same fail-closed contract as `hasCreatorMembership` /
// `currentMembershipTier` above (issue #29 HIGH-D, migration 0052), not a separate rule:
//   - NO membership row at all → UNLIMITED. A non-member cannot reach POST /agents
//     (`hasCreatorMembership` already 403s them there), but clone/rent are deliberately
//     OPEN to non-members (that is how you try the product) and were unlimited there
//     before this change; capping them here would invent a tier nobody sells and strand
//     every existing non-member who already cloned >1 agent, so behavior is unchanged.
//     ⚠️ This leaves a PRE-EXISTING product hole this issue does not cover: a user who
//     buys nothing can still clone without limit — a strictly better deal than the
//     2-TON creator tier (cap 1). Enforcing tiers only makes that asymmetry visible, it
//     does not create it. Deciding what a non-member may clone is a founder/product call.
//   - `revoked_at IS NOT NULL` → cap **0**, regardless of tier/source. A revoked row is
//     an audit trail, not working membership — belt-and-suspenders with the other gates.
//   - `tier IS NULL` → UNLIMITED only when `source = 'founder'` (migration 0044's seed).
//     Any other NULL-tier row is the legacy free-grant bug #29 removed and must read as
//     cap **0**, never unlimited — that was exactly the bug this contract closes.
//   - Unrecognized tier string → cap **0** (fail-closed). NOT 1, NOT unlimited — a
//     typo'd/stray tier value must never grant anything, however small.
//   - Known tier → `MEMBERSHIP_TIERS[tier].agentLimit`. Single source of the 1/5/20
//     numbers (issue #29's `MEMBERSHIP_TIERS` above) — no second constant to drift.

const QUOTA_HINT = 'Повысьте ярус членства на /membership, чтобы создавать больше агентов.';

/** The shape every quota query selects — mirrors `hasCreatorMembership`'s WHERE clause. */
interface TierRow {
  tier: string | null;
  source: string | null;
  revoked_at: unknown;
}

/**
 * Resolve a `SELECT tier, source, revoked_at` result into a cap, or `null` for
 * UNLIMITED. See the module-level contract note above for the full case table.
 */
function capFromTierRows(rows: Array<TierRow>): number | null {
  if (rows.length === 0) return null; // no membership row → uncapped (non-member path)
  const row = rows[0]!;
  if (row.revoked_at !== null && row.revoked_at !== undefined) return 0;
  if (row.tier === null) return row.source === 'founder' ? null : 0;
  return isMembershipTier(row.tier) ? MEMBERSHIP_TIERS[row.tier].agentLimit : 0;
}

/** Thrown by `assertAgentQuota` when the caller is already at their tier's cap. */
export class QuotaExceededError extends Error {
  readonly quota: number;
  readonly count: number;
  constructor(quota: number, count: number) {
    super('quota_exceeded');
    this.name = 'QuotaExceededError';
    this.quota = quota;
    this.count = count;
  }
}

/** The 403 body every create-route returns when `assertAgentQuota` throws. */
export function quotaExceededBody(e: QuotaExceededError) {
  return { error: 'quota_exceeded' as const, quota: e.quota, count: e.count, hint: QUOTA_HINT };
}

/**
 * THE quota gate. Throws `QuotaExceededError` when the caller already owns as many
 * agents as their tier allows; returns silently when they may create one more.
 *
 * MUST be called with a TRANSACTION handle (`sql.begin(async (tx) => …)`) and the
 * INSERT INTO agents MUST happen in that same transaction. Two reasons:
 *
 *  - SERIALIZATION (TOCTOU). `SELECT … FOR UPDATE` takes a row lock on the caller's
 *    `tg_memberships` row and holds it until the transaction commits. Two concurrent
 *    creates by the same user therefore cannot both pass the count check: the second
 *    one BLOCKS on the lock until the first has committed its INSERT, then re-runs
 *    COUNT(*) and sees the new row. Without the shared lock both would read the same
 *    pre-insert count and both would insert, landing the user over cap. The membership
 *    row is the natural serialization point — a capped user always has one (an uncapped
 *    one has nothing to serialize, since there is no limit to race against), and it is
 *    the same `FOR UPDATE`-as-mutex pattern the payouts path already uses.
 *  - ATOMICITY. If the caller is over cap we throw, which rolls the transaction back —
 *    so a route that does other writes alongside the INSERT (the rent route debits the
 *    renter and credits the author) cannot charge for an agent it then refuses to create.
 *
 * NOT fail-open on DB error: a failing SELECT throws out of the transaction, which
 * aborts it → no INSERT. The caller surfaces a 500; nothing is created.
 */
export async function assertAgentQuota(
  tgUserId: string | number,
  tx: TransactionSql,
): Promise<void> {
  const tierRows = (await tx`
    SELECT tier, source, revoked_at FROM tg_memberships
    WHERE tg_user_id = ${tgUserId}::bigint
    FOR UPDATE
  `) as unknown as Array<TierRow>;

  const cap = capFromTierRows(tierRows);
  if (cap === null) return; // unlimited — nothing to enforce, nothing to serialize

  // Counts every agent the user OWNS and has not deleted — created from scratch,
  // cloned, or rented in. Same owner filter GET /api/tma/agents uses for "my agents"
  // (and it rides the existing idx_agents_tg_user index). Agents merely HIRED are an
  // `agent_sessions` row, not an owned `agents` row, so they do not count against the
  // cap — hire is a separate, deliberately ungated path.
  const countRows = (await tx`
    SELECT COUNT(*)::int AS n FROM agents
    WHERE tg_user_id = ${tgUserId}::bigint AND status != 'deleted'
  `) as unknown as Array<{ n: number }>;
  const count = countRows[0]?.n ?? 0;

  if (count >= cap) throw new QuotaExceededError(cap, count);
}

/**
 * READ-ONLY advisory pre-check (no lock, no transaction). Only for surfaces that do
 * NOT insert an agent and just want to fail early — today that is the AI-builder, which
 * burns a house-funded LLM call to draft a spec the user could not save anyway. It is
 * NOT an enforcement point: every real enforcement goes through `assertAgentQuota`
 * inside the inserting transaction. Fail-CLOSED on DB error (reports over-quota).
 */
export async function checkAgentQuota(
  tgUserId: string | number,
  sql: Sql,
): Promise<{ ok: true } | { ok: false; quota: number; count: number }> {
  try {
    const tierRows = (await sql`
      SELECT tier, source, revoked_at FROM tg_memberships
      WHERE tg_user_id = ${tgUserId}::bigint
      LIMIT 1
    `) as unknown as Array<TierRow>;
    const cap = capFromTierRows(tierRows);
    if (cap === null) return { ok: true };

    const countRows = (await sql`
      SELECT COUNT(*)::int AS n FROM agents
      WHERE tg_user_id = ${tgUserId}::bigint AND status != 'deleted'
    `) as unknown as Array<{ n: number }>;
    const count = countRows[0]?.n ?? 0;
    return count < cap ? { ok: true } : { ok: false, quota: cap, count };
  } catch {
    return { ok: false, quota: 1, count: 1 };
  }
}
