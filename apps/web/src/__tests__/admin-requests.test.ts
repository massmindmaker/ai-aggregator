/**
 * Tests for /api/admin/requests — auth + filters.
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
import { GET as listRequests } from '@/app/api/admin/requests/route';
import { GET as detailRequest } from '@/app/api/admin/requests/[id]/route';

function makeReq(url: string) {
  return {
    nextUrl: new URL(url),
  } as unknown as Parameters<typeof listRequests>[0];
}

describe('/api/admin/requests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects non-admin with 401', async () => {
    (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const r = await listRequests(makeReq('http://x/api/admin/requests'));
    // NextResponse exposes status via .status
    expect((r as Response).status).toBe(401);
  });

  it('returns 403 for non-admin user', async () => {
    (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { email: 'u@x' } });
    userFindFirst.mockResolvedValue({ email: 'u@x', role: 'user' });
    const r = await listRequests(makeReq('http://x/api/admin/requests'));
    expect((r as Response).status).toBe(403);
  });

  it('admin GET returns paginated list', async () => {
    (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: 'a@x' },
    });
    userFindFirst.mockResolvedValue({ email: 'a@x', role: 'admin' });
    dbExecute.mockResolvedValueOnce({ rows: [{ request_id: 'req_1' }] });
    const r = await listRequests(makeReq('http://x/api/admin/requests?page=2&status=success'));
    const json = await (r as Response).json();
    expect(json.page).toBe(2);
    expect(json.requests.length).toBe(1);
  });

  it('detail returns 404 when not found', async () => {
    (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: 'a@x' },
    });
    userFindFirst.mockResolvedValue({ email: 'a@x', role: 'admin' });
    dbExecute.mockResolvedValueOnce({ rows: [] });
    const r = await detailRequest({} as never, {
      params: Promise.resolve({ id: 'missing' }),
    });
    expect((r as Response).status).toBe(404);
  });

  it('detail masks authorization headers', async () => {
    (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: 'a@x' },
    });
    userFindFirst.mockResolvedValue({ email: 'a@x', role: 'admin' });
    dbExecute
      .mockResolvedValueOnce({ rows: [{ request_id: 'req_1', org_id: 'o-1' }] }) // request
      .mockResolvedValueOnce({
        rows: [{ headers: { Authorization: 'Bearer x', 'x-trace': 'ok' }, body: {} }],
      }) // response
      .mockResolvedValueOnce({ rows: [] }) // settle
      .mockResolvedValueOnce({ rows: [] }); // pii
    const r = await detailRequest({} as never, {
      params: Promise.resolve({ id: 'req_1' }),
    });
    const json = await (r as Response).json();
    expect(json.response.headers.Authorization).toBe('***');
    expect(json.response.headers['x-trace']).toBe('ok');
  });
});
