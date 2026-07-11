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
 * Membership tiers (founder decision 2026-07-11, issue #29). Numbers are fixed
 * business constants, not a model/service price — no env override, mirrors how
 * `docs/superpowers/specs/2026-06-26-research-nft-membership.md:266-270` sets them.
 * `agentLimit`/`revSharePct` are recorded for future gates; THIS issue only wires the
 * purchase + the binary creator gate above (any tier passes it), per issue boundary.
 */
export const MEMBERSHIP_TIERS = {
  creator: { label: 'Creator', priceTon: '2', agentLimit: 1, revSharePct: 0 },
  builder: { label: 'Builder', priceTon: '10', agentLimit: 5, revSharePct: 15 },
  studio: { label: 'Studio', priceTon: '30', agentLimit: 20, revSharePct: 30 },
} as const;

export type MembershipTier = keyof typeof MEMBERSHIP_TIERS;

export function isMembershipTier(v: unknown): v is MembershipTier {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(MEMBERSHIP_TIERS, v);
}

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
  opts?: { nftAddress?: string; source?: string; tier?: MembershipTier },
): Promise<void> {
  const nftAddress = opts?.nftAddress ?? null;
  const source = opts?.source ?? 'nft';
  const tier = opts?.tier ?? null;
  await sql`
    INSERT INTO tg_memberships (tg_user_id, nft_address, source, tier)
    VALUES (${tgUserId}::bigint, ${nftAddress}, ${source}, ${tier})
    ON CONFLICT (tg_user_id) DO UPDATE SET
      nft_address = COALESCE(${nftAddress}, tg_memberships.nft_address),
      source      = COALESCE(${source}, tg_memberships.source),
      tier        = COALESCE(${tier}, tg_memberships.tier)
  `;
}
