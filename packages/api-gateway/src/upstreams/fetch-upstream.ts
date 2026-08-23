/**
 * fetchUpstream — the SINGLE funnel for every outbound upstream HTTP call in
 * the gateway (native egress integration T2).
 *
 * Adapters must NOT call safeFetch/fetch directly with their own proxy logic.
 * They call fetchUpstream(url, init, req.egressProxyUrl) and the per-request
 * egress target is resolved HERE exactly once:
 *
 *   1. model_upstreams.egress_proxy  (threaded from the resolver candidate)
 *   2. env AIAG_EGRESS_PROXY_URL     (fleet-wide default)
 *   3. undefined                     → direct connection
 *
 * When a proxy resolves, safeFetch tunnels via the registered executor
 * (SOCKS5 / HTTP-CONNECT — see proxy/index.ts). ALL SSRF guards run against
 * the destination identically with or without a proxy; only trivially
 * encodable bodies are supported on the proxied path and the Response body is
 * buffered there (see shared/safe-fetch.ts JSDoc).
 */
import { safeFetch } from '@aiag/shared/server';
import { logger } from '../lib/logger';

export type EgressSource = 'upstream_column' | 'env' | 'direct';

/**
 * Resolve the effective egress proxy for ONE upstream request.
 * Precedence: upstream column > env > direct. Whitespace-only values count
 * as unset (ops-friendly: an empty override in the DB disables the column
 * tier without forcing NULL semantics).
 */
export function resolveEgressProxy(
  upstreamColumn?: string | null,
  envValue?: string,
): { proxyUrl?: string; source: EgressSource } {
  const col = upstreamColumn?.trim();
  if (col) return { proxyUrl: col, source: 'upstream_column' };
  const env = (envValue ?? process.env.AIAG_EGRESS_PROXY_URL)?.trim();
  if (env) return { proxyUrl: env, source: 'env' };
  return { proxyUrl: undefined, source: 'direct' };
}

/** RequestInit extended with safeFetch's non-standard allowlist option. */
export type FetchUpstreamInit = Omit<RequestInit, 'body'> & {
  body?: RequestInit['body'];
  allowlist?: string[];
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Execute one upstream request with the resolved egress policy applied.
 * `upstreamEgressProxy` is the RAW model_upstreams.egress_proxy value for the
 * selected candidate (null/undefined when the column is unset) — resolution
 * happens here, never in the adapter.
 */
export async function fetchUpstream(
  url: string,
  init: FetchUpstreamInit,
  upstreamEgressProxy?: string | null,
): Promise<Response> {
  const { proxyUrl, source } = resolveEgressProxy(upstreamEgressProxy);
  // Лог выбора (plan T2 step 2): proxied egress is an ops-relevant event;
  // direct stays at debug so normal traffic doesn't spam structured logs.
  if (source === 'direct') {
    logger.debug({ host: hostOf(url) }, 'egress_direct');
  } else {
    logger.info({ host: hostOf(url), source }, 'egress_via_proxy');
  }
  const { allowlist, ...rest } = init;
  return safeFetch(url, {
    ...rest,
    ...(allowlist ? { allowlist } : {}),
    egressProxyUrl: proxyUrl,
  });
}
