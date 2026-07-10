/**
 * Tests for /api/admin/routing/[id]/test — auth + 404.
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
  eq: (a: unknown, b: unknown) => ({ a, b }),
  sql: (s: TemplateStringsArray) => ({ raw: s.raw.join(' ') }),
}));

import { auth } from '@/auth';
import { POST as testRoute } from '@/app/api/admin/routing/[id]/test/route';

describe('/api/admin/routing/[id]/test', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when unauthenticated', async () => {
    (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const r = await testRoute({} as never, {
      params: Promise.resolve({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }),
    });
    expect((r as Response).status).toBe(401);
  });

  it('returns 404 when route missing', async () => {
    (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { email: 'a@x' } });
    userFindFirst.mockResolvedValue({ email: 'a@x', role: 'admin' });
    dbExecute.mockResolvedValueOnce({ rows: [] });
    const r = await testRoute({} as never, {
      params: Promise.resolve({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }),
    });
    expect((r as Response).status).toBe(404);
  });

  it('returns no-base-url message when base_url is null', async () => {
    (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { email: 'a@x' } });
    userFindFirst.mockResolvedValue({ email: 'a@x', role: 'admin' });
    dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'r1',
            model_slug: 'm',
            modality: 'text',
            upstream_id: 'u',
            base_url: null,
            upstream_model_id: 'x',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // audit
    const r = await testRoute({} as never, {
      params: Promise.resolve({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }),
    });
    const j = await (r as Response).json();
    expect(j.ok).toBe(false);
    expect(j.error).toMatch(/no base_url/);
  });
});
