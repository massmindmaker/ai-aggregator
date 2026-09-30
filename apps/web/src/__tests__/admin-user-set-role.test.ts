/**
 * F-2 (security review) — PATCH /api/admin/users/[id] op:'setRole'.
 *
 * Before the fix any admin session (even one where the step-up cookie was
 * minted hours earlier) could mint a brand-new admin with a single call and
 * the only trace was one audit row. Now:
 *   - admin → self is refused outright (403)
 *   - admin → somebody else needs confirmAdminGrant:true AND a reason ≥ 10 chars
 *   - the UPDATE is guarded so a no-op grant writes nothing
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

const dbExecute = vi.fn(async () => ({ rows: [] }));
const userFindFirst = vi.fn();
vi.mock('@/lib/db', () => ({
  db: {
    query: { users: { findFirst: (...a: unknown[]) => userFindFirst(...a) } },
    execute: (...a: unknown[]) => (dbExecute as (...args: unknown[]) => unknown)(...a),
  },
  eq: (a: unknown, b: unknown) => ({ a, b }),
  sql: (s: TemplateStringsArray, ...vals: unknown[]) => ({
    raw: s.raw.join(' '),
    vals,
  }),
}));

import { auth } from '@/auth';
import { PATCH as patchUser } from '@/app/api/admin/users/[id]/route';

const ADMIN_ID = 'admin-uuid';
const OTHER_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// requireAdmin resolves the ACTING admin by email; the route then resolves the
// TARGET by id. Distinguish on the id so call order can never mask a regression.
function asAdmin(target: { id: string; role: string } = { id: OTHER_ID, role: 'user' }) {
  (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    user: { email: 'admin@aiag.ru' },
  });
  userFindFirst.mockImplementation((args: unknown) => {
    // findFirst receives { where: eq(column, value) }.
    const key = (args as { where?: { b?: string } })?.where?.b;
    // requireAdmin looks the ACTING admin up by email…
    if (key === 'admin@aiag.ru')
      return Promise.resolve({ id: ADMIN_ID, email: 'admin@aiag.ru', role: 'admin' });
    // …the route then looks the TARGET up by id.
    if (key === ADMIN_ID)
      return Promise.resolve({ id: ADMIN_ID, email: 'admin@aiag.ru', role: 'admin' });
    return Promise.resolve({ id: target.id, email: 'x@y', role: target.role });
  });
}

function jsonReq(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}
function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
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
function roleUpdates(): string[] {
  return calls().filter((c) => c.sql.includes('UPDATE users SET role')).map((c) => c.sql);
}
/** audit() passes one JSON string as a single interpolation value. */
function auditInserts(): Array<{ sql: string; vals: unknown[]; details: Record<string, unknown> }> {
  return calls()
    .filter((c) => c.sql.includes('INSERT INTO audit_log'))
    .map((c) => ({
      sql: c.sql,
      vals: c.vals,
      details: JSON.parse(
        String(c.vals.find((v) => typeof v === 'string' && v.startsWith('{')) ?? '{}')
      ) as Record<string, unknown>,
    }));
}

describe("PATCH /api/admin/users/[id] — op 'setRole' (F-2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbExecute.mockResolvedValue({ rows: [] });
  });

  it('refuses granting admin to the acting admin themselves', async () => {
    asAdmin();
    const r = (await patchUser(
      jsonReq({ op: 'setRole', role: 'admin' }),
      ctx(ADMIN_ID)
    )) as Response;
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('SELF_ADMIN_GRANT_FORBIDDEN');
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it('refuses granting admin without explicit confirmation', async () => {
    asAdmin();
    const r = (await patchUser(
      jsonReq({ op: 'setRole', role: 'admin', reason: 'hired as ops lead' }),
      ctx(OTHER_ID)
    )) as Response;
    expect(r.status).toBe(428);
    expect((await r.json()).error).toBe('ADMIN_GRANT_CONFIRMATION_REQUIRED');
    expect(roleUpdates()).toHaveLength(0);
  });

  it('refuses granting admin without a substantive reason', async () => {
    asAdmin();
    const r = (await patchUser(
      jsonReq({ op: 'setRole', role: 'admin', confirmAdminGrant: true, reason: 'ok' }),
      ctx(OTHER_ID)
    )) as Response;
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('REASON_REQUIRED');
    expect(roleUpdates()).toHaveLength(0);
  });

  it('grants admin to another user when confirmed + reasoned, and audits from/role', async () => {
    asAdmin();
    const r = (await patchUser(
      jsonReq({
        op: 'setRole',
        role: 'admin',
        confirmAdminGrant: true,
        reason: 'contract signed, ops lead from 2026-10',
      }),
      ctx(OTHER_ID)
    )) as Response;
    expect(r.status).toBe(200);
    expect(roleUpdates()).toHaveLength(1);
    const update = roleUpdates()[0]!;
    // Guarded no-op write: an unchanged role must not be re-stamped.
    expect(update).toContain('role IS DISTINCT FROM');
    expect(update).toContain('::uuid');
    const auditCall = auditInserts()[0]!;
    expect(auditCall.sql).toContain('INSERT INTO audit_log');
    // audit(actorEmail, action, resourceType, resourceId, details)
    expect(auditCall.vals[1]).toBe('user.set_role');
    expect(auditCall.vals[0]).toBe('admin@aiag.ru');
    // The previous role is recorded so an escalation is reviewable after the fact.
    expect(auditCall.details).toMatchObject({ role: 'admin', from: 'user' });
    expect(auditCall.details).toMatchObject({ reason: 'contract signed, ops lead from 2026-10' });
  });

  it('non-privileged roles still work without the extra confirmation', async () => {
    asAdmin();
    const r = (await patchUser(
      jsonReq({ op: 'setRole', role: 'moderator' }),
      ctx(OTHER_ID)
    )) as Response;
    expect(r.status).toBe(200);
    expect(roleUpdates()).toHaveLength(1);
  });

  it('rejects an unknown role', async () => {
    asAdmin();
    const r = (await patchUser(
      jsonReq({ op: 'setRole', role: 'superadmin' }),
      ctx(OTHER_ID)
    )) as Response;
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('BAD_ROLE');
  });
});