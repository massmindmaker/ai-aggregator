/**
 * Tests for /api/admin/jobs — list + retry + cancel.
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
import { GET as listJobs } from '@/app/api/admin/jobs/route';
import { POST as retryJob } from '@/app/api/admin/jobs/[id]/retry/route';
import { POST as cancelJob } from '@/app/api/admin/jobs/[id]/cancel/route';

function withAdmin() {
  (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { email: 'a@x' } });
  userFindFirst.mockResolvedValue({ email: 'a@x', role: 'admin' });
}

function makeReq(url: string) {
  return { nextUrl: new URL(url) } as never;
}

describe('/api/admin/jobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('list rejects unauthenticated', async () => {
    (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const r = await listJobs(makeReq('http://x/api/admin/jobs'));
    expect((r as Response).status).toBe(401);
  });

  it('list with status filter calls DB', async () => {
    withAdmin();
    dbExecute.mockResolvedValueOnce({ rows: [{ id: 'j1', task_id: 'kie:fam:t1' }] });
    const r = await listJobs(makeReq('http://x/api/admin/jobs?status=running'));
    const j = await (r as Response).json();
    expect(j.jobs.length).toBe(1);
  });

  it('retry only allowed for failed/timeout/cancelled', async () => {
    withAdmin();
    dbExecute.mockResolvedValueOnce({ rows: [] }); // not retryable -> empty
    const r = await retryJob({} as never, {
      params: Promise.resolve({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }),
    });
    expect((r as Response).status).toBe(400);
  });

  it('retry succeeds and audits', async () => {
    withAdmin();
    dbExecute
      .mockResolvedValueOnce({ rows: [{ id: 'j1', status: 'queued', task_id: 'kie:1' }] })
      .mockResolvedValueOnce({ rows: [] });
    const r = await retryJob({} as never, {
      params: Promise.resolve({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }),
    });
    const j = await (r as Response).json();
    expect(j.ok).toBe(true);
    expect(j.status).toBe('queued');
  });

  it('cancel returns 400 if not in queued/running', async () => {
    withAdmin();
    dbExecute.mockResolvedValueOnce({ rows: [] });
    const r = await cancelJob({} as never, {
      params: Promise.resolve({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }),
    });
    expect((r as Response).status).toBe(400);
  });

  it('cancel returns ok when row updated', async () => {
    withAdmin();
    dbExecute
      .mockResolvedValueOnce({ rows: [{ id: 'j1', task_id: 'kie:1' }] })
      .mockResolvedValueOnce({ rows: [] });
    const r = await cancelJob({} as never, {
      params: Promise.resolve({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }),
    });
    const j = await (r as Response).json();
    expect(j.ok).toBe(true);
  });
});
