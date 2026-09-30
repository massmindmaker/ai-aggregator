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
 * Earned-role signal behind the dashboard's Author tab:
 * - hasAuthored: at least one row in `models` authored by this user (any
 *   status — authoring is the signal, not having a live model).
 *
 * It's a cheap indexed EXISTS check (idx_models_author_user). A query failure
 * defaults to false (unearned) — the safe direction, it never over-shows a
 * role surface.
 *
 * Wrapped in React's `cache()`: the dashboard layout and the dashboard page
 * both call this in the same request, so this makes them share one round
 * trip instead of two.
 */
export const getEarnedRoles = cache(async (userId: string): Promise<EarnedRoles> => {
  const hasAuthored = await fetchExists(sql`
    SELECT EXISTS(SELECT 1 FROM models WHERE author_user_id = ${userId}::uuid) AS present
  `);
  return { hasAuthored };
});
