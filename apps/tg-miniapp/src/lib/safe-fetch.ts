/**
 * safeFetch — SSRF-hardened outbound HTTP client (tg-miniapp local copy).
 *
 * NOTE: this mirrors apps/agent-worker/src/safe-fetch.ts and
 * packages/shared/src/safe-fetch.ts verbatim. tg-miniapp is a standalone Next
 * app built on the VPS and does NOT depend on @aiag/shared (see package.json),
 * so — exactly like agent-worker — it carries its own copy rather than
 * importing the workspace package. Keep all three in sync; logic is identical.
 * Used by the read-only Hermes-kanban poller route to fetch a user-supplied
 * Hermes dashboard endpoint server-side without opening an SSRF hole.
 *
 * Threat model (synthesis D-7 / R1-7): external_openai agents let users supply
 * an arbitrary `external_base_url`. A naive fetch trusts DNS + redirects, so an
 * attacker can point the worker at cloud metadata (169.254.169.254), localhost,
 * the DB/Redis, or RFC1918 hosts via DNS rebinding, an integer-encoded literal,
 * or a 302 redirect from a public host to an internal one.
 *
 * Defenses: HTTPS-only; reject octal/decimal/hex IP literals; DNS-resolve ALL
 * A/AAAA and reject if ANY is in the blocked set; pin the socket to the vetted
 * IP via a per-request undici Agent (anti-rebind, Node only); re-validate every
 * redirect hop (redirect:'manual'); exact host[:port] allowlist for trusted
 * endpoints (127.0.0.1:4000 internal gateway, openrouter.ai).
 */

import { lookup as dnsLookup } from 'node:dns';
import { promisify } from 'node:util';
import { isIP } from 'node:net';

const dnsLookupAll = promisify(dnsLookup);

const MAX_REDIRECTS = 5;

export interface SafeFetchOptions extends RequestInit {
  /** Exact `host` or `host:port` values that bypass IP validation (trusted). */
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
 * Blocked IPv4 ranges (label if blocked, else null):
 *   10/8, 172.16/12, 192.168/16 private; 127/8 loopback; 169.254/16 link-local
 *   (incl. 169.254.169.254 metadata); 100.64/10 CGNAT; 0/8 this-network.
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
 * Blocked IPv6 ranges (label if blocked, else null):
 *   ::1 loopback; :: unspecified; fc00::/7 ULA; fe80::/10 link-local;
 *   ::ffff:0:0/96 IPv4-mapped (unwrapped + re-checked as IPv4).
 */
function blockedIPv6(ip: string): string | null {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === '::1') return '::1 (loopback)';
  if (lower === '::') return ':: (unspecified)';

  const mapped = lower.match(/^::ffff:(.+)$/);
  if (mapped) {
    let v4 = mapped[1];
    if (isIP(v4) === 4) {
      const lbl = blockedIPv4(v4);
      return lbl ? `::ffff:0:0/96 (IPv4-mapped → ${lbl})` : null;
    }
    const hx = v4.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hx) {
      const hi = parseInt(hx[1], 16);
      const lo = parseInt(hx[2], 16);
      v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      const lbl = blockedIPv4(v4);
      return lbl ? `::ffff:0:0/96 (IPv4-mapped → ${lbl})` : null;
    }
  }

  const firstHextet = lower.split(':')[0];
  if (firstHextet) {
    const v = parseInt(firstHextet.padStart(4, '0').slice(0, 2), 16);
    if (v === 0xfc || v === 0xfd) return 'fc00::/7 (ULA)';
  }
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

/** Reject integer-encoded IP literals (octal/decimal/hex) that coerce to an IP. */
function rejectNumericLiteral(host: string): void {
  if (isIP(host) !== 0) return;
  if (/^0x[0-9a-f]+$/i.test(host) || /^\d+$/.test(host) || /^0\d+$/.test(host)) {
    throw new SsrfError(`blocked encoded-IP literal host: ${host}`);
  }
  if (/\./.test(host) && host.split('.').every((p) => /^(0x[0-9a-f]+|0[0-7]*|\d+)$/i.test(p))) {
    throw new SsrfError(`blocked encoded-IP literal host: ${host}`);
  }
}

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

  // Allowlisted hosts are fully trusted (e.g. internal http://127.0.0.1:4000):
  // skip BOTH the HTTPS and IP-range checks. Keep the list tiny.
  if (allowlist.has(host) || allowlist.has(hostPort)) {
    return { url, pinnedIp: null, family: 0 };
  }

  // Non-allowlisted hosts must be HTTPS.
  if (url.protocol !== 'https:') {
    throw new SsrfError(`only https:// is allowed (got ${url.protocol})`);
  }

  rejectNumericLiteral(host);

  const literalKind = isIP(host);
  if (literalKind !== 0) {
    const lbl = classifyBlockedIp(host);
    if (lbl) throw new SsrfError(`blocked IP ${host} in ${lbl}`);
    return { url, pinnedIp: host, family: literalKind };
  }

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
  const pin = records[0];
  return { url, pinnedIp: pin.address, family: pin.family };
}

async function buildPinnedDispatcher(
  pinnedIp: string,
  family: number,
): Promise<unknown | undefined> {
  try {
    const mod = 'undici';
    const undici = (await import(mod)) as unknown as {
      Agent?: new (opts: unknown) => unknown;
    };
    if (!undici.Agent) return undefined;
    return new undici.Agent({
      connect: {
        lookup: (
          _hostname: string,
          _opts: unknown,
          cb: (err: Error | null, address: string, family: number) => void,
        ) => cb(null, pinnedIp, family === 6 ? 6 : 4),
      },
    });
  } catch {
    return undefined;
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
      redirect: 'manual',
    };
    if (dispatcher) fetchInit.dispatcher = dispatcher;

    const res = await fetch(url.toString(), fetchInit as RequestInit);

    if (res.status < 300 || res.status > 399) return res;
    const location = res.headers.get('location');
    if (!location) return res;

    if (hop === maxRedirects) {
      throw new SsrfError(`too many redirects (>${maxRedirects})`);
    }

    currentUrl = new URL(location, url).toString();
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'HEAD')) {
      method = 'GET';
      body = undefined;
    }
  }

  throw new SsrfError('redirect loop guard');
}
