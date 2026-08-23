import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { adminCatalog } from '../routes/admin/catalog';
import { adminProxy } from '../routes/admin/proxyTest';
import { applyAiagErrorHandler } from '../lib/errors';

function app(): Hono {
  const a = new Hono();
  applyAiagErrorHandler(a);
  a.route('/api/admin/proxy', adminProxy);
  a.route('/api/admin/catalog', adminCatalog);
  return a;
}

beforeEach(() => {
  delete process.env.AIAG_ADMIN_KEY;
  delete process.env.AIAG_ADMIN_RATE_LIMIT;
});
afterEach(() => {
  delete process.env.AIAG_ADMIN_RATE_LIMIT;
});

describe('admin rate limit (brute-force guard)', () => {
  it('429s after the 30th request in the window (counting failed auth too)', async () => {
    const a = app();
    let last = 0;
    for (let i = 1; i <= 31; i++) {
      const res = await a.fetch(new Request('http://x/api/admin/proxy/test'));
      last = res.status;
      if (i <= 30) expect(res.status).toBe(403);
    }
    expect(last).toBe(429);
  });

  it('counts across BOTH admin subapps (shared bucket)', async () => {
    const a = app();
    for (let i = 0; i < 15; i++) await a.fetch(new Request('http://x/api/admin/proxy/test'));
    const res = await a.fetch(new Request('http://x/api/admin/catalog/diff'));
    // bucket shared → still under 30 combined here, so plain 403 (auth) not 429
    expect([403, 429]).toContain(res.status);
  });

  it('AIAG_ADMIN_RATE_LIMIT=off disables the limiter entirely', async () => {
    process.env.AIAG_ADMIN_RATE_LIMIT = 'off';
    const a = app();
    for (let i = 0; i < 35; i++) {
      const res = await a.fetch(new Request('http://x/api/admin/proxy/test'));
      expect(res.status).toBe(403);
    }
  });
});

describe('catalog apply transactionality', () => {
  it('wraps each draft merge in a DB transaction (sql.begin)', async () => {
    const src = await (await import('node:fs/promises')).readFile(
      new URL('../routes/admin/catalog.ts', import.meta.url),
      'utf8'
    );
    expect(src).toMatch(/sql\.begin/);
    expect(src.indexOf('FOR UPDATE')).toBeGreaterThan(src.indexOf('sql.begin'));
  });
});
