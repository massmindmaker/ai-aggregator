/**
 * Minimal SOCKS5 client (RFC 1928) over `node:net`.
 *
 * Supports: method negotiation (no-auth 0x00 / user-pass 0x02), the CONNECT
 * command, IPv4 / IPv6 / domain-name target addressing, and full BND.ADDR
 * consumption. Any proxy refusal (unsupported method, auth failure, non-zero
 * CONNECT reply) throws a {@link SocksError} carrying the protocol code.
 */
import { Socket, isIPv4, isIPv6, connect as netConnect } from 'node:net';
import type { ProxyConfig } from './url';

const SOCKS_VERSION = 0x05;
const CMD_CONNECT = 0x01;

const METHOD_NONE = 0x00;
const METHOD_USERPASS = 0x02;
const METHOD_NO_ACCEPTABLE = 0xff;

const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;

const REPLY_MESSAGES: Record<number, string> = {
  0: 'succeeded',
  1: 'general SOCKS server failure',
  2: 'connection not allowed by ruleset',
  3: 'network unreachable',
  4: 'host unreachable',
  5: 'connection refused',
  6: 'TTL expired',
  7: 'command not supported',
  8: 'address type not supported',
};

export class SocksError extends Error {
  constructor(
    message: string,
    /** RFC 1928 reply / auth status byte when the error came from a reply. */
    readonly replyCode?: number,
  ) {
    super(message);
    this.name = 'SocksError';
  }
}

export const DEFAULT_TUNNEL_TIMEOUT_MS = 15_000;

