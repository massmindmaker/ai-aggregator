/**
 * Plan 14-06 — admin freeze/depublish API + gateway model-status middleware.
 * 9 behaviors per plan.
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
  sql: (s: TemplateStringsArray, ...vals: unknown[]) => ({
    raw: s.raw.join(' '),
    values: vals,
  }),
}));

import { auth } from '@/auth';
import { POST as freezePost } from '@/app/api/admin/models/[id]/freeze/route';
import { POST as depublishPost } from '@/app/api/admin/models/[id]/depublish/route';

const MODEL_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function withAdmin() {
  (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    user: { email: 'a@x' },
  });
  userFindFirst.mockResolvedValue({ email: 'a@x', role: 'admin' });
}

function jsonReq(body: unknown): Request {
  return { json: async () => body } as unknown as Request;
}

function ctx(id = MODEL_ID) {
  return { params: Promise.resolve({ id }) };
}

describe('/api/admin/models/[id]/freeze', () => {
  beforeEach(() => vi.clearAllMocks());

  it('1. rejects non-admin (401)', async () => {
    (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const r = await freezePost(jsonReq({ reason: 'x' }), ctx());
    expect((r as Response).status).toBe(401);
  });

  it('2. returns 404 when model not found', async () => {
    withAdmin();
    dbExecute.mockResolvedValueOnce({ rows: [] });
    const r = await freezePost(jsonReq({ reason: 'broken' }), ctx());
    expect((r as Response).status).toBe(404);
  });

  it('3. returns 409 IDEMPOTENT_NOOP when already frozen', async () => {
    withAdmin();
    dbExecute.mockResolvedValueOnce({
      rows: [{ id: MODEL_ID, slug: 'gpt-4', status: 'frozen' }],
    });
    const r = await freezePost(jsonReq({ reason: 'broken' }), ctx());
    expect((r as Response).status).toBe(409);
    const body = await (r as Response).json();
    expect(body.error).toBe('IDEMPOTENT_NOOP');
  });

  it('4. returns 400 REASON_REQUIRED when reason missing', async () => {
    withAdmin();
    const r = await freezePost(jsonReq({}), ctx());
    expect((r as Response).status).toBe(400);
    const body = await (r as Response).json();
    expect(body.error).toBe('REASON_REQUIRED');
  });

  it('5. happy path freeze writes UPDATE + audit row', async () => {
    withAdmin();
    dbExecute
      .mockResolvedValueOnce({
        rows: [{ id: MODEL_ID, slug: 'gpt-4', status: 'live' }],
      }) // SELECT
      .mockResolvedValueOnce({ rows: [] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }); // audit
    const r = await freezePost(jsonReq({ reason: 'high error rate' }), ctx());
    expect((r as Response).status).toBe(200);
    expect(dbExecute).toHaveBeenCalledTimes(3);
    // Check UPDATE used status='frozen'
    const updateCall = dbExecute.mock.calls[1][0] as { raw?: string };
    expect(String(updateCall.raw ?? '')).toContain("status='frozen'");
    // Check audit had model.freeze action
    const auditCall = dbExecute.mock.calls[2][0] as {
      raw?: string;
      values?: unknown[];
    };
    expect(JSON.stringify(auditCall.values)).toContain('model.freeze');
  });
});

describe('/api/admin/models/[id]/depublish', () => {
  beforeEach(() => vi.clearAllMocks());

  it('6a. happy path: depublish from live writes UPDATE + audit', async () => {
    withAdmin();
    dbExecute
      .mockResolvedValueOnce({
        rows: [{ id: MODEL_ID, slug: 'gpt-4', status: 'live' }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const r = await depublishPost(
      jsonReq({ reason: 'EOL' }),
      ctx()
    );
    expect((r as Response).status).toBe(200);
    const updateCall = dbExecute.mock.calls[1][0] as { raw?: string };
    expect(String(updateCall.raw ?? '')).toContain("status='depublished'");
    const auditCall = dbExecute.mock.calls[2][0] as {
      values?: unknown[];
    };
    expect(JSON.stringify(auditCall.values)).toContain('model.depublish');
  });

  it('6b. happy path: depublish from frozen also allowed', async () => {
    withAdmin();
    dbExecute
      .mockResolvedValueOnce({
        rows: [{ id: MODEL_ID, slug: 'gpt-4', status: 'frozen' }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const r = await depublishPost(jsonReq({ reason: 'EOL' }), ctx());
    expect((r as Response).status).toBe(200);
  });

  it('6c. depublish from draft → 400 INVALID_TRANSITION', async () => {
    withAdmin();
    dbExecute.mockResolvedValueOnce({
      rows: [{ id: MODEL_ID, slug: 'gpt-4', status: 'draft' }],
    });
    const r = await depublishPost(jsonReq({ reason: 'x' }), ctx());
    expect((r as Response).status).toBe(400);
    const body = await (r as Response).json();
    expect(body.error).toBe('INVALID_TRANSITION');
  });

  it('6d. depublish when already depublished → 409 IDEMPOTENT_NOOP', async () => {
    withAdmin();
    dbExecute.mockResolvedValueOnce({
      rows: [{ id: MODEL_ID, slug: 'gpt-4', status: 'depublished' }],
    });
    const r = await depublishPost(jsonReq({ reason: 'x' }), ctx());
    expect((r as Response).status).toBe(409);
  });

  it('6e. reason required', async () => {
    withAdmin();
    const r = await depublishPost(jsonReq({}), ctx());
    expect((r as Response).status).toBe(400);
    const body = await (r as Response).json();
    expect(body.error).toBe('REASON_REQUIRED');
  });
});

// ---- Gateway middleware tests (B-3: NO cache) -----------------------------

describe('gateway model-status-check middleware', () => {
  it('7. checkModelStatus returns "frozen" → middleware would 503', async () => {
    const { checkModelStatus } = await import(
      '../../../../packages/api-gateway/src/middleware/model-status-check'
    );
    const fakeSql = (() => {
      const fn = vi.fn().mockResolvedValue([{ status: 'frozen' }]);
      return fn as unknown as typeof import('../../../../packages/api-gateway/src/lib/db').sql;
    })();
    const status = await checkModelStatus('gpt-4', fakeSql);
    expect(status).toBe('frozen');
  });

  it('8. checkModelStatus returns "live" → pass through', async () => {
    const { checkModelStatus } = await import(
      '../../../../packages/api-gateway/src/middleware/model-status-check'
    );
    const fakeSql = vi.fn().mockResolvedValue([{ status: 'live' }]) as unknown as typeof import('../../../../packages/api-gateway/src/lib/db').sql;
    const status = await checkModelStatus('gpt-4', fakeSql);
    expect(status).toBe('live');
  });

  it('9 (B-3). two consecutive lookups BOTH hit DB (no cache)', async () => {
    const { checkModelStatus } = await import(
      '../../../../packages/api-gateway/src/middleware/model-status-check'
    );
    const fake = vi.fn().mockResolvedValue([{ status: 'live' }]);
    const fakeSql = fake as unknown as typeof import('../../../../packages/api-gateway/src/lib/db').sql;
    await checkModelStatus('gpt-4', fakeSql);
    await checkModelStatus('gpt-4', fakeSql);
    expect(fake).toHaveBeenCalledTimes(2);
  });

  it('returns "unknown" when model row missing', async () => {
    const { checkModelStatus } = await import(
      '../../../../packages/api-gateway/src/middleware/model-status-check'
    );
    const fakeSql = vi.fn().mockResolvedValue([]) as unknown as typeof import('../../../../packages/api-gateway/src/lib/db').sql;
    const status = await checkModelStatus('absent', fakeSql);
    expect(status).toBe('unknown');
  });
});
