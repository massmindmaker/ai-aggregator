/**
 * Phase 14-04 Task 3 — tests for /api/admin/payouts/[id]/approve and /reject.
 *
 * Mocks @/auth + @/lib/db; asserts:
 *   - non-admin → 401
 *   - missing payout → 404
 *   - already paid → 409 IDEMPOTENT_NOOP
 *   - missing kyc_type → 422 KYC_REQUIRED
 *   - happy path физлицо → tax+ledger+audit transactional UPDATEs run
 *   - reject without reason → 400; with reason → transaction with UPDATE + audit
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
const txExecute = vi.fn();
const dbTransaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
  cb({ execute: txExecute })
);
const userFindFirst = vi.fn();

vi.mock('@/lib/db', () => ({
  db: {
    query: { users: { findFirst: (...a: unknown[]) => userFindFirst(...a) } },
    execute: (...a: unknown[]) => dbExecute(...a),
    transaction: (...a: unknown[]) =>
      (dbTransaction as unknown as (...args: unknown[]) => unknown)(...a),
  },
  eq: (a: unknown, b: unknown) => ({ a, b }),
  sql: (s: TemplateStringsArray, ...vals: unknown[]) => ({
    raw: s.raw.join('?'),
    vals,
  }),
}));

import { auth } from '@/auth';
import { POST as approveRoute } from '@/app/api/admin/payouts/[id]/approve/route';
import { POST as rejectRoute } from '@/app/api/admin/payouts/[id]/reject/route';

const PAYOUT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

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
function asAnon() {
  (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
}

function jsonReq(body: unknown): Request {
  return { json: async () => body } as unknown as Request;
}
function emptyReq(): Request {
  return { json: async () => ({}) } as unknown as Request;
}
function paramsP(id: string) {
  return Promise.resolve({ id });
}

describe('POST /api/admin/payouts/[id]/approve', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects non-admin with 401', async () => {
    asAnon();
    const r = (await approveRoute(emptyReq(), {
      params: paramsP(PAYOUT_ID),
    })) as Response;
    expect(r.status).toBe(401);
  });

  it('returns 404 when payout missing', async () => {
    asAdmin();
    dbExecute.mockResolvedValueOnce({ rows: [] });
    const r = (await approveRoute(emptyReq(), {
      params: paramsP(PAYOUT_ID),
    })) as Response;
    expect(r.status).toBe(404);
  });

  it('returns 409 IDEMPOTENT_NOOP when already paid', async () => {
    asAdmin();
    dbExecute.mockResolvedValueOnce({
      rows: [
        {
          id: PAYOUT_ID,
          author_id: 'author-uuid',
          amount_rub: '5000',
          status: 'paid',
          kyc_status: 'verified',
          kyc_type: 'individual',
          tax_id: '123',
          bank_details: null,
          kyc_verified_at: '2026-01-01',
        },
      ],
    });
    const r = (await approveRoute(emptyReq(), {
      params: paramsP(PAYOUT_ID),
    })) as Response;
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.error).toBe('IDEMPOTENT_NOOP');
  });

  it('returns 422 KYC_REQUIRED when user has no kyc_type', async () => {
    asAdmin();
    dbExecute.mockResolvedValueOnce({
      rows: [
        {
          id: PAYOUT_ID,
          author_id: 'author-uuid',
          amount_rub: '5000',
          status: 'requested',
          kyc_status: 'none',
          kyc_type: null,
          tax_id: null,
          bank_details: null,
          kyc_verified_at: null,
        },
      ],
    });
    const r = (await approveRoute(emptyReq(), {
      params: paramsP(PAYOUT_ID),
    })) as Response;
    expect(r.status).toBe(422);
    const j = await r.json();
    expect(j.error).toBe('KYC_REQUIRED');
  });

  it('happy path физлицо: computes 13% tax, runs 3 tx mutations, returns net_rub', async () => {
    asAdmin();
    dbExecute.mockResolvedValueOnce({
      rows: [
        {
          id: PAYOUT_ID,
          author_id: 'author-uuid',
          amount_rub: '10000',
          status: 'requested',
          kyc_status: 'verified',
          kyc_type: 'individual',
          tax_id: '500100732259',
          bank_details: null,
          kyc_verified_at: '2026-01-01',
        },
      ],
    });
    txExecute.mockResolvedValue({ rows: [], rowCount: 1 });

    const r = (await approveRoute(emptyReq(), {
      params: paramsP(PAYOUT_ID),
    })) as Response;
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.tax_withheld_rub).toBe(1300);
    expect(j.net_rub).toBe(8700);
    expect(j.withholding_pct).toBe(13);
    expect(j.auto_path).toBe(true);

    // exactly 3 tx mutations: payouts UPDATE, author_earnings UPDATE, audit_log INSERT
    expect(dbTransaction).toHaveBeenCalledTimes(1);
    expect(txExecute).toHaveBeenCalledTimes(3);
  });
});

describe('POST /api/admin/payouts/[id]/reject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects non-admin with 401', async () => {
    asAnon();
    const r = (await rejectRoute(jsonReq({ reason: 'spam' }), {
      params: paramsP(PAYOUT_ID),
    })) as Response;
    expect(r.status).toBe(401);
  });

  it('returns 400 REASON_REQUIRED when body has no reason', async () => {
    asAdmin();
    const r = (await rejectRoute(jsonReq({}), {
      params: paramsP(PAYOUT_ID),
    })) as Response;
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error).toBe('REASON_REQUIRED');
  });

  it('happy path: UPDATE + audit INSERT in single transaction', async () => {
    asAdmin();
    txExecute
      .mockResolvedValueOnce({ rows: [{ id: PAYOUT_ID }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const r = (await rejectRoute(jsonReq({ reason: 'KYC documents invalid' }), {
      params: paramsP(PAYOUT_ID),
    })) as Response;
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(dbTransaction).toHaveBeenCalledTimes(1);
    expect(txExecute).toHaveBeenCalledTimes(2);
  });

  it('returns 404 when payout already final or missing', async () => {
    asAdmin();
    txExecute.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const r = (await rejectRoute(jsonReq({ reason: 'late' }), {
      params: paramsP(PAYOUT_ID),
    })) as Response;
    expect(r.status).toBe(404);
    const j = await r.json();
    expect(j.error).toBe('NOT_FOUND_OR_FINAL');
  });
});
