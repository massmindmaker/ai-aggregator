/**
 * Tests for the egress proxy core (T1):
 *   - url normalization table
 *   - SOCKS5 handshake against an in-test mock RFC1928 server
 *   - HTTP CONNECT against an in-test mock TCP server
 *   - raw HTTP execution over the tunnel (fetchViaProxy)
 *   - safeFetch({egressProxyUrl}) hook wiring + guard preservation
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import type { Socket } from 'node:net';
import { extractExplicitPort, normalizeProxyUrl } from '../proxy/url';
import type { ProxyConfig } from '../proxy/url';
import { parseProxyUrl, tunneledSocket, fetchViaProxy, TimeoutError } from '../proxy/index';
import { httpConnect } from '../proxy/httpConnect';
// Relative source import (not '@aiag/shared/server') so the hook tests always
// exercise the CURRENT safeFetch source rather than a possibly stale dist.
import {
  registerEgressExecutor,
  unregisterEgressExecutor,
  safeFetch,
  SsrfError,
} from '../../../shared/src/safe-fetch';

/* ------------------------------- helpers -------------------------------- */

function readAllUntilClose(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let acc = '';
    socket.on('data', (c: Buffer) => {
      acc += c.toString('utf8');
    });
    socket.on('close', () => resolve(acc));
    socket.on('error', reject);
  });
}

interface SocksMockOptions {
  requireUser?: string;
  requirePass?: string;
  rejectAll?: boolean;
  /** When set, answer CONNECT with this RFC1928 reply code instead of success. */
  connectReplyCode?: number;
  /** Accept the HTTP request but NEVER answer, keeping the tunnel socket open. */
  silentAfterConnect?: boolean;
}

interface SocksMockHandle {
  port: number;
  server: net.Server;
  targets: Array<{ host: string; port: number }>;
  authAttempts: Array<{ user: string; pass: string; ok: boolean }>;
}

/** Minimal RFC1928 server: greeting → [userpass] → CONNECT → relay "hello". */
async function startSocksMock(opts: SocksMockOptions = {}): Promise<SocksMockHandle> {
  const handle: SocksMockHandle = {
    port: 0,
    server: null as unknown as net.Server,
    targets: [],
    authAttempts: [],
  };
  handle.server = net.createServer((client) => {
    let stage: 'greeting' | 'auth' | 'connect' | 'relay' = 'greeting';
    let buf = Buffer.alloc(0);
    let relayed = false;
    client.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (stage === 'greeting') {
          if (buf.length < 2) return;
          const nMethods = buf[1];
          if (buf.length < 2 + nMethods) return;
          const methods = [...buf.subarray(2, 2 + nMethods)];
          buf = buf.subarray(2 + nMethods);
          if (opts.rejectAll) {
            client.write(Buffer.from([0x05, 0xff]));
            client.end();
            return;
          }
          if (opts.requireUser !== undefined) {
            if (!methods.includes(0x02)) {
              client.write(Buffer.from([0x05, 0xff]));
              client.end();
              return;
            }
            client.write(Buffer.from([0x05, 0x02]));
            stage = 'auth';
          } else {
            client.write(Buffer.from([0x05, 0x00]));
            stage = 'connect';
          }
        } else if (stage === 'auth') {
          if (buf.length < 2) return;
          const ulen = buf[1];
          if (buf.length < 2 + ulen + 1) return;
          const plen = buf[2 + ulen];
          if (buf.length < 3 + ulen + plen) return;
          const user = buf.subarray(2, 2 + ulen).toString('utf8');
          const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString('utf8');
          buf = buf.subarray(3 + ulen + plen);
          const ok = user === opts.requireUser && pass === opts.requirePass;
          handle.authAttempts.push({ user, pass, ok });
          client.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
          if (!ok) {
            client.end();
            return;
          }
          stage = 'connect';
        } else if (stage === 'connect') {
          if (buf.length < 5) return;
          const atyp = buf[3];
          const addrStart = atyp === 0x03 ? 5 : 4;
          const addrLen = atyp === 0x03 ? buf[4] : atyp === 0x01 ? 4 : 16;
          const total = addrStart + addrLen + 2;
          if (buf.length < total) return;
          let host: string;
          if (atyp === 0x01) host = [...buf.subarray(4, 8)].join('.');
          else if (atyp === 0x03) host = buf.subarray(addrStart, addrStart + addrLen).toString();
          else host = 'ipv6';
          const port = buf.readUInt16BE(addrStart + addrLen);
          buf = buf.subarray(total);
          handle.targets.push({ host, port });
          if (opts.connectReplyCode !== undefined) {
            client.write(
              Buffer.from([0x05, opts.connectReplyCode, 0x00, 0x01, 127, 0, 0, 1, 0x00, 0x50]),
            );
            client.end();
            return;
          }
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x00, 0x50]));
          stage = 'relay';
        } else {
          // relay: answer any request with a fixed HTTP response
          if (buf.length === 0 || relayed) {
            buf = Buffer.alloc(0);
            return;
          }
          relayed = true;
          buf = Buffer.alloc(0);
          if (opts.silentAfterConnect) return; // hung upstream: socket stays open, no bytes ever
          client.write(
            Buffer.from(
              'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello',
              'utf8',
            ),
          );
        }
      }
    });
  });
  await new Promise<void>((resolve) => {
    handle.server.listen(0, '127.0.0.1', () => resolve());
  });
  handle.port = (handle.server.address() as net.AddressInfo).port;
  return handle;
}

