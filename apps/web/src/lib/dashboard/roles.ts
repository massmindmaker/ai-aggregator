import { cache } from 'react';
import { db, sql } from '@/lib/db';
import type { EarnedRoles } from '@/lib/dashboard/mode';

interface ExistsRow {
  present: boolean;
}

async function fetchExists(query: ReturnType<typeof sql>): Promise<boolean> {
  try {
    const r = await db.execute(query);
    const rows = ((r as unknown as { rows?: unknown[] }).rows ?? r) as ExistsRow[];
    return Boolean(rows[0]?.present);
  } catch {
    return false;
  }
}

/**
 * Earned-role signals behind the dashboard's Author / Participant tabs:
 * - hasAuthored: at least one row in `models` authored by this user (any
 *   status — authoring is the signal, not having a live model).
 * - hasEntered: at least one row in `contest_participants` for this user
 *   (written by POST /api/contests/[slug]/register).
 * Both are cheap indexed EXISTS checks (idx_models_author_user,
 * contest_participants_user_idx). A query failure defaults to false
 * (unearned) — the safe direction, it never over-shows a role surface.
 *
 * Wrapped in React's `cache()`: the dashboard layout and the dashboard page
 * both call this in the same request, so this makes them share one round
 * trip instead of two.
 */
export const getEarnedRoles = cache(async (userId: string): Promise<EarnedRoles> => {
  const [hasAuthored, hasEntered] = await Promise.all([
    fetchExists(sql`
      SELECT EXISTS(SELECT 1 FROM models WHERE author_user_id = ${userId}::uuid) AS present
    `),
    fetchExists(sql`
      SELECT EXISTS(SELECT 1 FROM contest_participants WHERE user_id = ${userId}::uuid) AS present
    `),
  ]);
  return { hasAuthored, hasEntered };
});
