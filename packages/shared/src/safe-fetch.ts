/**
 * safeFetch — SSRF-hardened outbound HTTP client.
 *
 * Threat model (synthesis D-7 / R1-7): user-controlled or admin-controlled
 * upstream URLs (external_openai agents, gateway endpoint.baseUrl) could point
 * at internal infrastructure (cloud metadata 169.254.169.254, localhost, the
 * private RFC1918 ranges, the DB, Redis, etc.). A naive `fetch(url)` trusts DNS
 * and follows redirects, so an attacker can:
 *   - resolve a public hostname to a private IP (DNS rebinding),
 *   - encode the host as an octal/decimal integer literal,
 *   - 302-redirect a vetted public host to an internal one.
 *
 * Defenses implemented here:
 *   1. HTTPS-only (no http://, file://, gopher://, ...).
 *   2. Reject IP-literal hosts that are octal/decimal/hex encoded.
 *   3. DNS-resolve the host (ALL A + AAAA records) and reject the request if
 *      ANY resolved address falls in the blocked set below.
 *   4. Pin the TCP connection to the exact validated IP via a per-request
 *      undici Agent whose custom `lookup` returns only that address. This
 *      closes the DNS-rebind window: the socket connects to the IP we vetted,
 *      while TLS SNI still uses the real hostname (cert validation intact).
 *   5. Re-validate on EVERY redirect hop — redirects are followed manually
 *      (redirect: 'manual') and each Location is run through the same checks.
 *   6. Optional exact host[:port] allowlist for the few endpoints we trust
 *      (127.0.0.1:4000 internal gateway, openrouter.ai).
 *
 * Runtime notes: the undici Agent / dispatcher path applies on Node (the
 * agent-worker runtime). On Bun the dispatcher option is ignored, but the
 * pre-flight DNS validation (steps 1–3, 6) and per-hop re-validation (step 5)
 * still run, so the guard degrades safely rather than failing open.
 */

import { lookup as dnsLookup } from 'node:dns';
import { promisify } from 'node:util';
import { isIP } from 'node:net';

const dnsLookupAll = promisify(dnsLookup);

const MAX_REDIRECTS = 5;

export interface SafeFetchOptions extends RequestInit {
  /**
   * Exact `host` or `host:port` values that bypass IP validation entirely.
   * Use ONLY for endpoints we fully control / trust. Matched case-insensitively.
   * Examples: '127.0.0.1:4000' (internal gateway), 'openrouter.ai'.
   */
  allowlist?: string[];
  /** Override the redirect cap (default 5). */
  maxRedirects?: number;
}

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

/* ----------------------------- IP classifiers ---------------------------- */

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const o = Number(p);
    if (o > 255) return null;
    n = n * 256 + o;
  }
  return n >>> 0;
}

/**
 * Blocked IPv4 ranges (returns the human label if blocked, else null).
 *   10.0.0.0/8         private
 *   172.16.0.0/12      private
 *   192.168.0.0/16     private
 *   127.0.0.0/8        loopback
 *   169.254.0.0/16     link-local (incl. 169.254.169.254 cloud metadata)
 *   100.64.0.0/10      CGNAT (RFC 6598)
 *   0.0.0.0/8          "this network"
 */
function blockedIPv4(ip: string): string | null {
  const n = ipv4ToInt(ip);
  if (n === null) return null;
  const inRange = (base: string, bits: number): boolean => {
    const b = ipv4ToInt(base)!;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) === (b & mask);
  };
  if (inRange('10.0.0.0', 8)) return '10.0.0.0/8 (private)';
  if (inRange('172.16.0.0', 12)) return '172.16.0.0/12 (private)';
  if (inRange('192.168.0.0', 16)) return '192.168.0.0/16 (private)';
  if (inRange('127.0.0.0', 8)) return '127.0.0.0/8 (loopback)';
  if (inRange('169.254.0.0', 16)) return '169.254.0.0/16 (link-local)';
  if (inRange('100.64.0.0', 10)) return '100.64.0.0/10 (CGNAT)';
  if (inRange('0.0.0.0', 8)) return '0.0.0.0/8 (this-network)';
  return null;
}

/**
 * Blocked IPv6 ranges (returns label if blocked, else null).
 *   ::1            loopback
 *   ::            unspecified
 *   fc00::/7       ULA (unique local)
 *   fe80::/10      link-local
 *   ::ffff:0:0/96  IPv4-mapped — unwrapped & re-checked against IPv4 rules
 */
