/**
 * Tests for /api/admin/routing — auth, validation, idempotency.
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
import { POST as createRoute, GET as listRoutes } from '@/app/api/admin/routing/route';
import { PATCH as patchRoute, DELETE as delRoute } from '@/app/api/admin/routing/[id]/route';

function withAdmin() {
  (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { email: 'a@x' } });
  userFindFirst.mockResolvedValue({ email: 'a@x', role: 'admin' });
}

function jsonReq(body: unknown) {
  return { json: async () => body } as unknown as Request;
}

describe('/api/admin/routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('list rejects non-admin', async () => {
    (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const r = await listRoutes({} as never);
    expect((r as Response).status).toBe(401);
  });

  it('POST validates required fields', async () => {
    withAdmin();
    const r = await createRoute(jsonReq({ model_id: '', upstream_id: '', upstream_model_id: '' }) as never);
    expect((r as Response).status).toBe(400);
  });

  it('POST refuses duplicates', async () => {
    withAdmin();
    dbExecute.mockResolvedValueOnce({ rows: [{ id: 'existing' }] });
    const r = await createRoute(
      jsonReq({
        model_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        upstream_id: 'openrouter',
        upstream_model_id: 'openai/gpt-5',
        markup: 1.25,
      }) as never
    );
    expect((r as Response).status).toBe(409);
  });

  it('POST inserts and audits new route', async () => {
    withAdmin();
    dbExecute
      .mockResolvedValueOnce({ rows: [] }) // dup check
      .mockResolvedValueOnce({ rows: [{ id: 'new-id' }] }) // insert
      .mockResolvedValueOnce({ rows: [] }); // audit
    const r = await createRoute(
      jsonReq({
        model_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        upstream_id: 'fal',
        upstream_model_id: 'fal-ai/x',
        markup: 1.5,
      }) as never
    );
    const j = await (r as Response).json();
    expect(j.ok).toBe(true);
    expect(j.id).toBe('new-id');
  });

  it('PATCH toggle is idempotent (404 when missing)', async () => {
    withAdmin();
    dbExecute.mockResolvedValueOnce({ rows: [] });
    const r = await patchRoute(jsonReq({ op: 'toggle', enabled: false }) as never, {
      params: Promise.resolve({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }),
    });
    expect((r as Response).status).toBe(404);
  });

  it('PATCH setMarkup rejects bad markup', async () => {
    withAdmin();
    const r = await patchRoute(jsonReq({ op: 'setMarkup', markup: -1 }) as never, {
      params: Promise.resolve({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }),
    });
    expect((r as Response).status).toBe(400);
  });

  it('DELETE returns 404 when missing', async () => {
    withAdmin();
    dbExecute.mockResolvedValueOnce({ rows: [] });
    const r = await delRoute({} as never, {
      params: Promise.resolve({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }),
    });
    expect((r as Response).status).toBe(404);
  });
});
