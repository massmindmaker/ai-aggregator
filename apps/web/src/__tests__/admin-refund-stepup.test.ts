/**
 * Issue #20 — POST /api/admin/payments/refund must enforce the aiag_admin_session
 * step-up cookie server-side via the shared requireAdmin() helper, not only in the
 * /admin/* UI layout. Before the fix, a valid NextAuth admin session alone was
 * enough to call this money-moving route directly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn() }));

const cookieGet = vi.fn();
vi.mock('next/headers', () => ({
  headers: () => ({ get: () => null }),
  cookies: async () => ({ get: (...args: unknown[]) => cookieGet(...args) }),
}));

const verifyAdminSessionMock = vi.fn();
vi.mock('@/lib/admin/session', () => ({
  ADMIN_COOKIE_NAME: 'aiag_admin_session',
  verifyAdminSession: (...args: unknown[]) => verifyAdminSessionMock(...args),
}));

const userFindFirst = vi.fn();
// Lazy arrow (TDZ-safe): the hoisted factory must not touch dbExecute before its
// const is initialised. The route now persists the refund via db.execute(sql`…`).
const dbExecute = vi.fn();
vi.mock('@/lib/db', () => ({
  db: {
    query: { users: { findFirst: (...args: unknown[]) => userFindFirst(...args) } },
    execute: (...args: unknown[]) => dbExecute(...args),
  },
  eq: (a: unknown, b: unknown) => ({ a, b }),
  sql: (s: TemplateStringsArray) => ({ raw: s.raw.join(' ') }),
}));

const refundMock = vi.fn();
vi.mock('@/lib/payments/providers', () => ({
  getPaymentProvider: () => ({ id: 'tinkoff', refund: (...a: unknown[]) => refundMock(...a) }),
}));

import type { NextRequest } from 'next/server';
import { auth } from '@/auth';
import { POST as refundPost } from '@/app/api/admin/payments/refund/route';

function jsonReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

const REFUND_BODY = {
  paymentId: 'p-1',
  provider: 'tinkoff' as const,
  providerPaymentId: 'prov-1',
  amount: 500,
};

function signInAsAdmin() {
  (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    user: { email: 'admin@test' },
  });
  userFindFirst.mockResolvedValue({ id: 'u-1', email: 'admin@test', role: 'admin' });
}

describe('POST /api/admin/payments/refund — step-up enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbExecute.mockReset();
  });

  it('valid NextAuth admin session but NO aiag_admin_session cookie → 403 STEPUP_REQUIRED', async () => {
    signInAsAdmin();
    cookieGet.mockReturnValue(undefined); // no cookie at all
    verifyAdminSessionMock.mockResolvedValue(false);

    const r = await refundPost(jsonReq(REFUND_BODY));
    expect((r as Response).status).toBe(403);
    const body = await (r as Response).json();
    expect(body).toEqual({ error: 'STEPUP_REQUIRED' });
    // Must short-circuit before ever touching the payment provider.
    expect(refundMock).not.toHaveBeenCalled();
  });

  it('valid NextAuth admin session + stale/invalid cookie → 403 STEPUP_REQUIRED', async () => {
    signInAsAdmin();
    cookieGet.mockReturnValue({ value: 'stale-token' });
    verifyAdminSessionMock.mockResolvedValue(false);

    const r = await refundPost(jsonReq(REFUND_BODY));
    expect((r as Response).status).toBe(403);
    expect(refundMock).not.toHaveBeenCalled();
  });

  it('no NextAuth session at all → 401 UNAUTHORIZED', async () => {
    (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const r = await refundPost(jsonReq(REFUND_BODY));
    expect((r as Response).status).toBe(401);
    expect(refundMock).not.toHaveBeenCalled();
  });

  it('valid admin session + valid aiag_admin_session cookie → proceeds as before (200)', async () => {
    signInAsAdmin();
    cookieGet.mockReturnValue({ value: 'valid-token' });
    verifyAdminSessionMock.mockResolvedValue(true);
    refundMock.mockResolvedValue({ success: true, providerRefundId: 'ref-1' });
    // Confirmed, un-refunded ₽500 payment: the SELECT passes the ceiling and the
    // claim UPDATE wins its WHERE-guard (returns the row), so the refund proceeds.
    dbExecute.mockImplementation((q: { raw?: string }) => {
      const raw = q?.raw ?? '';
      if (raw.includes('SELECT amount')) return Promise.resolve({ rows: [{ amount: '500' }] });
      if (raw.includes('refunded_at = NOW()'))
        return Promise.resolve({ rows: [{ id: 'p-1', amount: '500', tinkoff_payment_id: 'prov-1' }] });
      return Promise.resolve({ rows: [] });
    });

    const r = await refundPost(jsonReq(REFUND_BODY));
    expect((r as Response).status).toBe(200);
    const body = await (r as Response).json();
    expect(body).toEqual({ success: true, refundId: 'ref-1', paymentId: 'p-1' });
    expect(refundMock).toHaveBeenCalledWith('prov-1', 500, 'admin_manual_refund');
  });
});
