// Creator membership gate (founder decision 2026-06-24).
//
// A membership = a row in `tg_memberships`. Holders may CREATE agents from scratch;
// non-holders are blocked at the create endpoints (but HIRE/CLONE stay open). The flag
// is backed by NFT ownership when a collection is configured (see nft-ownership.ts) and
// synced into this table via POST /api/tma/membership. Founder is seeded by migration
// 0044 so the gate never fully locks creation out.
//
// These helpers accept the caller's existing `postgres` client so a route does NOT open
// a second connection pool (each route already makes its own `sql`).
import type { Sql, TransactionSql } from 'postgres';

/**
 * True if `tgUserId` has a creator membership. Fail-CLOSED: any error returns false
 * (deny creation) — safer than fail-open for an access gate.
 */
export async function hasCreatorMembership(
  tgUserId: string | number,
  sql: Sql,
): Promise<boolean> {
  try {
    const rows = (await sql`
      SELECT 1 FROM tg_memberships WHERE tg_user_id = ${tgUserId}::bigint LIMIT 1
    `) as unknown as Array<unknown>;
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Upsert a membership for `tgUserId`. ON CONFLICT updates nft_address/source only when
 * provided (COALESCE keeps the existing value otherwise). Throws on DB error — callers
 * that must never 500 (the sync route) should catch.
 */
export async function grantMembership(
  tgUserId: string | number,
  sql: Sql,
  opts?: { nftAddress?: string; source?: string },
): Promise<void> {
  const nftAddress = opts?.nftAddress ?? null;
  const source = opts?.source ?? 'nft';
  await sql`
    INSERT INTO tg_memberships (tg_user_id, nft_address, source)
    VALUES (${tgUserId}::bigint, ${nftAddress}, ${source})
    ON CONFLICT (tg_user_id) DO UPDATE SET
      nft_address = COALESCE(${nftAddress}, tg_memberships.nft_address),
      source      = COALESCE(${source}, tg_memberships.source)
  `;
}

// ---- Agent quotas by membership tier (issue #32) ----------------------------------
//
// Tiers are sold as "1 agent / 5 agents / 20 agents" on /membership but until now
// `tg_memberships.tier` was never read — every holder got the same unlimited creation
// right. This section makes the tier actually cap the number of agents a user OWNS.
//
// DEPENDENCY: `tier` is added by migration 0048_membership_purchase.sql, which ships
// on the separate #29 branch (membership purchase flow) — NOT part of this branch's
// migrations. Merge order: #29 (adds the column) → #32 (this code, which reads it).
// Written as if the column already exists; do not add a migration for it here.
//
// THE CAP IS ON OWNED AGENTS, NOT ON ONE ROUTE. Four routes INSERT INTO agents
// (from-scratch create, agent clone, template clone, template rent) — every one of
// them must go through `assertAgentQuota`, or the tier means nothing again (buy the
// 2-TON creator tier, create your 1 agent, then clone 19 more for free).
//
// UNLIMITED (no cap) in exactly two cases:
//   1. Membership row with tier IS NULL — the founder-seed row from migration 0044
//      (`INSERT INTO tg_memberships (tg_user_id, source) VALUES (217133707,'founder')`
//      never sets `tier`) and any pre-0048 untiered grant. Must never be capped.
//   2. NO membership row at all — a non-member. They cannot reach POST /agents
//      (`hasCreatorMembership` already 403s them), but clone/rent are deliberately
//      OPEN to non-members (that is how you try the product), and they were unlimited
//      there before this change. Capping them here would invent a tier nobody sells
//      and strand every existing non-member who already cloned >1 agent, so their
//      behavior is left exactly as it was.
//   ⚠️ Case 2 leaves a PRE-EXISTING product hole this issue does not cover: a user who
//      buys nothing can still clone without limit, which is a strictly better deal than
//      the 2-TON creator tier (cap 1). Enforcing tiers only makes that pre-existing
//      asymmetry visible — it does not create it. Deciding what a non-member may clone
//      is a founder/product call (a free tier?), so it is flagged, not silently chosen.

/** Per-tier agent cap. Keys must match the `tier` values migration 0048 writes. */
const TIER_QUOTAS: Record<string, number> = {
  creator: 1,
  builder: 5,
  studio: 20,
};

const QUOTA_HINT = 'Повысьте ярус членства на /membership, чтобы создавать больше агентов.';

/**
 * Resolve a `SELECT tier` result into a cap. `null` = UNLIMITED (the two cases above:
 * no row, or a row whose tier IS NULL). An UNRECOGNIZED tier string falls back to the
 * SMALLEST known cap (1) rather than unlimited — fail-closed, so a typo'd/stray tier
 * value can never be used to bypass the cap.
 */
function capFromTierRows(rows: Array<{ tier: string | null }>): number | null {
  if (rows.length === 0) return null; // case 2: no membership row → uncapped
  const tier = rows[0]?.tier ?? null;
  if (tier === null) return null; // case 1: founder-seed / untiered legacy grant
  return TIER_QUOTAS[tier] ?? 1;
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
    SELECT tier FROM tg_memberships
    WHERE tg_user_id = ${tgUserId}::bigint
    FOR UPDATE
  `) as unknown as Array<{ tier: string | null }>;

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
      SELECT tier FROM tg_memberships WHERE tg_user_id = ${tgUserId}::bigint LIMIT 1
    `) as unknown as Array<{ tier: string | null }>;
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