function blockedIPv6(ip: string): string | null {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === '::1') return '::1 (loopback)';
  if (lower === '::') return ':: (unspecified)';

  // IPv4-mapped (::ffff:a.b.c.d or ::ffff:xxxx:xxxx) → validate as IPv4.
  const mapped = lower.match(/^::ffff:(.+)$/);
  if (mapped) {
    let v4 = mapped[1];
    if (isIP(v4) === 4) {
      const lbl = blockedIPv4(v4);
      return lbl ? `::ffff:0:0/96 (IPv4-mapped → ${lbl})` : null;
    }
    // hex form ::ffff:7f00:0001 → reconstruct dotted quad
    const hx = v4.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hx) {
      const hi = parseInt(hx[1], 16);
      const lo = parseInt(hx[2], 16);
      v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      const lbl = blockedIPv4(v4);
      return lbl ? `::ffff:0:0/96 (IPv4-mapped → ${lbl})` : null;
    }
  }

  // fc00::/7 (ULA): first byte 0xfc or 0xfd.
  const firstHextet = lower.split(':')[0];
  if (firstHextet) {
    const v = parseInt(firstHextet.padStart(4, '0').slice(0, 2), 16);
    if (v === 0xfc || v === 0xfd) return 'fc00::/7 (ULA)';
  }
  // fe80::/10 (link-local): fe80..febf.
  if (/^fe[89ab]/.test(lower)) return 'fe80::/10 (link-local)';
  return null;
}

/** Returns the blocked-range label for an IP literal, or null if allowed. */
export function classifyBlockedIp(ip: string): string | null {
  const kind = isIP(ip);
  if (kind === 4) return blockedIPv4(ip);
  if (kind === 6) return blockedIPv6(ip);
  return null;
}

/* ----------------------------- host hygiene ------------------------------ */

/**
 * Reject hostnames that are non-dotted-quad numeric IP literals (octal,
 * decimal, or hex integer forms that Node/curl will silently coerce to an
 * IP — e.g. http://2130706433/ === 127.0.0.1, http://0x7f.1/ etc.).
 * A normal hostname is alphanumeric+hyphen+dot; a plain dotted-quad is handled
 * by the DNS/IP path. Anything else that is all-numeric is suspicious.
 */
function rejectNumericLiteral(host: string): void {
  if (isIP(host) !== 0) return; // genuine dotted IPv4/IPv6 — handled elsewhere
  // Pure decimal integer (e.g. 2130706433) or 0x.. / 0.. octal forms.
  if (/^0x[0-9a-f]+$/i.test(host) || /^\d+$/.test(host) || /^0\d+$/.test(host)) {
    throw new SsrfError(`blocked encoded-IP literal host: ${host}`);
  }
  // Mixed octal/hex dotted forms like 0x7f.0.0.1 or 0177.0.0.1
  if (/\./.test(host) && host.split('.').every((p) => /^(0x[0-9a-f]+|0[0-7]*|\d+)$/i.test(p))) {
    // Looks like a dotted numeric literal but isIP() rejected it → encoded form.
    throw new SsrfError(`blocked encoded-IP literal host: ${host}`);
  }
}

