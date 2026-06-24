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