/** TCP-connect to `host:port`, rejecting on error or timeout. */
export function connectTcp(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port });
    const onError = (err: Error): void => {
      clearTimeout(timer);
      reject(err);
    };
    const timer = setTimeout(() => {
      socket.destroy();
      socket.removeListener('error', onError);
      reject(new Error(`[proxy] connect to ${host}:${port} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.once('error', onError);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeListener('error', onError);
      resolve(socket);
    });
  });
}

interface PendingRead {
  need: number;
  resolve: () => void;
  reject: (err: Error) => void;
}

/**
 * Strict sequential byte reader over a socket. Exactly one read is in flight
 * at a time (the tunnel protocols are strictly request/response).
 */
class ByteReader {
  private buf: Buffer = Buffer.alloc(0);
  private pending: PendingRead | null = null;
  private released = false;
  private readonly onData = (chunk: Buffer): void => {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (this.pending && this.buf.length >= this.pending.need) {
      const p = this.pending;
      this.pending = null;
      // Do NOT consume here — read() performs the single authoritative slice
      // once its continuation runs.
      p.resolve();
    }
  };
  private readonly onError = (err: Error): void => this.fail(err);
  private readonly onClose = (): void =>
    this.fail(new Error('[proxy] connection closed during handshake'));

  constructor(private readonly socket: Socket) {
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  private fail(err: Error): void {
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      p.reject(err);
    }
  }

  /** Wait until at least `n` bytes are buffered, then return exactly `n`. */
  async read(n: number): Promise<Buffer> {
    if (this.buf.length < n) {
      if (this.released || this.socket.destroyed) {
        throw new Error('[proxy] connection closed during handshake');
      }
      await new Promise<void>((resolve, reject) => {
        this.pending = { need: n, resolve, reject };
      });
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  leftover(): Buffer {
    return this.buf;
  }

  release(): void {
    this.released = true;
    this.socket.removeListener('data', this.onData);
    this.socket.removeListener('error', this.onError);
    this.socket.removeListener('close', this.onClose);
    this.buf = Buffer.alloc(0);
    this.pending = null;
  }
}

/** Encode a CONNECT target address per RFC 1928 §5 (ATYP + ADDR). */
function encodeAddress(host: string): { atyp: number; bytes: Buffer } {
  if (isIPv4(host)) {
    return { atyp: ATYP_IPV4, bytes: Buffer.from(host.split('.').map(Number)) };
  }
  if (isIPv6(host)) {
    return { atyp: ATYP_IPV6, bytes: ipv6ToBytes(host) };
  }
  const name = Buffer.from(host, 'utf8');
  if (name.length > 255) {
    throw new SocksError(`CONNECT target hostname longer than 255 bytes: ${host}`);
  }
  return { atyp: ATYP_DOMAIN, bytes: Buffer.concat([Buffer.from([name.length]), name]) };
}

/** Expand an IPv6 literal into 16 bytes ('::' compression supported). */
function ipv6ToBytes(host: string): Buffer {
  const halves = host.split('::');
  if (halves.length > 2) throw new SocksError(`invalid IPv6 literal: ${host}`);
  const head = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) {
    throw new SocksError(`invalid IPv6 literal: ${host}`);
  }
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail];
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16), i * 2));
  return out;
}

/**
 * Open a SOCKS5 tunnel through `cfg` to `destHost:destPort` and resolve with
 * the raw tunnel socket once the proxy reports success.
 */
export async function socksConnect(
  cfg: ProxyConfig,
  destHost: string,
  destPort: number,
  timeoutMs: number = DEFAULT_TUNNEL_TIMEOUT_MS,
): Promise<Socket> {
  const socket = await connectTcp(cfg.host, cfg.port, timeoutMs);
  let reader: ByteReader | null = new ByteReader(socket);
  const watchdog = setTimeout(() => {
    socket.destroy(
      new Error(`[proxy] SOCKS5 handshake with ${cfg.host}:${cfg.port} timed out after ${timeoutMs}ms`),
    );
  }, timeoutMs);
  try {
    const r = reader;
    const wantUserPass = cfg.username != null || cfg.password != null;
    const methods = wantUserPass ? [METHOD_NONE, METHOD_USERPASS] : [METHOD_NONE];
    socket.write(Buffer.from([SOCKS_VERSION, methods.length, ...methods]));

    const greeting = await r.read(2);
    if (greeting[0] !== SOCKS_VERSION) {
      throw new SocksError(`unexpected SOCKS version byte 0x${greeting[0].toString(16)}`);
    }
    const chosen = greeting[1];
    if (chosen === METHOD_NO_ACCEPTABLE) {
      throw new SocksError('SOCKS5 proxy accepted none of our auth methods', METHOD_NO_ACCEPTABLE);
    }
    if (chosen === METHOD_USERPASS) {
      if (!wantUserPass) {
        throw new SocksError('SOCKS5 proxy demands user/pass auth but no credentials configured', METHOD_USERPASS);
      }
      const user = Buffer.from(cfg.username ?? '', 'utf8');
      const pass = Buffer.from(cfg.password ?? '', 'utf8');
      if (user.length > 255 || pass.length > 255) {
        throw new SocksError('SOCKS5 username/password longer than 255 bytes');
      }
      socket.write(
        Buffer.concat([
          Buffer.from([0x01, user.length]),
          user,
          Buffer.from([pass.length]),
          pass,
        ]),
      );
      const authReply = await r.read(2);
      if (authReply[0] !== 0x01) {
        throw new SocksError(`unexpected auth version byte 0x${authReply[0].toString(16)}`);
      }
      if (authReply[1] !== 0x00) {
        throw new SocksError('SOCKS5 username/password authentication failed', authReply[1]);
      }
    } else if (chosen !== METHOD_NONE) {
      throw new SocksError(`SOCKS5 proxy selected unsupported auth method 0x${chosen.toString(16)}`);
    }

    const addr = encodeAddress(destHost);
    socket.write(
      Buffer.concat([
        Buffer.from([SOCKS_VERSION, CMD_CONNECT, 0x00, addr.atyp]),
        addr.bytes,
        Buffer.from([(destPort >> 8) & 0xff, destPort & 0xff]),
      ]),
    );

    const head = await r.read(4);
    if (head[0] !== SOCKS_VERSION) {
      throw new SocksError(`unexpected SOCKS version in CONNECT reply: 0x${head[0].toString(16)}`);
    }
    const rep = head[1];
    if (rep !== 0x00) {
      throw new SocksError(
        `SOCKS5 CONNECT failed: ${REPLY_MESSAGES[rep] ?? `reply code ${rep}`}`,
        rep,
      );
    }
    // Consume BND.ADDR + BND.PORT so nothing protocol-related is left buffered.
    const bndAtyp = head[3];
    if (bndAtyp === ATYP_IPV4) await r.read(6);
    else if (bndAtyp === ATYP_IPV6) await r.read(18);
    else if (bndAtyp === ATYP_DOMAIN) {
      const len = (await r.read(1))[0];
      await r.read(len + 2);
    } else {
      throw new SocksError(`unknown BND.ADDR address type 0x${bndAtyp.toString(16)}`);
    }

    const rest = r.leftover();
    if (rest.length > 0) socket.unshift(rest); // re-queue any early payload bytes
    r.release();
    reader = null;
    return socket;
  } catch (e) {
    reader?.release();
    socket.destroy();
    throw e;
  } finally {
    clearTimeout(watchdog);
  }
}