/** Parse + validate one URL: HTTPS, host hygiene, allowlist, DNS-IP checks. */
async function vetUrl(
  raw: string,
  allowlist: Set<string>,
): Promise<{ url: URL; pinnedIp: string | null; family: number }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError(`invalid URL: ${raw}`);
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const hostPort = url.port ? `${host}:${url.port}` : host;

  // Exact allowlist bypass (host or host:port). Allowlisted hosts are fully
  // trusted (e.g. the internal http://127.0.0.1:4000 gateway), so they skip
  // BOTH the HTTPS and the IP-range checks. Keep this list tiny.
  if (allowlist.has(host) || allowlist.has(hostPort)) {
    return { url, pinnedIp: null, family: 0 };
  }

  // Non-allowlisted hosts must be HTTPS.
  if (url.protocol !== 'https:') {
    throw new SsrfError(`only https:// is allowed (got ${url.protocol})`);
  }

  rejectNumericLiteral(host);

  // If the host IS a literal IP, validate it directly (no DNS).
  const literalKind = isIP(host);
  if (literalKind !== 0) {
    const lbl = classifyBlockedIp(host);
    if (lbl) throw new SsrfError(`blocked IP ${host} in ${lbl}`);
    return { url, pinnedIp: host, family: literalKind };
  }

  // Resolve ALL addresses; reject if ANY is in a blocked range.
  let records: Array<{ address: string; family: number }>;
  try {
    records = (await dnsLookupAll(host, { all: true })) as Array<{
      address: string;
      family: number;
    }>;
  } catch (e) {
    throw new SsrfError(`DNS lookup failed for ${host}: ${(e as Error).message}`);
  }
  if (records.length === 0) {
    throw new SsrfError(`no DNS records for ${host}`);
  }
  for (const r of records) {
    const lbl = classifyBlockedIp(r.address);
    if (lbl) {
      throw new SsrfError(`blocked: ${host} resolves to ${r.address} in ${lbl}`);
    }
  }
  // Pin to the first vetted address (defense against rebind).
  const pin = records[0];
  return { url, pinnedIp: pin.address, family: pin.family };
}

/**
 * Build a per-request undici dispatcher (Node only) that forces the socket to
 * connect to the pre-validated IP. On Bun this is a no-op (dispatcher ignored),
 * which is acceptable: the pre-flight + per-hop validation already ran.
 */
async function buildPinnedDispatcher(
  pinnedIp: string,
  family: number,
): Promise<unknown | undefined> {
  try {
    // Non-literal specifier + dynamic import keeps undici fully optional and
    // Bun-safe, and avoids a build-time type dependency on the 'undici' module.
    const mod = 'undici';
    const undici = (await import(/* @vite-ignore */ mod)) as unknown as {
      Agent?: new (opts: unknown) => unknown;
    };
    if (!undici.Agent) return undefined;
    return new undici.Agent({
      connect: {
        // undici passes (hostname) but we force the vetted IP for every lookup.
        lookup: (
          _hostname: string,
          _opts: unknown,
          cb: (err: Error | null, address: string, family: number) => void,
        ) => cb(null, pinnedIp, family === 6 ? 6 : 4),
      },
    });
  } catch {
    return undefined; // undici not resolvable in this runtime
  }
}

/* ------------------------------- safeFetch ------------------------------- */

/**
 * Drop-in `fetch` replacement that blocks SSRF. Follows redirects manually,
 * re-validating each hop. Throws SsrfError on any policy violation.
 */
export async function safeFetch(
  input: string | URL,
  options: SafeFetchOptions = {},
): Promise<Response> {
  const { allowlist: allowArr, maxRedirects = MAX_REDIRECTS, ...init } = options;
  const allowlist = new Set((allowArr ?? []).map((s) => s.toLowerCase()));

  let currentUrl = typeof input === 'string' ? input : input.toString();
  let method = (init.method ?? 'GET').toUpperCase();
  let body = init.body;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const { url, pinnedIp, family } = await vetUrl(currentUrl, allowlist);

    const dispatcher = pinnedIp
      ? await buildPinnedDispatcher(pinnedIp, family)
      : undefined;

    const fetchInit: Record<string, unknown> = {
      ...init,
      method,
      body,
      redirect: 'manual', // we follow + re-validate ourselves
    };
    // `dispatcher` is a Node/undici-only RequestInit extension (ignored on Bun);
    // it pins the socket to the vetted IP. Typed loosely to stay runtime-portable.
    if (dispatcher) fetchInit.dispatcher = dispatcher;

    const res = await fetch(url.toString(), fetchInit as RequestInit);

    // Not a redirect → done.
    if (res.status < 300 || res.status > 399) return res;
    const location = res.headers.get('location');
    if (!location) return res; // redirect without target — hand back as-is

    if (hop === maxRedirects) {
      throw new SsrfError(`too many redirects (>${maxRedirects})`);
    }

    // Resolve relative redirects against the current URL, then re-vet next loop.
    currentUrl = new URL(location, url).toString();
    // Per fetch semantics, 303 (and 301/302 for non-GET/HEAD per most clients)
    // turn into GET without a body.
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'HEAD')) {
      method = 'GET';
      body = undefined;
    }
  }

  // Unreachable, but satisfies the type checker.
  throw new SsrfError('redirect loop guard');
}
