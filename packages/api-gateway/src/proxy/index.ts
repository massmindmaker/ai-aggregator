/**
 * Egress tunnel core: SOCKS5 (RFC 1928) and HTTP-CONNECT tunnels plus raw
 * HTTP(S) request execution over them.
 *
 * Why raw execution: Bun's fetch ignores undici dispatchers, so a proxied
 * request cannot be delegated to global fetch — instead the tunnel socket is
 * opened on node:net, upgraded to TLS via node:tls when the target is https,
 * and an HTTP/1.1 exchange is spoken manually.
 *
 * Contract differences vs global fetch (deliberate, documented):
 *   - The Response body is fully BUFFERED before resolving — no streaming /
 *     SSE through this path.
 *   - Redirects are NOT followed here; safeFetch re-vets and re-executes
 *     every hop itself.
 *   - Hop-by-hop headers (`connection`, `transfer-encoding`, `content-length`)
 *     are stripped from the returned Response; content-length is recomputed
 *     from the decoded body.
 */
import { Socket } from 'node:net';
import tls from 'node:tls';
import { extractExplicitPort, normalizeProxyUrl } from './url';
import type { ProxyConfig } from './url';
import { socksConnect, DEFAULT_TUNNEL_TIMEOUT_MS } from './socks';
import { httpConnect } from './httpConnect';

export { extractExplicitPort, normalizeProxyUrl };
export { socksConnect, SocksError, DEFAULT_TUNNEL_TIMEOUT_MS } from './socks';
export { httpConnect, HttpConnectError } from './httpConnect';
export type { ProxyConfig };

/** Parse + normalize a proxy URL into a concrete tunnel endpoint. */
export function parseProxyUrl(proxyUrl: string): ProxyConfig {
  const normalized = normalizeProxyUrl(proxyUrl, 'egress proxy');
  const parsed = new URL(normalized);
  // Normalized form always carries an explicit port; prefer the raw-string one
  // so default ports (80/443) survive URL parsing.
  const portStr = extractExplicitPort(normalized) ?? parsed.port;
  const cfg: ProxyConfig = {
    protocol:
      parsed.protocol === 'socks5:' ? 'socks5' : parsed.protocol === 'https:' ? 'https' : 'http',
    host: parsed.hostname.replace(/^\[|\]$/g, ''),
    port: Number(portStr),
  };
  if (parsed.username) cfg.username = decodeURIComponent(parsed.username);
  if (parsed.password) cfg.password = decodeURIComponent(parsed.password);
  return cfg;
}

/**
 * Open a tunnel socket through `proxyUrl` to `destHost:destPort`.
 * Throws for `https://` proxies (TLS-to-proxy not supported yet).
 */
export async function tunneledSocket(
  proxyUrl: string,
  destHost: string,
  destPort: number,
): Promise<Socket> {
  const cfg = parseProxyUrl(proxyUrl);
  switch (cfg.protocol) {
    case 'socks5':
      return socksConnect(cfg, destHost, destPort);
    case 'http':
      return httpConnect(cfg, destHost, destPort);
    case 'https':
      throw new Error('[proxy] https:// egress proxies (TLS to proxy) are not supported yet');
  }
}

/* --------------------------- raw HTTP execution --------------------------- */

const MAX_RESPONSE_HEADER_BYTES = 64 * 1024;
const MAX_RESPONSE_BODY_BYTES = 64 * 1024 * 1024;

/** Raised when the upstream stops sending data for longer than the read deadline. */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

function collectHeaders(init?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {};
  if (!init) return out;
  if (init instanceof Headers) {
    init.forEach((v, k) => {
      out[k] = v;
    });
  } else if (Array.isArray(init)) {
    for (const [k, v] of init) out[k] = v;
  } else {
    Object.assign(out, init);
  }
  return out;
}

async function encodeBody(body: BodyInit | null | undefined): Promise<Buffer | null> {
  if (body == null) return null;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body));
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return Buffer.from(body.toString(), 'utf8');
  }
  throw new TypeError(
    '[proxy] tunnel execution supports string / binary / URLSearchParams bodies only',
  );
}

function upgradeTls(socket: Socket, servername: string): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({ socket, servername, rejectUnauthorized: true }, () => {
      resolve(tlsSocket);
    });
    tlsSocket.once('error', reject);
  });
}

