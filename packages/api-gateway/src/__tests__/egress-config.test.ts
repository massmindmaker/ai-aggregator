/**
 * Tests for egress configuration (T2 of the native egress integration plan):
 *   - resolveEgressProxy precedence (upstream column > env > direct)
 *   - fetchUpstream wiring (proxy actually reaches the executor; SSRF guards
 *     still run against the destination before tunneling)
 *   - GET /api/admin/proxy/test guard (fail-closed) + happy-path echo
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import net from 'node:net';
import { registerGatewayEgressExecutor } from '../egress-executor';
import {
  registerEgressExecutor,
  unregisterEgressExecutor,
  SsrfError,
} from '@aiag/shared/server';
import { fetchUpstream, resolveEgressProxy, StreamNotSupportedError } from '../upstreams/fetch-upstream';
import { adminProxy, setRunProxyTestOverride } from '../routes/admin/proxyTest';
import { applyAiagErrorHandler } from '../lib/errors';

/* --------------------------- env save/restore ----------------------------- */

const ENV_KEYS = ['AIAG_EGRESS_PROXY_URL', 'AIAG_ADMIN_KEY'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  setRunProxyTestOverride(null);
});

/* ------------------------ resolveEgressProxy precedence -------------------- */

beforeEach(() => {
  process.env.AIAG_ADMIN_RATE_LIMIT = 'off'; // isolation: other files own the RL tests
});
afterEach(() => {
  delete process.env.AIAG_ADMIN_RATE_LIMIT;
});

describe('resolveEgressProxy precedence', () => {
  it('upstream column wins over the env param', () => {
    const r = resolveEgressProxy('socks5://col:1080', 'socks5://env:1080');
    expect(r).toEqual({ proxyUrl: 'socks5://col:1080', source: 'upstream_column' });
  });

  it('upstream column wins over process.env', () => {
    process.env.AIAG_EGRESS_PROXY_URL = 'socks5://envhost:1080';
    expect(resolveEgressProxy('http://colhost:8080')).toEqual({
      proxyUrl: 'http://colhost:8080',
      source: 'upstream_column',
    });
  });

  it('null column + env param → env tier', () => {
    expect(resolveEgressProxy(null, 'socks5://env:1080')).toEqual({
      proxyUrl: 'socks5://env:1080',
      source: 'env',
    });
  });

  it('unset column + process.env → env tier', () => {
    process.env.AIAG_EGRESS_PROXY_URL = 'socks5://envhost:1080';
    expect(resolveEgressProxy(undefined)).toEqual({
      proxyUrl: 'socks5://envhost:1080',
      source: 'env',
    });
  });

  it('explicit env param beats process.env', () => {
    process.env.AIAG_EGRESS_PROXY_URL = 'socks5://procenv:1';
    expect(resolveEgressProxy(undefined, 'socks5://param:2')).toEqual({
      proxyUrl: 'socks5://param:2',
      source: 'env',
    });
  });

  it('both unset → direct', () => {
    delete process.env.AIAG_EGRESS_PROXY_URL;
    expect(resolveEgressProxy(undefined)).toEqual({ proxyUrl: undefined, source: 'direct' });
  });

  it('whitespace-only column counts as unset and falls through to env', () => {
    expect(resolveEgressProxy('   ', 'socks5://env:1080')).toEqual({
      proxyUrl: 'socks5://env:1080',
      source: 'env',
    });
  });

  it('whitespace-only env counts as unset → direct', () => {
    expect(resolveEgressProxy(null, '  ')).toEqual({ proxyUrl: undefined, source: 'direct' });
  });
});

/* -------------------------- fetchUpstream wiring --------------------------- */

type ExecutorCall = { url: string; proxyUrl: string };
const calls: ExecutorCall[] = [];
let proxiedResponse: Response;

beforeEach(() => {
  calls.length = 0;
  proxiedResponse = new Response('tunneled-body', { status: 201 });
  registerEgressExecutor(async (url, _init, proxyUrl) => {
    calls.push({ url, proxyUrl });
    return proxiedResponse;
  });
});
afterEach(() => {
  unregisterEgressExecutor();
});

beforeEach(() => {
  process.env.AIAG_ADMIN_RATE_LIMIT = 'off'; // isolation: other files own the RL tests
});
afterEach(() => {
  delete process.env.AIAG_ADMIN_RATE_LIMIT;
});

