/**
 * F-1 (security review) — POST /api/admin/payouts/process must not create a
 * payout row for an author whose KYC is not verified.
 *
 * Before the fix the route aggregated `author_earnings` and INSERTed a
 * 'processing' payout unconditionally, then locked the accruals. approve's
 * gate only ran later, so an unverified/rejected author still entered the
 * payout pipeline and had their earnings locked.
 *
 * The route is exercised through its SQL: the assertion is that the payout
 * INSERT is guarded by a verified-KYC author row, and that no accrual lock
 * or success audit happens when the INSERT returns no row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

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
  sql: (s: TemplateStringsArray, ...vals: unknown[]) => ({ raw: s.raw.join(' '), vals }),
}));

import { auth } from '@/auth';
import { POST as processPost } from '@/app/api/admin/payouts/process/route';

const AUTHOR_UUID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function asAdmin() {
  (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    user: { email: 'admin@aiag.ru' },
  });
  userFindFirst.mockResolvedValue({
    id: 'admin-uuid',
    email: 'admin@aiag.ru',
    role: 'admin',
  });
}

function jsonReq(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

type SqlCall = { sql: string; vals: unknown[] };

function calls(): SqlCall[] {
  return (dbExecute.mock.calls as unknown as Array<[{ raw?: string; vals?: unknown[] }]>).map(
    (call) => {
      const q = call?.[0];
      return { sql: String(q?.raw ?? ''), vals: (q?.vals ?? []) as unknown[] };
    }
  );
}
/** SQL text of the nth db.execute call (the mock flattens the template). */
function sqlOf(index: number): string {
  return calls()[index]?.sql ?? '';
}

/** audit() carries the action name as one of its interpolation values. */
function auditActions(): string[] {
  return calls()
    .filter((c) => c.sql.includes('INSERT INTO audit_log'))
    .map((c) => String(c.vals[1] ?? ''));
}

describe('POST /api/admin/payouts/process — KYC gate (F-1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('guards the payout INSERT with a verified-KYC author row', async () => {
    asAdmin();
    dbExecute.mockResolvedValue({ rows: [{ id: 'payout-1' }] });

    await processPost(jsonReq({ userIds: [AUTHOR_UUID] }));

    const insert = sqlOf(0);
    expect(insert).toContain('INSERT INTO payouts');
    // The author must be proven verified in the SAME statement.
    expect(insert).toContain("kyc_status = 'verified'");
    expect(insert).toContain('kyc_type IS NOT NULL');
    expect(insert).toContain('eligible_author');
  });

  it('does not lock accruals or claim success when the author is not KYC-verified', async () => {
    asAdmin();
    // INSERT ... RETURNING yields no row → author is not eligible.
    dbExecute.mockResolvedValueOnce({ rows: [] });

    const r = (await processPost(jsonReq({ userIds: [AUTHOR_UUID] }))) as Response;
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.created).toBe(0);
    expect(j.skipped).toBe(1);

    // No author_earnings lock — that is the state change that used to happen
    // for unverified authors.
    expect(sqlOf(1)).not.toContain('UPDATE author_earnings');
    expect(auditActions()).toEqual(['payout.process_skipped']);
  });

  it('locks accruals and audits success for a verified author', async () => {
    asAdmin();
    dbExecute.mockResolvedValue({ rows: [{ id: 'payout-1' }] });

    const r = (await processPost(jsonReq({ userIds: [AUTHOR_UUID] }))) as Response;
    const j = await r.json();
    expect(j.created).toBe(1);
    expect(j.skipped).toBe(0);
    expect(sqlOf(1)).toContain("UPDATE author_earnings SET status = 'locked'");
    expect(auditActions()).toEqual(['payout.process']);
  });
});