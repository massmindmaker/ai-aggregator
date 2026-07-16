// Pure gate decision for the public playground endpoint.
//
// 🔴 P0 fix: the old check was `if (ip && !checkRateLimit(ip))` — when the
// client IP could not be resolved, the `if (ip && ...)` short-circuited and
// the request was let through with NO limit at all. That is exactly how
// `POST /api/playground/run` was reachable unauthenticated, unlimited,
// spending real upstream money on the system key (confirmed live, 200
// without auth). Fail-closed: an unresolved IP is now a REJECTION, not a
// bypass.
export function playgroundAllowed(args: {
  ip: string | null | undefined;
  used: number;
  limit: number;
}): boolean {
  if (!args.ip) return false;
  return args.used < args.limit;
}
