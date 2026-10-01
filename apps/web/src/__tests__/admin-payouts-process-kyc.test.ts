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

/**
 * CTE names that the statement actually READS, as opposed to merely defines.
 *
 * H-4: `toContain('eligible_author')` passed while the CTE was orphaned — the
 * name appeared in its own `WITH eligible_author AS (...)` definition and
 * nowhere else, so PostgreSQL would have dropped it as dead and the payout
 * INSERT would have been unguarded. A definition is not a use, so the CTE
 * bodies are removed before the search: what is left is the statement proper,
 * and only a name that survives there is joined.
 *
 * Reports `{ declared, read }`. `declared` is every CTE the statement
 * defines; `read` is the subset the consuming statement actually joins. A CTE
 * that is defined but not read is an orphan, which is the defect H-4 missed.
 */
function cteUsage(sql: string): { declared: string[]; read: string[] } {
  const withAt = sql.indexOf('WITH ');
  if (withAt === -1) return { declared: [], read: [] };
  let i = withAt + 'WITH '.length;
  const declared: string[] = [];
  // Walk the CTE list, consuming each `name AS ( body )` whole.
  for (;;) {
    const nameMatch = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+AS\s*\(/i.exec(sql.slice(i));
    if (!nameMatch) break;
    const name = nameMatch[1]!;
    const open = i + nameMatch[0].length - 1;
    let depth = 0;
    let j = open;
    for (; j < sql.length; j++) {
      const ch = sql[j];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (j >= sql.length) throw new Error(`unbalanced CTE body for ${name}`);
    declared.push(name);
    i = j + 1;
    const next = /^\s*,\s*/.exec(sql.slice(i));
    if (!next) break;
    i += next[0].length;
  }
  if (declared.length === 0) throw new Error('WITH clause declared no CTE');
  // Everything from here on is the statement that consumes the CTEs.
  const consumer = sql.slice(i);
  return {
    declared,
    read: declared.filter((name) => new RegExp(`\\b${name}\\b`).test(consumer)),
  };
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

  it('joins the eligible-author CTE into the INSERT, not just defines it', async () => {
    asAdmin();
    dbExecute.mockResolvedValue({ rows: [{ id: 'payout-1' }] });

    await processPost(jsonReq({ userIds: [AUTHOR_UUID] }));

    // H-4: a CTE that is defined but never referenced is discarded by
    // PostgreSQL as dead code, so the payout INSERT becomes unguarded while
    // every `toContain` above still passes. Every declared CTE must be read by
    // the consuming statement.
    const { declared, read } = cteUsage(sqlOf(0));
    expect(declared).toContain('eligible_author');
    expect(read).toEqual(declared);
    // And the join must be a real cross-join in the INSERT's FROM clause —
    // an eligible-author CTE that is present but not selected from does not
    // filter anything.
    expect(sqlOf(0)).toMatch(/FROM\s+agg\s*,\s*eligible_author\b/i);
  });

  it('detects an orphaned CTE: a definition alone is not a use', () => {
    // The helper itself is the guard for the helper. If this ever passes
    // vacuously, the structural assertions above prove nothing.
    const orphaned = `WITH eligible_author AS (
        SELECT 1 FROM users WHERE kyc_status = 'verified' AND kyc_type IS NOT NULL
      ), agg AS (
        SELECT COALESCE(SUM(author_share_rub), 0)::numeric AS total FROM author_earnings
      )
      INSERT INTO payouts (user_id, amount) SELECT 1, total FROM agg WHERE total > 0`;
    const joined = orphaned.replace('FROM agg WHERE', 'FROM agg, eligible_author WHERE');

    expect(cteUsage(orphaned).declared).toEqual(['eligible_author', 'agg']);
    expect(cteUsage(orphaned).read).toEqual(['agg']);
    expect(cteUsage(joined).read).toEqual(['eligible_author', 'agg']);
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