/**
 * Phase 13 — /api/promo/validate + /api/admin/promos integration tests.
 * Mocks the DB and auth.
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
import { POST as validatePOST } from '@/app/api/promo/validate/route';
import { POST as adminCreatePOST } from '@/app/api/admin/promos/route';

function asUser(id = 'u-1') {
  (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    user: { id, email: 'u@test' },
  });
}
function asAdmin() {
  (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    user: { email: 'admin@test' },
  });
  userFindFirst.mockResolvedValue({ email: 'admin@test', role: 'admin' });
}

describe('POST /api/promo/validate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects unauthenticated callers', async () => {
    (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const r = await validatePOST(
      new Request('http://x/api/promo/validate', {
        method: 'POST',
        body: JSON.stringify({ code: 'X', amountRub: 100 }),
      }) as never
    );
    expect(r.status).toBe(401);
  });

  it('rejects missing code or bad amount', async () => {
    asUser();
    const r1 = await validatePOST(
      new Request('http://x/api/promo/validate', {
        method: 'POST',
        body: JSON.stringify({}),
      }) as never
    );
    expect(r1.status).toBe(400);

    const r2 = await validatePOST(
      new Request('http://x/api/promo/validate', {
        method: 'POST',
        body: JSON.stringify({ code: 'X', amountRub: 0 }),
      }) as never
    );
    expect(r2.status).toBe(400);
  });

  it('returns 404 when promo missing', async () => {
    asUser();
    dbExecute.mockResolvedValue({ rows: [] });
    const r = await validatePOST(
      new Request('http://x/api/promo/validate', {
        method: 'POST',
        body: JSON.stringify({ code: 'NONE', amountRub: 1000 }),
      }) as never
    );
    expect(r.status).toBe(404);
  });

  it('returns discount preview for percent_off promo', async () => {
    asUser();
    dbExecute
      // fetch promo
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'p1',
            code: 'LAUNCH50',
            kind: 'percent_off',
            value: '50',
            min_amount_rub: null,
            max_uses: null,
            uses_count: 0,
            per_user_limit: 1,
            valid_from: null,
            valid_until: null,
            applies_to: 'topup',
            active: true,
          },
        ],
      })
      // user redemptions count
      .mockResolvedValueOnce({ rows: [{ c: 0 }] })
      // user has prior topups
      .mockResolvedValueOnce({ rows: [{ has: false }] });

    const r = await validatePOST(
      new Request('http://x/api/promo/validate', {
        method: 'POST',
        body: JSON.stringify({ code: 'launch50', amountRub: 1000 }),
      }) as never
    );
    expect(r.status).toBe(200);
    const j = await (r as Response).json();
    expect(j.ok).toBe(true);
    expect(j.discountRub).toBe(500);
    expect(j.chargeRub).toBe(500);
  });
});

describe('POST /api/admin/promos', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects non-admins', async () => {
    (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: 'u@test' },
    });
    userFindFirst.mockResolvedValue({ email: 'u@test', role: 'user' });
    const r = await adminCreatePOST(
      new Request('http://x/api/admin/promos', {
        method: 'POST',
        body: JSON.stringify({ code: 'X', kind: 'percent_off', value: 10 }),
      }) as never
    );
    expect(r.status).toBe(403);
  });

  it('validates kind and value', async () => {
    asAdmin();
    const r = await adminCreatePOST(
      new Request('http://x/api/admin/promos', {
        method: 'POST',
        body: JSON.stringify({ code: 'X', kind: 'wat', value: 10 }),
      }) as never
    );
    expect(r.status).toBe(400);

    const r2 = await adminCreatePOST(
      new Request('http://x/api/admin/promos', {
        method: 'POST',
        body: JSON.stringify({ code: 'X', kind: 'percent_off', value: -1 }),
      }) as never
    );
    expect(r2.status).toBe(400);
  });

  it('inserts and returns id on success', async () => {
    asAdmin();
    dbExecute
      .mockResolvedValueOnce({ rows: [{ id: 'new-uuid' }] }) // INSERT RETURNING
      .mockResolvedValueOnce({ rows: [] }); // audit log
    const r = await adminCreatePOST(
      new Request('http://x/api/admin/promos', {
        method: 'POST',
        body: JSON.stringify({ code: 'launch50', kind: 'percent_off', value: 50 }),
      }) as never
    );
    expect(r.status).toBe(200);
    const j = await (r as Response).json();
    expect(j.ok).toBe(true);
    expect(j.id).toBe('new-uuid');
  });
});