interface ParsedResponseHead {
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

/** True when the chunked body in `buf` has reached its terminal chunk. */
function chunkedComplete(buf: Buffer): boolean {
  return buf.includes('\r\n0\r\n') || buf.toString('latin1').startsWith('0\r\n');
}

/** Decode a complete chunked body (trailers after the terminal chunk are dropped). */
function decodeChunked(buf: Buffer): Buffer {
  const parts: Buffer[] = [];
  let pos = 0;
  for (;;) {
    const lineEnd = buf.indexOf('\r\n', pos);
    if (lineEnd === -1) throw new Error('[proxy] malformed chunked body: missing chunk size');
    const sizeToken = buf.subarray(pos, lineEnd).toString('latin1').split(';')[0].trim();
    const size = parseInt(sizeToken, 16);
    if (!Number.isFinite(size) || size < 0 || Number.isNaN(size)) {
      throw new Error(`[proxy] malformed chunk size "${sizeToken}"`);
    }
    pos = lineEnd + 2;
    if (size === 0) break;
    if (pos + size > buf.length) throw new Error('[proxy] truncated chunked body');
    parts.push(Buffer.from(buf.subarray(pos, pos + size)));
    pos += size + 2; // skip chunk payload + trailing CRLF
  }
  return parts.length ? Buffer.concat(parts) : Buffer.alloc(0);
}

interface RawReadDeadline {
  /** Idle deadline (ms): silence longer than this destroys the tunnel. */
  idleMs: number;
  /** True when a caller AbortSignal has fired (its error then wins the race). */
  aborted?: () => boolean;
}

function readRawResponse(
  socket: Socket,
  method: string,
  cleanupExtra?: () => void,
  deadline: RawReadDeadline = { idleMs: DEFAULT_TUNNEL_TIMEOUT_MS },
): Promise<ParsedResponseHead & { body: Buffer }> {
  return new Promise((resolve, reject) => {
    let acc = Buffer.alloc(0);
    let headParsed = false;
    let head: ParsedResponseHead | null = null;
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (): void => {
      if (idleTimer != null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('end', onEnd);
      socket.removeListener('close', onClose);
      cleanupExtra?.();
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const complete = (body: Buffer): void => {
      if (settled || !head) return;
      settled = true;
      cleanup();
      resolve({ ...head, body });
    };
    // Idle read-deadline: re-armed on every received chunk. A silent upstream
    // must never hang the promise forever.
    const armIdle = (): void => {
      if (idleTimer != null) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (settled) return;
        // A fired caller AbortSignal outranks this deadline — its handler
        // destroys the socket and settles with the abort cause instead.
        if (deadline.aborted?.()) {
          socket.destroy();
          return;
        }
        const err = new TimeoutError(
          `[proxy] upstream silent for ${deadline.idleMs}ms — response read deadline exceeded`,
        );
        // fail() detaches our 'error' listener; swallow the destroy-time
        // emission so it cannot surface as an unhandled 'error' event.
        socket.once('error', () => {});
        socket.destroy(err);
        fail(err);
      }, deadline.idleMs);
    };
    const onData = (chunk: Buffer): void => {
      armIdle(); // data is flowing → restart the idle window
      acc = acc.length ? Buffer.concat([acc, chunk]) : chunk;
      if (!headParsed) {
        const idx = acc.indexOf('\r\n\r\n');
        if (idx === -1) {
          if (acc.length > MAX_RESPONSE_HEADER_BYTES) {
            fail(new Error('[proxy] upstream response headers exceed 64KB'));
          }
          return;
        }
        const lines = acc.subarray(0, idx).toString('latin1').split('\r\n');
        const sm = /^HTTP\/1\.[01][ \t]+(\d{3})[ \t]*(.*)$/.exec(lines[0] ?? '');
        if (!sm) {
          fail(new Error(`[proxy] malformed response status line: ${lines[0] ?? ''}`));
          return;
        }
        const headers: Record<string, string> = {};
        for (const line of lines.slice(1)) {
          const ci = line.indexOf(':');
          if (ci > 0) headers[line.slice(0, ci).trim().toLowerCase()] = line.slice(ci + 1).trim();
        }
        head = {
          status: Number(sm[1]),
          statusText: sm[2].trim(),
          headers,
        };
        headParsed = true;
        acc = acc.subarray(idx + 4);
        if (Number(head.status) === 204 || Number(head.status) === 304 || method === 'HEAD') {
          complete(Buffer.alloc(0));
          return;
        }
      }
      const h = head as ParsedResponseHead;
      if ((h.headers['transfer-encoding'] ?? '').includes('chunked')) {
        if (chunkedComplete(acc)) complete(decodeChunked(acc));
      } else if (h.headers['content-length'] != null) {
        const n = Number(h.headers['content-length']);
        if (Number.isFinite(n) && acc.length >= n && n >= 0) complete(acc.subarray(0, n));
      }
      // else: close-delimited body → resolved by onEnd()
      if (acc.length > MAX_RESPONSE_BODY_BYTES) fail(new Error('[proxy] response body exceeds 64MB cap'));
    };
    const onError = (err: Error): void => fail(err);
    const onEnd = (): void => {
      if (!headParsed) fail(new Error('[proxy] connection closed before response headers'));
      else complete(acc);
    };
    const onClose = (): void => {
      // 'end' fires for graceful closes; 'close' alone means abrupt teardown.
      if (!settled) onEnd();
    };

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('end', onEnd);
    socket.on('close', onClose);
    armIdle();
  });
}

export interface FetchViaProxyOptions {
  /**
   * Address used for the CONNECT target instead of the URL hostname.
   * safeFetch passes the SSRF-vetted IP here so the anti-rebind guarantee
   * survives tunneling; the hostname still drives TLS SNI + the Host header.
   */
  connectAddr?: string;
  /**
   * Idle deadline (ms) for reading the upstream response. Every received
   * chunk resets it; silence longer than this destroys the tunnel socket and
   * rejects with {@link TimeoutError}. A fired caller AbortSignal takes
   * priority over this deadline. Default: DEFAULT_TUNNEL_TIMEOUT_MS.
   */
  responseIdleTimeoutMs?: number;
}

/**
 * Execute ONE HTTP(S) request through a SOCKS5/HTTP-CONNECT proxy and return
 * a buffered Response. See the module JSDoc for contract deltas vs fetch().
 */
export async function fetchViaProxy(
  url: string | URL,
  init: RequestInit = {},
  proxyUrl: string,
  opts: FetchViaProxyOptions = {},
): Promise<Response> {
  const target = new URL(url.toString());
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    throw new Error(`[proxy] fetchViaProxy supports only http(s) targets, got ${target.protocol}`);
  }
  const isTls = target.protocol === 'https:';
  const hostHeaderName = target.hostname.replace(/^\[|\]$/g, '');
  const port = target.port ? Number(target.port) : isTls ? 443 : 80;
  const connectAddr = opts.connectAddr ?? hostHeaderName;