describe('fetchUpstream egress wiring', () => {
  it.each([
    ['content-length exact boundary', 'Content-Length: 16\r\n', 'x'.repeat(16), true],
    ['oversized declared length before body', 'Content-Length: 17\r\n', '', false],
    ['close-delimited overflow', '', 'x'.repeat(17), false],
    ['completed chunked overflow', 'Transfer-Encoding: chunked\r\n', '11\r\n' + 'x'.repeat(17) + '\r\n0\r\n\r\n', false],
    ['chunked under wire cap', 'Transfer-Encoding: chunked\r\n', '1\r\nx\r\n0\r\n\r\n', true],
  ])('enforces the adapter cap through the real tunnel: %s', async (_name, headers, body, allowed) => {
    const sockets = new Set<net.Socket>();
    let connects = 0;
    const server = net.createServer(socket => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      let connected = false;
      let pending = '';
      socket.on('data', chunk => {
        pending += chunk.toString('latin1');
        if (!pending.includes('\r\n\r\n')) return;
        pending = '';
        if (!connected) {
          connected = true;
          connects++;
          socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
        } else {
          socket.end(`HTTP/1.1 200 OK\r\n${headers}\r\n${body}`);
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      registerGatewayEgressExecutor();
      const result = fetchUpstream('http://gateway.internal/v1', {
        allowlist: ['gateway.internal'], maxRedirects: 0, maxBufferedResponseBytes: 16,
      }, `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`);
      if (allowed) {
        const response = await result;
        expect(await response.text()).toBe(headers.includes('chunked') ? 'x' : body);
      } else {
        await expect(result).rejects.toThrow('response body exceeds configured buffer cap');
      }
      expect(connects).toBe(1);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('column proxy reaches the executor; response passes through', async () => {
    const res = await fetchUpstream(
      'http://gateway.internal/v1',
      { allowlist: ['gateway.internal'] },
      'socks5://col:1080'
    );
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('tunneled-body');
    expect(calls).toHaveLength(1);
    expect(calls[0].proxyUrl).toBe('socks5://col:1080');
  });

  it('falls back to AIAG_EGRESS_PROXY_URL when the column is unset', async () => {
    process.env.AIAG_EGRESS_PROXY_URL = 'http://fleet-proxy:3128';
    await fetchUpstream('http://gateway.internal/v1', { allowlist: ['gateway.internal'] });
    expect(calls[0]?.proxyUrl).toBe('http://fleet-proxy:3128');
  });

  it('direct path never touches the executor (real socket attempt fails fast)', async () => {
    delete process.env.AIAG_EGRESS_PROXY_URL;
    // Allowlisted loopback on a port that refuses connections — proves we did
    // NOT go through the mock executor while still failing hermetically.
    await expect(
      fetchUpstream('http://127.0.0.1:1/', { allowlist: ['127.0.0.1'] })
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('SSRF guards still vet the destination BEFORE tunneling', async () => {
    await expect(
      fetchUpstream('http://169.254.169.254/meta', {}, 'socks5://col:1080')
    ).rejects.toBeInstanceOf(SsrfError);
    expect(calls).toHaveLength(0); // blocked destination never reached the proxy
  });
});

/* ------------------------- SSE guard (review HIGH) ------------------------- */

beforeEach(() => {
  process.env.AIAG_ADMIN_RATE_LIMIT = 'off'; // isolation: other files own the RL tests
});
afterEach(() => {
  delete process.env.AIAG_ADMIN_RATE_LIMIT;
});

describe('fetchUpstream SSE guard (honest refusal on the proxy path)', () => {
  it('sse:true + resolved column proxy → typed STREAM_NOT_SUPPORTED, no tunnel', async () => {
    const err = await fetchUpstream(
      'http://gateway.internal/v1/chat',
      { allowlist: ['gateway.internal'], sse: true },
      'socks5://col:1080'
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StreamNotSupportedError);
    const aiag = err as InstanceType<typeof StreamNotSupportedError>;
    expect(aiag.code).toBe('STREAM_NOT_SUPPORTED');
    expect(aiag.status).toBe(400);
    // details must not leak credentials from the proxy URL
    expect(JSON.stringify(aiag.details ?? {})).not.toContain('socks5://col');
    expect(calls).toHaveLength(0); // executor never invoked
  });

  it('sse:true + env-tier proxy → same refusal', async () => {
    process.env.AIAG_EGRESS_PROXY_URL = 'http://fleet-proxy:3128';
    await expect(
      fetchUpstream('http://gateway.internal/v1/chat', { allowlist: ['gateway.internal'], sse: true })
    ).rejects.toBeInstanceOf(StreamNotSupportedError);
    expect(calls).toHaveLength(0);
  });

  it('sse:true + direct egress → real fetch path, streaming untouched', async () => {
    delete process.env.AIAG_EGRESS_PROXY_URL;
    // Hermetic: loopback refuse-port proves we took the DIRECT path (no
    // StreamNotSupportedError, no executor call).
    await expect(
      fetchUpstream('http://127.0.0.1:1/', { allowlist: ['127.0.0.1'], sse: true })
    ).rejects.not.toBeInstanceOf(StreamNotSupportedError);
    expect(calls).toHaveLength(0);
  });
});

/* ------------------------- admin proxy test route -------------------------- */

/** Mini-app mirroring the server.ts mount (hermetic — no middleware stack). */
function mini(): Hono {
  const app = new Hono();
  applyAiagErrorHandler(app); // same AiagError→response mapping as server.ts
  app.route('/api/admin/proxy', adminProxy);
  return app;
}

beforeEach(() => {
  process.env.AIAG_ADMIN_RATE_LIMIT = 'off'; // isolation: other files own the RL tests
});
afterEach(() => {
  delete process.env.AIAG_ADMIN_RATE_LIMIT;
});

describe('GET /api/admin/proxy/test guard', () => {
  it.each([
    ['no auth header at all', undefined, undefined],
    ['wrong bearer key', 'Bearer wrong-key', undefined],
    ['key presented but AIAG_ADMIN_KEY unset', 'Bearer k', undefined],
    ['wrong x-admin-key', undefined, 'wrong-key'],
  ])('%s → 403', async (_name, bearer, xKey) => {
    delete process.env.AIAG_ADMIN_KEY;
    const headers: Record<string, string> = {};
    if (bearer !== undefined && bearer !== null && bearer.length > 0) headers.authorization = bearer;
    if (xKey !== undefined && xKey.length > 0) headers['x-admin-key'] = xKey;
    const res = await mini().fetch(new Request('http://x/api/admin/proxy/test?url=https://a.b/', { headers }));
    expect(res.status).toBe(403);
  });

  it('fail-closed: correct-looking key is rejected when env is unset', async () => {
    delete process.env.AIAG_ADMIN_KEY;
    let touched = false;
    setRunProxyTestOverride(async () => {
      touched = true;
      throw new Error('must not run');
    });
    const res = await mini().fetch(
      new Request('http://x/api/admin/proxy/test', { headers: { authorization: 'Bearer anything' } })
    );
    expect(res.status).toBe(403);
    expect(touched).toBe(false);
  });

  it('happy path with Bearer key → echoes via/status/body from the runner', async () => {
    process.env.AIAG_ADMIN_KEY = 'sekrit';
    setRunProxyTestOverride(async (opts) => {
      expect(opts.url).toBe('https://echo.test/ip');
      expect(opts.proxyUrl).toBe('socks5://p:1080');
      return { via: 'proxy', status: 200, body: '{"ip":"203.0.113.7"}' };
    });
    const res = await mini().fetch(
      new Request(
        'http://x/api/admin/proxy/test?proxy=socks5%3A%2F%2Fp%3A1080&url=https%3A%2F%2Fecho.test%2Fip',
        { headers: { authorization: 'Bearer sekrit' } }
      )
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      via: 'proxy',
      status: 200,
      body: '{"ip":"203.0.113.7"}',
    });
  });

  it('x-admin-key header also authenticates; empty proxy → via: direct', async () => {
    process.env.AIAG_ADMIN_KEY = 'sekrit';
    setRunProxyTestOverride(async (opts) => {
      expect(opts.proxyUrl).toBeUndefined();
      return { via: 'direct', status: 200, body: '{}' };
    });
    const res = await mini().fetch(
      new Request('http://x/api/admin/proxy/test', { headers: { 'x-admin-key': 'sekrit' } })
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ via: 'direct', status: 200, body: '{}' });
  });

  it('runner failure surfaces as 400 with the reason', async () => {
    process.env.AIAG_ADMIN_KEY = 'sekrit';
    setRunProxyTestOverride(async () => {
      throw new Error('connect refused');
    });
    const res = await mini().fetch(
      new Request('http://x/api/admin/proxy/test', { headers: { authorization: 'Bearer sekrit' } })
    );
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error?: { message?: string } };
    expect(j.error?.message ?? '').toMatch(/connect refused/);
  });
});

/* ---------------- real-app mount smoke (path + guard wiring) --------------- */

beforeEach(() => {
  process.env.AIAG_ADMIN_RATE_LIMIT = 'off'; // isolation: other files own the RL tests
});
afterEach(() => {
  delete process.env.AIAG_ADMIN_RATE_LIMIT;
});

describe('server.ts mount smoke', () => {
  it('GET /api/admin/proxy/test on the REAL app → guarded 403 without a key', async () => {
    delete process.env.AIAG_ADMIN_KEY;
    const { app } = await import('../server');
    const res = await app.fetch(new Request('http://x/api/admin/proxy/test'));
    expect(res.status).toBe(403);
  }, 20_000);
});
