/**
 * GET /api/admin/proxy/test — admin-only egress diagnostics (T2 of the
 * native egress integration plan).
 *
 * Asks the gateway to fetch a URL through a given egress proxy (or directly
 * when `proxy` is empty) and echoes back what it saw — the standard
 * "which IP am I leaving from" check (default url = api.ipify.org).
 *
 * Guard: static admin key. The gateway is a separate process from apps/web
 * (no NextAuth session store here), so the guard is a shared-secret bearer
 * token in AIAG_ADMIN_KEY, compared timing-safes. FAILS CLOSED: with the env
 * unset every request gets 403 (endpoint disabled until ops configures it).
 * This mirrors the intent of apps/web's requireAdmin() (deny-by-default,
 * audit-friendly) adapted to a headless service.
 *
 * SSRF posture: the destination goes through safeFetch like every other
 * outbound call — HTTPS-only + IP-range blocklist still apply; the admin can
 * NOT probe internal infrastructure through this endpoint. Only the
 * programmatic allowlist seam (tests) bypasses that, never HTTP input.
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { adminRateLimit } from './rate-limit';
import { timingSafeEqual } from 'node:crypto';
import { errors } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { safeFetch } from '@aiag/shared/server';

const DEFAULT_TEST_URL = 'https://api.ipify.org/?format=json';
const MAX_BODY_CHARS = 500;

export type ProxyTestResult = {
  /** Which path the request actually took (mirrors the requested mode). */
  via: 'proxy' | 'direct';
  status: number;
  /** Response body, truncated to MAX_BODY_CHARS. */
  body: string;
};

export async function runProxyTest(opts: {
  proxyUrl?: string;
  url?: string;
  /**
   * Test seam ONLY — lets unit tests point at in-process mock servers.
   * Never wired from HTTP query input (would reopen the D-7 SSRF hole).
   */
  allowlist?: string[];
}): Promise<ProxyTestResult> {
  const via: ProxyTestResult['via'] = opts.proxyUrl ? 'proxy' : 'direct';
  const res = await safeFetch(opts.url ?? DEFAULT_TEST_URL, {
    method: 'GET',
    headers: { accept: 'application/json' },
    ...(opts.allowlist ? { allowlist: opts.allowlist } : {}),
    ...(opts.proxyUrl ? { egressProxyUrl: opts.proxyUrl } : {}),
  });
  const text = (await res.text().catch(() => '')).slice(0, MAX_BODY_CHARS);
  return { via, status: res.status, body: text };
}

/** Test seam: replace runProxyTest entirely (same pattern as resolver.ts). */
let override: typeof runProxyTest | null = null;
export function setRunProxyTestOverride(fn: typeof runProxyTest | null): void {
  override = fn;
}

function presentedKey(c: { req: { header: (name: string) => string | undefined } }): string | undefined {
  const auth = c.req.header('authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  return c.req.header('x-admin-key')?.trim() || undefined;
}

/**
 * Admin guard for gateway routes: AIAG_ADMIN_KEY shared secret via
 * `Authorization: Bearer …` or `x-admin-key`. 403 on missing key, wrong key,
 * OR unconfigured env (fail closed).
 */
export const requireAdminKey: MiddlewareHandler = async (c, next) => {
  const expected = process.env.AIAG_ADMIN_KEY;
  const presented = presentedKey(c);
  const ok =
    !!expected &&
    !!presented &&
    (() => {
      const a = Buffer.from(presented);
      const b = Buffer.from(expected);
      return a.length === b.length && timingSafeEqual(a, b);
    })();
  if (!ok) throw errors.forbidden('Admin key required');
  await next();
};

export const adminProxy = new Hono();

adminProxy.use('/test', adminRateLimit());
adminProxy.use('/test', requireAdminKey);

adminProxy.get('/test', async (c) => {
  const proxy = c.req.query('proxy')?.trim() ?? '';
  const url = c.req.query('url')?.trim() || DEFAULT_TEST_URL;
  try {
    const result = override
      ? await override({ proxyUrl: proxy || undefined, url })
      : await runProxyTest({ proxyUrl: proxy || undefined, url });
    logger.info(
      { via: result.via, status: result.status },
      'admin_proxy_test_ok'
    );
    return c.json(result);
  } catch (e) {
    // Admin-facing diagnostics: the failure reason IS the payload's purpose.
    logger.warn({ err: String(e) }, 'admin_proxy_test_fail');
    throw errors.badRequest(`proxy test failed: ${(e as Error).message}`);
  }
});