interface HttpMockHandle {
  port: number;
  server: net.Server;
  connects: string[];
}

/** Minimal HTTP CONNECT proxy: validate request line, answer, relay "hello". */
async function startHttpMock(statusLine = 'HTTP/1.1 200 Connection established'): Promise<HttpMockHandle> {
  const handle: HttpMockHandle = {
    port: 0,
    server: null as unknown as net.Server,
    connects: [],
  };
  handle.server = net.createServer((client) => {
    let buf = Buffer.alloc(0);
    let connected = false;
    let relayed = false;
    client.on('data', (chunk: Buffer) => {
      if (connected && !relayed) {
        relayed = true;
        client.write(
          Buffer.from(
            'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello',
            'utf8',
          ),
        );
        client.end();
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const headText = buf.subarray(0, idx).toString('utf8');
      buf = Buffer.alloc(0);
      const m = /^CONNECT (\S+) HTTP\/1\.[01]$/m.exec(headText);
      if (!m) {
        client.end();
        return;
      }
      handle.connects.push(m[1]);
      client.write(Buffer.from(`${statusLine}\r\n\r\n`, 'utf8'));
      if (!statusLine.startsWith('HTTP/1.1 2')) client.end();
      else connected = true;
    });
  });
  await new Promise<void>((resolve) => {
    handle.server.listen(0, '127.0.0.1', () => resolve());
  });
  handle.port = (handle.server.address() as net.AddressInfo).port;
  return handle;
}

const openHandles: Array<net.Server> = [];
async function socks(opts?: SocksMockOptions): Promise<SocksMockHandle> {
  const h = await startSocksMock(opts);
  openHandles.push(h.server);
  return h;
}
async function httpProxy(line?: string): Promise<HttpMockHandle> {
  const h = await startHttpMock(line);
  openHandles.push(h.server);
  return h;
}

afterAll(() => {
  for (const s of openHandles) s.close();
  unregisterEgressExecutor();
});

/* ------------------------------ url.ts ---------------------------------- */

describe('normalizeProxyUrl', () => {
  it.each([
    ['socks5://u:p@10.0.0.1:9050', 'socks5://u:p@10.0.0.1:9050'], // explicit port + creds kept
    ['http://proxy.example', 'http://proxy.example:8080'], // default http proxy port 8080
    ['https://proxy.example', 'https://proxy.example:443'],
    ['socks5://relay.example', 'socks5://relay.example:1080'],
    ['http://proxy.example:80', 'http://proxy.example:80'], // explicit default port survives
    ['https://proxy.example:443', 'https://proxy.example:443'], // explicit default port survives
    ['socks5://user:p%40ss@h:1080', 'socks5://user:p%40ss@h:1080'], // encoded creds untouched
    ['socks5://host:99999', null], // out-of-range port → invalid port error
    ['ftp://proxy.example', null], // unsupported scheme
    ['::::', null], // unparsable
    ['socks5://', null], // missing host (WHATWG tolerates http:///x → host=x)
  ])('%s → %s', (input, expected) => {
    if (expected === null) {
      expect(() => normalizeProxyUrl(input)).toThrow();
    } else {
      expect(normalizeProxyUrl(input)).toBe(expected);
    }
  });

  it('extractExplicitPort picks the authority port, ignoring defaults stripped by URL', () => {
    expect(extractExplicitPort('socks5://a.b:9050')).toBe('9050');
    expect(extractExplicitPort('http://u:v@a.b:80/path')).toBe('80');
    expect(extractExplicitPort('socks5://a.b')).toBe(null);
    expect(extractExplicitPort('no-scheme')).toBe(null);
  });
});

describe('parseProxyUrl', () => {
  it('parses scheme/host/port and decodes credentials', () => {
    const cfg: ProxyConfig = parseProxyUrl('socks5://alice:s%40cret@10.1.2.3:9050');
    expect(cfg.protocol).toBe('socks5');
    expect(cfg.host).toBe('10.1.2.3');
    expect(cfg.port).toBe(9050);
    expect(cfg.username).toBe('alice');
    expect(cfg.password).toBe('s@cret');
  });

  it('applies default ports per scheme', () => {
    expect(parseProxyUrl('http://h')!.port).toBe(8080);
    expect(parseProxyUrl('socks5://h')!.port).toBe(1080);
  });

  it('tunneledSocket refuses https:// proxies explicitly', async () => {
    await expect(tunneledSocket('https://p.example:8443', 'h', 80)).rejects.toThrow(
      /not supported/i,
    );
  });
});

/* ------------------------------ socks.ts -------------------------------- */

describe('SOCKS5 tunnel (mock RFC1928 server)', () => {
  it('no-auth handshake + CONNECT reaches the relayed origin', async () => {
    const m = await socks();
    const res = await fetchViaProxy('http://destination.test/hello', {}, `socks5://127.0.0.1:${m.port}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
    expect(m.targets).toEqual([{ host: 'destination.test', port: 80 }]);
  });

  it('userpass auth succeeds with correct credentials', async () => {
    const m = await socks({ requireUser: 'alice', requirePass: 's3cret' });
    const res = await fetchViaProxy(
      'http://destination.test/hello',
      {},
      `socks5://alice:s3cret@127.0.0.1:${m.port}`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
    expect(m.authAttempts[0]).toEqual({ user: 'alice', pass: 's3cret', ok: true });
  });

  it('userpass auth failure throws', async () => {
    const m = await socks({ requireUser: 'alice', requirePass: 's3cret' });
    await expect(
      fetchViaProxy('http://destination.test/', {}, `socks5://alice:wrong@127.0.0.1:${m.port}`),
    ).rejects.toThrow(/authentication failed/i);
  });

  it('method negotiation refusal (0xFF) throws', async () => {
    const m = await socks({ rejectAll: true });
    await expect(
      fetchViaProxy('http://destination.test/', {}, `socks5://127.0.0.1:${m.port}`),
    ).rejects.toThrow(/none of our auth methods/i);
  });

  it('CONNECT refusal (reply 0x05 connection-refused) throws with protocol context', async () => {
    const m = await socks({ connectReplyCode: 5 });
    await expect(
      fetchViaProxy('http://destination.test/', {}, `socks5://127.0.0.1:${m.port}`),
    ).rejects.toThrow(/connection refused/i);
  });

  it('hung upstream (CONNECT ok, request accepted, then silence) trips the response read deadline', async () => {
    const m = await socks({ silentAfterConnect: true });
    const startedAt = Date.now();
    const err: unknown = await fetchViaProxy(
      'http://destination.test/hello',
      {},
      `socks5://127.0.0.1:${m.port}`,
      { responseIdleTimeoutMs: 200 },
    ).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toMatch(/read deadline/i);
    // The injected 200ms deadline drove the rejection — NOT the 15s default.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 10_000);
});

/* ---------------------------- httpConnect.ts ----------------------------- */

describe('HTTP CONNECT tunnel (mock TCP server)', () => {
  it('200 Connection established → relayed hello over the tunnel', async () => {
    const m = await httpProxy();
    const cfg = parseProxyUrl(`http://127.0.0.1:${m.port}`);
    const sock = await httpConnect(cfg, 'dest.test', 443);
    sock.write('GET / HTTP/1.1\r\nHost: dest.test\r\nConnection: close\r\n\r\n');
    const raw = await readAllUntilClose(sock);
    // Low-level socket view: full HTTP response arrives over the tunnel.
    expect(raw.startsWith('HTTP/1.1 200 OK')).toBe(true);
    expect(raw.endsWith('hello')).toBe(true);
    expect(m.connects).toEqual(['dest.test:443']);
  });

  it('non-2xx CONNECT response throws with status', async () => {
    const m = await httpProxy('HTTP/1.1 403 Forbidden');
    const cfg = parseProxyUrl(`http://127.0.0.1:${m.port}`);
    await expect(httpConnect(cfg, 'dest.test', 443)).rejects.toThrow(/403/);
  });

  it('fetchViaProxy end-to-end over an HTTP proxy', async () => {
    const m = await httpProxy();
    const res = await fetchViaProxy('http://destination.test/hello', {}, `http://127.0.0.1:${m.port}`);
    expect(await res.text()).toBe('hello');
    expect(m.connects).toEqual(['destination.test:80']);
  });
});

/* ------------------------- safeFetch integration -------------------------- */

describe('safeFetch({egressProxyUrl}) hook', () => {
  afterEach(() => {
    unregisterEgressExecutor();
  });

  it('routes a vetted allowlisted destination through the SOCKS tunnel', async () => {
    const m = await socks();
    registerEgressExecutor(fetchViaProxy);
    const res = await safeFetch('http://gateway.internal/hello', {
      allowlist: ['gateway.internal'],
      egressProxyUrl: `socks5://127.0.0.1:${m.port}`,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
    // Proves the traffic actually went THROUGH the proxy...
    expect(m.targets).toEqual([{ host: 'gateway.internal', port: 80 }]);
  });

  it('SSRF guards still run BEFORE tunneling (blocked destination never reaches proxy)', async () => {
    const m = await socks();
    registerEgressExecutor(fetchViaProxy);
    await expect(
      safeFetch('http://169.254.169.254/latest/meta-data/', {
        egressProxyUrl: `socks5://127.0.0.1:${m.port}`,
      }),
    ).rejects.toBeInstanceOf(SsrfError);
    expect(m.targets).toEqual([]); // proxy never saw a CONNECT
  });

  it('egressProxyUrl without a registered executor fails loudly', async () => {
    await expect(
      safeFetch('http://gateway.internal/hello', {
        allowlist: ['gateway.internal'],
        egressProxyUrl: 'socks5://127.0.0.1:1080',
      }),
    ).rejects.toThrow(/no egress executor is registered/i);
  });
});
