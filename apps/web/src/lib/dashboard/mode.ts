// Pure mode resolution: ?mode= query > path-family fallback > 'user'.
// Used by the dashboard layout (server) to pick the active sidebar tab and
// by the sidebar (client) to highlight the active chip. Keeping it free of
// React / Next imports so it's trivially testable and reusable.

export type Mode = 'user' | 'author';

export const MODES: readonly Mode[] = ['user', 'author'] as const;

/**
 * Earned-role signal gating the Author mode (computed in
 * lib/dashboard/roles.ts). 'user' needs no signal — it's the default mode
 * everyone gets.
 */
export interface EarnedRoles {
  hasAuthored: boolean;
}

const AUTHOR_PREFIXES = [
  '/dashboard/models',
  '/dashboard/earnings',
  '/dashboard/payouts',
  '/dashboard/kyc',
];

export function inferModeFromPath(pathname: string): Mode {
  if (AUTHOR_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'))) return 'author';
  return 'user';
}

export function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value);
}

/**
 * Resolve the active mode given query + path, then clamp an explicit
 * `?mode=author` override to what the user has actually earned. A hand-typed
 * or bookmarked `?mode=author` from a user who hasn't authored anything falls
 * back to 'user' — a user must never land on a role surface they haven't
 * earned.
 *
 * Path-based inference is left unclamped on purpose: visiting an author
 * subpage directly — e.g. `/dashboard/models/new`, the "become an author"
 * entry point — must still show that section's nav. Earned-state gates the
 * query-driven mode switcher, not page access.
 */
export function resolveMode(
  query: string | string[] | undefined,
  pathname: string,
  earned: EarnedRoles
): Mode {
  const q = Array.isArray(query) ? query[0] : query;
  if (isMode(q)) {
    if (q === 'author' && !earned.hasAuthored) return 'user';
    return q;
  }
  return inferModeFromPath(pathname);
}
