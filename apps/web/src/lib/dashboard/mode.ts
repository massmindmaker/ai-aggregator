// Pure mode resolution: ?mode= query > path-family fallback > 'user'.
// Used by the dashboard layout (server) to pick the active sidebar tab and
// by the sidebar (client) to highlight the active chip. Keeping it free of
// React / Next imports so it's trivially testable and reusable.

export type Mode = 'user' | 'author' | 'participant';

export const MODES: readonly Mode[] = ['user', 'author', 'participant'] as const;

const AUTHOR_PREFIXES = [
  '/dashboard/models',
  '/dashboard/earnings',
  '/dashboard/payouts',
  '/dashboard/kyc',
];
const PARTICIPANT_PREFIXES = ['/dashboard/submissions', '/dashboard/wins'];

export function inferModeFromPath(pathname: string): Mode {
  if (AUTHOR_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'))) return 'author';
  if (PARTICIPANT_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'))) return 'participant';
  return 'user';
}

export function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value);
}

/** Resolve the active mode given query + path. Query wins over path. */
export function resolveMode(
  query: string | string[] | undefined,
  pathname: string
): Mode {
  const q = Array.isArray(query) ? query[0] : query;
  if (isMode(q)) return q;
  return inferModeFromPath(pathname);
}
