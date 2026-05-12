/**
 * Loose SSRF guard for user-provided external endpoint URLs.
 * Pragmatic, not bullet-proof — the worker still has its own egress firewall.
 */

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^::1$/,
  /^fc[0-9a-f]{2}:/i,   // ULA
  /^fe80:/i,            // link-local
];

export interface UrlCheck {
  ok: boolean;
  reason?: string;
  normalised?: string;
}

export function validateExternalUrl(raw: string): UrlCheck {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'only_https_allowed' };
  const host = u.hostname.toLowerCase();
  if (!host) return { ok: false, reason: 'no_host' };
  for (const re of PRIVATE_HOST_PATTERNS) {
    if (re.test(host)) return { ok: false, reason: 'private_host_blocked' };
  }
  // Strip trailing slash from pathname so we can append /chat/completions cleanly.
  if (u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
  return { ok: true, normalised: u.toString() };
}
