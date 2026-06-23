/**
 * Shared validation + reachability probe for "Свой агент" (external
 * OpenAI-compatible upstream).
 *
 * SSRF guard rules:
 *  - HTTPS only (no plain http://, no file:// etc.)
 *  - reject loopback, link-local, RFC1918 private ranges, .local, .internal
 *  - reject obvious metadata services (169.254.169.254)
 *
 * The probe just calls `GET ${base}/models` with the user's bearer to confirm
 * the endpoint is alive and the key is valid.
 *
 * ⚠️ `validateExternalUrl` below is only a cheap synchronous PRE-flight (regex /
 * literal-IP rejection). It does NOT defend against DNS-rebinding (a public host
 * that resolves to 127.0.0.1 / 169.254.169.254 / RFC1918) or a 302 redirect into
 * an internal host — the URL parses fine, the regex sees a public hostname, and a
 * naive fetch then dials the internal IP. The real defence is `safeFetch`, which
 * DNS-resolves every A/AAAA record, blocks the private ranges, pins the socket to
 * the vetted IP (anti-rebind) and re-validates every redirect hop. So the actual
 * outbound probe MUST go through `safeFetch`, never raw `fetch`.
 */

import { safeFetch, SsrfError } from './safe-fetch';

export interface ValidationResult {
  ok: boolean;
  reason?: string;
  host?: string;
}

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /\.lan$/i,
];

function isPrivateIPv4(host: string): boolean {
  // very rough — full check happens at the OS level on fetch DNS resolve too,
  // but cheap pre-flight stops obvious mistakes early.
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host === '169.254.169.254') return true; // cloud metadata
  if (/^169\.254\./.test(host)) return true;   // link-local
  if (host === '0.0.0.0') return true;
  return false;
}

export function validateExternalUrl(raw: string): ValidationResult {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'https_only' };
  const host = u.hostname.toLowerCase();
  if (PRIVATE_HOST_PATTERNS.some((re) => re.test(host))) {
    return { ok: false, reason: 'private_host_blocked' };
  }
  if (isPrivateIPv4(host)) return { ok: false, reason: 'private_ip_blocked' };
  // No IPv6 loopback / ULA either.
  if (host === '::1' || host.startsWith('[::1]')) {
    return { ok: false, reason: 'private_ip_blocked' };
  }
  return { ok: true, host };
}

export interface ProbeResult {
  ok: boolean;
  status?: number;
  model_count?: number;
  sample_models?: string[];
  error?: string;
}

/**
 * Try GET <base>/models with the user's bearer. We don't care about the
 * concrete schema variant — OpenAI uses {data:[...]}, some servers use
 * {models:[...]}, vLLM mirrors OpenAI. We just confirm 2xx + something
 * model-shaped in the payload.
 */
export async function probeExternalEndpoint(
  base: string,
  apiKey: string,
  timeoutMs = 8000,
): Promise<ProbeResult> {
  const trimmed = base.replace(/\/+$/, '');
  const url = `${trimmed}/models`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // SSRF-hardened: safeFetch DNS-resolves + blocks private ranges + pins the
    // socket + re-validates redirects. It throws SsrfError on a policy violation
    // (e.g. a public host that rebinds to an internal IP) — caught below.
    const res = await safeFetch(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
      },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: text.slice(0, 200) };
    }
    const j = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!j) return { ok: true, status: res.status };
    const list =
      (Array.isArray(j.data) && (j.data as Array<{ id?: string }>)) ||
      (Array.isArray(j.models) && (j.models as Array<{ id?: string }>)) ||
      null;
    if (!list) return { ok: true, status: res.status };
    return {
      ok: true,
      status: res.status,
      model_count: list.length,
      sample_models: list
        .slice(0, 5)
        .map((m) => m.id ?? '')
        .filter(Boolean),
    };
  } catch (e) {
    clearTimeout(t);
    if (e instanceof SsrfError) {
      // Blocked by the SSRF guard (private/loopback/link-local target, encoded-IP
      // literal, or a redirect into an internal host). Don't leak the internal IP.
      return { ok: false, error: 'blocked_target' };
    }
    return { ok: false, error: (e as Error).message.slice(0, 200) };
  }
}
