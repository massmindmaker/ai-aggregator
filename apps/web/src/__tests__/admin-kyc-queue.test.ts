/**
 * Tests for /api/admin/kyc/[id]/approve and /reject — auth, idempotency,
 * REQUIRED_DOCS completeness, audit, user kyc_status promotion.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn() }));
vi.mock('next/headers', () => ({ headers: () => ({ get: () => null }) }));

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
import { POST as approvePost } from '@/app/api/admin/kyc/[id]/approve/route';
import { POST as rejectPost } from '@/app/api/admin/kyc/[id]/reject/route';

const DOC_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function setAdmin() {
  (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    user: { email: 'admin@x' },
  });
  userFindFirst.mockResolvedValue({ id: 'admin-id', email: 'admin@x', role: 'admin' });
}

function jsonReq(body: unknown) {
  return { json: async () => body } as unknown as Request;
}

function ctx() {
  return { params: Promise.resolve({ id: DOC_ID }) };
}

describe('/api/admin/kyc/[id]/approve', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects non-admin (401)', async () => {
    (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const r = (await approvePost({} as never, ctx())) as Response;
    expect(r.status).toBe(401);
  });

  it('returns 404 when doc not found', async () => {
    setAdmin();
    dbExecute.mockResolvedValueOnce({ rows: [] }); // SELECT doc
    const r = (await approvePost({} as never, ctx())) as Response;
    expect(r.status).toBe(404);
  });

  it('returns 409 IDEMPOTENT_NOOP when already approved', async () => {
    setAdmin();
    dbExecute.mockResolvedValueOnce({
      rows: [
        {
          id: DOC_ID,
          user_id: USER_ID,
          status: 'approved',
          doc_type: 'inn_certificate',
          kyc_type: 'self_employed',
        },
      ],
    });
    const r = (await approvePost({} as never, ctx())) as Response;
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.error).toBe('IDEMPOTENT_NOOP');
  });

  it('promotes user.kyc_status=verified when all required docs approved (self_employed)', async () => {
    setAdmin();
    dbExecute
      // SELECT doc (the one being approved is currently pending)
      .mockResolvedValueOnce({
        rows: [
          {
            id: DOC_ID,
            user_id: USER_ID,
            status: 'pending',
            doc_type: 'self_employed_certificate',
            kyc_type: 'self_employed',
          },
        ],
      })
      // UPDATE kyc_documents (approve)
      .mockResolvedValueOnce({ rows: [] })
      // SELECT DISTINCT doc_type FROM kyc_documents (after approve)
      .mockResolvedValueOnce({
        rows: [{ doc_type: 'self_employed_certificate' }, { doc_type: 'inn_certificate' }],
      })
      // UPDATE users SET kyc_status='verified'
      .mockResolvedValueOnce({ rows: [] })
      // INSERT audit_log
      .mockResolvedValueOnce({ rows: [] });

    const r = (await approvePost({} as never, ctx())) as Response;
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.promoted).toBe(true);

    // Verify a UPDATE users with kyc_status='verified' was issued
    const calls = dbExecute.mock.calls.map(
      (c) => (c[0] as { raw?: string })?.raw ?? ''
    );
    expect(calls.some((s) => s.includes("kyc_status='verified'"))).toBe(true);
  });

  it('does NOT promote when required docs incomplete (inn missing)', async () => {
    setAdmin();
    dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            id: DOC_ID,
            user_id: USER_ID,
            status: 'pending',
            doc_type: 'self_employed_certificate',
            kyc_type: 'self_employed',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }) // approve update
      .mockResolvedValueOnce({ rows: [{ doc_type: 'self_employed_certificate' }] }) // only one approved
      .mockResolvedValueOnce({ rows: [] }) // SELECT 1 FROM users WHERE kyc_status='none' — returns []
      .mockResolvedValueOnce({ rows: [] }); // audit

    const r = (await approvePost({} as never, ctx())) as Response;
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.promoted).toBe(false);

    const calls = dbExecute.mock.calls.map(
      (c) => (c[0] as { raw?: string })?.raw ?? ''
    );
    expect(calls.some((s) => s.includes("kyc_status='verified'"))).toBe(false);
  });

  it('writes audit row with action=kyc.approve_doc', async () => {
    setAdmin();
    dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            id: DOC_ID,
            user_id: USER_ID,
            status: 'pending',
            doc_type: 'inn_certificate',
            kyc_type: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }) // approve update
      .mockResolvedValueOnce({ rows: [] }); // audit

    const r = (await approvePost({} as never, ctx())) as Response;
    expect(r.status).toBe(200);

    const calls = dbExecute.mock.calls.map(
      (c) => (c[0] as { raw?: string })?.raw ?? ''
    );
    expect(calls.some((s) => s.includes('audit_log') || s.includes('INSERT'))).toBe(true);
  });
});

describe('/api/admin/kyc/[id]/reject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires reason in body (400)', async () => {
    setAdmin();
    const r = (await rejectPost(jsonReq({}), ctx())) as Response;
    expect(r.status).toBe(400);
  });

  it('rejects doc and sets users.kyc_status=rejected + audits', async () => {
    setAdmin();
    dbExecute
      .mockResolvedValueOnce({
        rows: [{ id: DOC_ID, user_id: USER_ID, status: 'pending' }],
      })
      .mockResolvedValueOnce({ rows: [] }) // UPDATE doc
      .mockResolvedValueOnce({ rows: [] }) // UPDATE users
      .mockResolvedValueOnce({ rows: [] }); // audit

    const r = (await rejectPost(jsonReq({ reason: 'blurry photo' }), ctx())) as Response;
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);

    const calls = dbExecute.mock.calls.map(
      (c) => (c[0] as { raw?: string })?.raw ?? ''
    );
    expect(calls.some((s) => s.includes("status='rejected'"))).toBe(true);
    expect(calls.some((s) => s.includes("kyc_status='rejected'"))).toBe(true);
  });

  it('returns 409 when doc already rejected', async () => {
    setAdmin();
    dbExecute.mockResolvedValueOnce({
      rows: [{ id: DOC_ID, user_id: USER_ID, status: 'rejected' }],
    });
    const r = (await rejectPost(jsonReq({ reason: 'x' }), ctx())) as Response;
    expect(r.status).toBe(409);
  });
});
