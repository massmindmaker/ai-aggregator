/**
 * Tests for admin RBAC guard + audit log helper.
 * Verifies role enforcement, the aiag_admin_session step-up gate
 * (issue #20 — step-up must be enforced server-side in the shared
 * helper, not only in the /admin/* UI layout), and audit emission.
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

const dbExecute = vi.fn(async () => ({ rows: [] }));
const userFindFirst = vi.fn();
vi.mock('@/lib/db', () => ({
  db: {
    query: { users: { findFirst: (...args: unknown[]) => userFindFirst(...args) } },
    execute: (...args: unknown[]) => dbExecute(...args),
  },
  eq: (a: unknown, b: unknown) => ({ a, b }),
  sql: (s: TemplateStringsArray) => ({ raw: s.raw.join(' ') }),
}));

import { auth } from '@/auth';
import { requireAdmin, audit, AdminAuthError } from '@/lib/admin/guard';

describe('requireAdmin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws UNAUTHORIZED when not signed in', async () => {
    (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(requireAdmin()).rejects.toBeInstanceOf(AdminAuthError);
    await expect(requireAdmin()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('throws FORBIDDEN when user is not admin', async () => {
    (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: 'someone@test' },
    });
    userFindFirst.mockResolvedValue({ email: 'someone@test', role: 'user' });
    await expect(requireAdmin()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('throws STEPUP_REQUIRED when role=admin but the aiag_admin_session cookie is missing', async () => {
    (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: 'admin@test' },
    });
    userFindFirst.mockResolvedValue({ id: 'u-1', email: 'admin@test', role: 'admin' });
    cookieGet.mockReturnValue(undefined);
    verifyAdminSessionMock.mockResolvedValue(false);
    await expect(requireAdmin()).rejects.toBeInstanceOf(AdminAuthError);
    await expect(requireAdmin()).rejects.toMatchObject({ code: 'STEPUP_REQUIRED' });
  });

  it('throws STEPUP_REQUIRED when the cookie is present but invalid/expired', async () => {
    (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: 'admin@test' },
    });
    userFindFirst.mockResolvedValue({ id: 'u-1', email: 'admin@test', role: 'admin' });
    cookieGet.mockReturnValue({ value: 'stale-token' });
    verifyAdminSessionMock.mockResolvedValue(false);
    await expect(requireAdmin()).rejects.toMatchObject({ code: 'STEPUP_REQUIRED' });
  });

  it('passes when role is admin and the step-up cookie is valid', async () => {
    (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { email: 'admin@test' },
    });
    userFindFirst.mockResolvedValue({ id: 'u-1', email: 'admin@test', role: 'admin' });
    cookieGet.mockReturnValue({ value: 'valid-token' });
    verifyAdminSessionMock.mockResolvedValue(true);
    const r = await requireAdmin();
    expect(r.user.email).toBe('admin@test');
    expect(verifyAdminSessionMock).toHaveBeenCalledWith('valid-token', 'u-1');
  });
});

describe('audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts a row into audit_log', async () => {
    await audit('admin@test', 'user.ban', 'user', 'u-1', { reason: 'spam' });
    expect(dbExecute).toHaveBeenCalledTimes(1);
  });

  it('does not throw when DB insert fails', async () => {
    dbExecute.mockRejectedValueOnce(new Error('boom'));
    await expect(audit('admin@test', 'noop', 'x', null, {})).resolves.toBeUndefined();
  });
});
