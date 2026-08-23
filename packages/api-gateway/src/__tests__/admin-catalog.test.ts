import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { adminCatalog } from '../routes/admin/catalog';
import { applyAiagErrorHandler } from '../lib/errors';

describe('GET /api/admin/catalog/* guard', () => {
  it('403 without AIAG_ADMIN_KEY (fail-closed)', async () => {
    delete process.env.AIAG_ADMIN_KEY;
    const app = new Hono();
    applyAiagErrorHandler(app);
    app.route('/api/admin/catalog', adminCatalog);
    const res = await app.fetch(new Request('http://x/api/admin/catalog/diff'));
    expect(res.status).toBe(403);
    const res2 = await app.fetch(
      new Request('http://x/api/admin/catalog/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: ['x'] }),
      })
    );
    expect(res2.status).toBe(403);
  });
});
