/**
 * HTTP CONNECT tunnel (RFC 7231 §4.3.6) over `node:net`.
 *
 * Sends `CONNECT host:port HTTP/1.1` (+ optional Proxy-Authorization: Basic),
 * validates the proxy's response — any non-2xx status throws
 * {@link HttpConnectError} with the numeric status — and resolves with the raw
 * tunnel socket once the 2xx header block is consumed.
 */
import { Socket, isIPv6 } from 'node:net';
import type { ProxyConfig } from './url';
import { connectTcp, DEFAULT_TUNNEL_TIMEOUT_MS } from './socks';

export class HttpConnectError extends Error {
  constructor(
    message: string,
    /** Numeric status the proxy answered CONNECT with (when known). */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'HttpConnectError';
  }
}

const MAX_CONNECT_HEADER_BYTES = 16 * 1024;

/**
 * Read from `socket` until the first `\r\n\r\n`, returning the full header
 * block and any payload bytes that arrived with/beyond it.
 */
function readHeaderBlock(
  socket: Socket,
): Promise<{ head: Buffer; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let acc: Buffer = Buffer.alloc(0);
    const cleanup = (): void => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    };
    const onData = (chunk: Buffer): void => {
      acc = acc.length ? Buffer.concat([acc, chunk]) : chunk;
      const idx = acc.indexOf('\r\n\r\n');
      if (idx === -1) {
        if (acc.length > MAX_CONNECT_HEADER_BYTES) {
          cleanup();
          reject(new Error('[proxy] HTTP CONNECT response exceeds 16KB header limit'));
        }
        return;
      }
      cleanup();
      const head = Buffer.from(acc.subarray(0, idx + 4));
      const rest = Buffer.from(acc.subarray(idx + 4));
      resolve({ head, rest });
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error('[proxy] connection closed before HTTP CONNECT response completed'));
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

/**
 * Open an HTTP-CONNECT tunnel through `cfg` to `destHost:destPort` and resolve
 * with the raw tunnel socket after a 2xx CONNECT response.
 */
export async function httpConnect(
  cfg: ProxyConfig,
  destHost: string,
  destPort: number,
  timeoutMs: number = DEFAULT_TUNNEL_TIMEOUT_MS,
): Promise<Socket> {
  const socket = await connectTcp(cfg.host, cfg.port, timeoutMs);
  const watchdog = setTimeout(() => {
    socket.destroy(
      new Error(`[proxy] HTTP CONNECT handshake with ${cfg.host}:${cfg.port} timed out after ${timeoutMs}ms`),
    );
  }, timeoutMs);
  try {
    const authority = isIPv6(destHost) ? `[${destHost}]:${destPort}` : `${destHost}:${destPort}`;
    const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
    if (cfg.username != null || cfg.password != null) {
      const basic = Buffer.from(`${cfg.username ?? ''}:${cfg.password ?? ''}`, 'utf8').toString(
        'base64',
      );
      lines.push(`Proxy-Authorization: Basic ${basic}`);
    }
    socket.write(lines.join('\r\n') + '\r\n\r\n');

    const { head, rest } = await readHeaderBlock(socket);
    const headText = head.toString('latin1');
    const m = /^HTTP\/1\.[01][ \t]+(\d{3})[ \t]*([^\r]*)/.exec(headText);
    if (!m) {
      throw new HttpConnectError(
        `[proxy] malformed HTTP CONNECT response: ${headText.split('\r\n')[0]}`,
      );
    }
    const status = Number(m[1]);
    if (!(status >= 200 && status < 300)) {
      throw new HttpConnectError(
        `[proxy] HTTP CONNECT failed: ${status}${m[2].trim() ? ` ${m[2].trim()}` : ''}`,
        status,
      );
    }
    if (rest.length > 0) socket.unshift(rest); // re-queue tunneled early bytes
    return socket;
  } catch (e) {
    socket.destroy();
    throw e;
  } finally {
    clearTimeout(watchdog);
  }
}
