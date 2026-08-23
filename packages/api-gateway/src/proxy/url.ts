/**
 * Proxy URL normalization utilities.
 *
 * `extractExplicitPort`, the port/default helpers and `normalizeProxyUrl` are
 * ported from OmniRoute v3.8.50 — `open-sse/utils/proxyDispatcher.ts`:
 *
 *   MIT License
 *   Copyright (c) diegosouzapw
 *   https://github.com/diegosouzapw/OmniRoute
 *
 * Local adaptations vs. the upstream original (behavioral deltas, kept
 * deliberate and minimal):
 *   - dropped the `?family=ipv4|ipv6` connect-family marker handling — it
 *     depends on OmniRoute's `proxyFamily` module and AIAG config never emits
 *     family directives;
 *   - dropped the ENABLE_SOCKS5_PROXY env gate — SOCKS5 is always accepted at
 *     this layer; gating belongs to config resolution (spec §2.2).
 */

/** Parsed proxy endpoint used by the tunnel openers. */
export interface ProxyConfig {
  /** Tunnel protocol spoken TO the proxy. */
  protocol: 'socks5' | 'http' | 'https';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:', 'socks5:']);

/**
 * Extract the port from a proxy URL string before URL parsing.
 * `new URL("http://host:80")` strips port 80 since it's the HTTP default,
 * but proxy servers commonly listen on port 80/443, so we need to preserve it.
 */
export function extractExplicitPort(urlStr: string): string | null {
  try {
    const idx = urlStr.indexOf('://');
    if (idx === -1) return null;
    const authorityStart = idx + 3;
    const authorityEnd = urlStr.indexOf('/', authorityStart);
    const authority =
      authorityEnd === -1 ? urlStr.slice(authorityStart) : urlStr.slice(authorityStart, authorityEnd);
    const lastColon = authority.lastIndexOf(':');
    const atSign = authority.lastIndexOf('@');
    if (lastColon !== -1 && lastColon > atSign) {
      const portStr = authority.slice(lastColon + 1);
      if (/^\d+$/.test(portStr)) {
        const port = Number(portStr);
        if (Number.isInteger(port) && port >= 1 && port <= 65535) return String(port);
      }
    }
  } catch {}
  return null;
}

function defaultPortForProtocol(protocol: string): string {
  if (protocol === 'https:' || protocol === 'wss:') return '443';
  if (protocol === 'socks5:') return '1080';
  return '8080';
}

function normalizePort(
  port: string | number | null | undefined,
  protocol: string,
): string {
  if (!port) return defaultPortForProtocol(protocol);
  const parsed = Number(port);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error('[proxy] Invalid proxy port');
  }
  return String(parsed);
}

/**
 * Build a proxy URL string manually from parsed URL components.
 * We cannot use URL.toString() because the URL serializer silently strips
 * default ports (80 for http, 443 for https). Proxy servers commonly
 * listen on these ports, so we must always include the port explicitly.
 */
function buildProxyUrlString(parsed: URL, port: string): string {
  const auth =
    parsed.username || parsed.password ? `${parsed.username}:${parsed.password}@` : '';
  return `${parsed.protocol}//${auth}${parsed.hostname}:${port}`;
}

/**
 * Validate + canonicalize a proxy URL.
 * Returns the normalized form with an EXPLICIT port always present
 * (`socks5://[user:pass@]host[:port]` → default 1080, `http(s)` → 8080/443)
 * and credentials preserved as-is for later parsing.
 */
export function normalizeProxyUrl(proxyUrl: string, source = 'proxy'): string {
  // Extract the explicit port from the raw URL string BEFORE parsing,
  // because `new URL()` silently strips default ports (80 for http,
  // 443 for https), which are valid and common for proxy servers.
  const explicitPort = extractExplicitPort(proxyUrl);

  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    throw new Error(`[proxy] Invalid ${source} URL`);
  }

  if (!SUPPORTED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(
      `[proxy] Unsupported ${source} protocol: ${parsed.protocol.replace(':', '')}`,
    );
  }
  if (!parsed.hostname) {
    throw new Error(`[proxy] Invalid ${source} host`);
  }

  // Use the explicit port from the raw string if present, otherwise apply default.
  const port = explicitPort || normalizePort(parsed.port, parsed.protocol);

  // Build the URL string manually instead of using parsed.toString(),
  // which would strip default ports (80/443) and break the proxy connection.
  return buildProxyUrlString(parsed, port);
}
