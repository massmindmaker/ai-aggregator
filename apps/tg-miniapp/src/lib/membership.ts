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
import type { Sql } from 'postgres';

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
// right. This section makes the tier actually cap agent count.
//
// DEPENDENCY: `tier` is added by migration 0048_membership_purchase.sql, which ships
// on the separate #29 branch (membership purchase flow) — NOT part of this branch's
// migrations. Merge order: #29 (adds the column) → #32 (this code, which reads it).
// Written as if the column already exists; do not add a migration for it here.
//
// NULL tier = UNLIMITED. That covers the founder-seed row from migration 0044
// (`INSERT INTO tg_memberships (tg_user_id, source) VALUES (217133707, 'founder')`,
// which never sets `tier` and so reads back NULL) and any pre-0048 legacy grant —
// neither must ever be capped.

/** Per-tier agent cap. Keys must match the `tier` values 0048 writes. */
const TIER_QUOTAS: Record<string, number> = {
  creator: 1,
  builder: 5,
  studio: 20,
};

/**
 * Resolves the caller's agent quota. `null` return = UNLIMITED (NULL `tier` column —
 * founder-seed or untiered legacy grant). A positive integer = the cap for that tier.
 * Fail-CLOSED on any DB error or unrecognized tier string: falls back to the smallest
 * known cap (1) rather than unlimited, so a DB hiccup or a stray tier value can't be
 * used to bypass the cap. Mirrors `hasCreatorMembership`'s fail-closed stance.
 */
export async function getAgentQuota(tgUserId: string | number, sql: Sql): Promise<number | null> {
  try {
    const rows = (await sql`
      SELECT tier FROM tg_memberships WHERE tg_user_id = ${tgUserId}::bigint LIMIT 1
    `) as unknown as Array<{ tier: string | null }>;
    const tier = rows[0]?.tier ?? null;
    if (tier === null) return null;
    return TIER_QUOTAS[tier] ?? 1;
  } catch {
    return 1;
  }
}

/**
 * Count of the caller's OWN, non-deleted agents — every row where they are the
 * `tg_user_id` owner (created from scratch, cloned, or rented into their account),
 * same filter `/api/tma/agents` GET uses for "my agents". Hired agents (an
 * `agent_sessions` row, not owned) do NOT count — hire is a separate, ungated path.
 * Fail-CLOSED: a DB error is treated as "at quota" (returns a very high count) rather
 * than silently allowing an unbounded create.
 */
export async function countOwnedAgents(tgUserId: string | number, sql: Sql): Promise<number> {
  try {
    const rows = (await sql`
      SELECT COUNT(*)::int AS n FROM agents
      WHERE tg_user_id = ${tgUserId}::bigint AND status != 'deleted'
    `) as unknown as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * The full quota gate a create-route calls: `{ ok:true }` when the caller may create
 * one more agent, else `{ ok:false, quota, count }` for building a 403 response.
 * `quota` is `null` when unlimited (never returned alongside `ok:false`).
 */
export async function checkAgentQuota(
  tgUserId: string | number,
  sql: Sql,
): Promise<{ ok: true } | { ok: false; quota: number; count: number }> {
  const quota = await getAgentQuota(tgUserId, sql);
  if (quota === null) return { ok: true };
  const count = await countOwnedAgents(tgUserId, sql);
  if (count < quota) return { ok: true };
  return { ok: false, quota, count };
}
