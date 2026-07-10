/**
 * Tests for /api/admin/settings GET + PATCH.
 * Verifies guard enforcement and JSONB upsert pattern.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn() }));
vi.mock('next/headers', () => ({
  headers: () => ({ get: () => null }),
  cookies: () => ({ get: () => ({ value: 'ok' }) }),
}));
vi.mock('@/lib/admin/session', () => ({
  ADMIN_COOKIE_NAME: 'aiag_admin_session',
  verifyAdminSession: async () => true,
}));

const dbExecute = vi.fn();
const userFindFirst = vi.fn();
vi.mock('@/lib/db', () => ({
  db: {
    query: { users: { findFirst: (...a: unknown[]) => userFindFirst(...a) } },
    execute: (...a: unknown[]) => dbExecute(...a),
  },
  eq: () => ({}),
  sql: (s: TemplateStringsArray, ..._v: unknown[]) => ({ raw: s.raw.join('?') }),
}));

import { auth } from '@/auth';
import { GET, PATCH } from '@/app/api/admin/settings/route';

function asAdmin() {
  (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    user: { email: 'admin@test' },
  });
  userFindFirst.mockResolvedValue({ email: 'admin@test', role: 'admin' });
}
function asAnon() {
  (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
}

describe('settings API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET returns 401 when unauthenticated', async () => {
    asAnon();
    const r = await GET(new Request('http://x/api/admin/settings') as never);
    expect(r.status).toBe(401);
  });

  it('GET returns 403 when role != admin', async () => {
    (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { email: 'u@t' } });
    userFindFirst.mockResolvedValue({ email: 'u@t', role: 'user' });
    const r = await GET(new Request('http://x/api/admin/settings') as never);
    expect(r.status).toBe(403);
  });

  it('GET returns settings as object keyed by key', async () => {
    asAdmin();
    dbExecute.mockResolvedValue({
      rows: [
        { key: 'fx_usd_rub', value: '"100"' },
        { key: 'maintenance_mode', value: false },
      ],
    });
    const r = await GET(new Request('http://x/api/admin/settings') as never);
    expect(r.status).toBe(200);
    const j = await (r as Response).json();
    expect(j.fx_usd_rub).toBe('"100"');
  });

  it('PATCH upserts each setting key + writes audit', async () => {
    asAdmin();
    dbExecute.mockResolvedValue({ rows: [] });
    const req = new Request('http://x/api/admin/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fx_usd_rub: '102', maintenance_mode: true }),
    });
    const r = await PATCH(req as never);
    expect(r.status).toBe(200);
    // 2 upserts + 1 audit
    expect(dbExecute).toHaveBeenCalledTimes(3);
  });
});
