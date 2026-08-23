/**
 * Tests for egress configuration (T2 of the native egress integration plan):
 *   - resolveEgressProxy precedence (upstream column > env > direct)
 *   - fetchUpstream wiring (proxy actually reaches the executor; SSRF guards
 *     still run against the destination before tunneling)
 *   - GET /api/admin/proxy/test guard (fail-closed) + happy-path echo
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  registerEgressExecutor,
  unregisterEgressExecutor,
  SsrfError,
} from '@aiag/shared/server';
import { fetchUpstream, resolveEgressProxy } from '../upstreams/fetch-upstream';
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

describe('fetchUpstream egress wiring', () => {
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

/* ------------------------- admin proxy test route -------------------------- */

/** Mini-app mirroring the server.ts mount (hermetic — no middleware stack). */
function mini(): Hono {
  const app = new Hono();
  applyAiagErrorHandler(app); // same AiagError→response mapping as server.ts
  app.route('/api/admin/proxy', adminProxy);
  return app;
}

describe('GET /api/admin/proxy/test guard', () => {
  it.each([
    ['no auth header at all', undefined, undefined],
    ['wrong bearer key', 'Bearer wrong-key', undefined],
    ['key presented but AIAG_ADMIN_KEY unset', 'Bearer k', undefined],
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

describe('server.ts mount smoke', () => {
  it('GET /api/admin/proxy/test on the REAL app → guarded 403 without a key', async () => {
    delete process.env.AIAG_ADMIN_KEY;
    const { app } = await import('../server');
    const res = await app.fetch(new Request('http://x/api/admin/proxy/test'));
    expect(res.status).toBe(403);
  }, 20_000);
});