  const method = (init.method ?? 'GET').toUpperCase();
  const extraHeaders = collectHeaders(init.headers);
  const bodyBytes = await encodeBody(init.body);

  const lowerKeys = new Set(Object.keys(extraHeaders).map((k) => k.toLowerCase()));
  const headers: Record<string, string> = { ...extraHeaders };
  if (!lowerKeys.has('host')) headers['host'] = target.host; // includes non-default port
  if (!lowerKeys.has('accept-encoding')) headers['accept-encoding'] = 'identity';
  headers['connection'] = 'close'; // buffered reads rely on deterministic framing
  if (bodyBytes && !lowerKeys.has('content-length')) {
    headers['content-length'] = String(bodyBytes.length);
  }

  const requestTarget = `${target.pathname}${target.search}`; // pathname is never empty
  let headBlock = `${method} ${requestTarget} HTTP/1.1\r\n`;
  for (const [k, v] of Object.entries(headers)) headBlock += `${k}: ${v}\r\n`;
  headBlock += '\r\n';

  const baseSocket = await tunneledSocket(proxyUrl, connectAddr, port);
  // Abort wiring happens BEFORE the TLS upgrade: an abort arriving between
  // tunnel establishment and handshake completion must kill the operation
  // immediately instead of waiting out the handshake.
  const signal = init.signal;
  let wire: Socket | tls.TLSSocket = baseSocket;
  let abortCleanup: (() => void) | undefined;
  if (signal) {
    const abortHandler = (): void =>
      wire.destroy(new Error('[proxy] request aborted via AbortSignal'));
    signal.addEventListener('abort', abortHandler, { once: true });
    abortCleanup = (): void => signal.removeEventListener('abort', abortHandler);
    if (signal.aborted) abortHandler();
  }
  try {
    if (isTls) wire = await upgradeTls(baseSocket, hostHeaderName);
    try {
      wire.write(Buffer.from(headBlock, 'utf8'));
      if (bodyBytes && bodyBytes.length > 0) wire.write(bodyBytes);
      const res = await readRawResponse(wire, method, abortCleanup, {
        idleMs: opts.responseIdleTimeoutMs ?? DEFAULT_TUNNEL_TIMEOUT_MS,
        aborted: (): boolean => signal?.aborted ?? false,
      });

      const respHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (k === 'connection' || k === 'transfer-encoding' || k === 'content-length') continue;
        respHeaders.set(k, v);
      }
      const body = res.body;
      if (!(res.status === 204 || res.status === 304)) {
        respHeaders.set('content-length', String(body.length));
      }
      return new Response(body.length > 0 ? body : null, {
        status: res.status,
        statusText: res.statusText,
        headers: respHeaders,
      });
    } catch (e) {
      abortCleanup?.();
      throw e;
    }
  } finally {
    baseSocket.destroy();
  }
}
