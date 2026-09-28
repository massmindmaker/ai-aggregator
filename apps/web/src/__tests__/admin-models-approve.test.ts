import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ execute: vi.fn(), transaction: vi.fn(), audit: vi.fn() }));
vi.mock('@/lib/db', () => ({
  db: { execute: mocks.execute, transaction: mocks.transaction },
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ text: strings.join('?'), values }),
}));
vi.mock('@/lib/admin/api', () => ({ withAdmin: async (fn: (ctx: unknown) => unknown) => fn({ user: { email: 'admin@example.test' } }) }));
vi.mock('@/lib/admin/guard', () => ({ audit: mocks.audit }));
import { POST } from '../app/api/admin/models/[id]/approve/route';
const id = '00000000-0000-4000-8000-000000000002';
const row = { id, slug: 'example-model', status: 'draft', review_state: 'pending', author_user_id: null, has_author_version: false };
const call = (modelId = id) => POST(new Request('http://localhost/api/admin/models/' + modelId + '/approve', { method: 'POST' }), { params: Promise.resolve({ id: modelId }) });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(async (fn) => fn({ execute: mocks.execute }));
  mocks.execute.mockResolvedValue({ rows: [] });
});
describe('legacy model approval cannot bypass author version review', () => {
  it.each([
    { ...row, author_user_id: '00000000-0000-4000-8000-000000000003' },
    { ...row, has_author_version: true },
  ])('blocks authored candidate without changing the model or audit', async (candidate) => {
    mocks.execute.mockResolvedValueOnce({ rows: [candidate] });
    const response = await call();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'AUTHOR_VERSION_REVIEW_REQUIRED' });
    expect(mocks.execute.mock.calls.some(([q]) => /UPDATE models/.test(q.text))).toBe(false);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('rejects malformed model ID before querying DB', async () => {
    expect((await call('not-a-uuid')).status).toBe(400);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('requires a successful guarded update rather than returning false success', async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [] });
    expect((await call()).status).toBe(409);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('keeps approved legacy model and mandatory audit in the same transaction', async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [{ id }] });
    expect((await call()).status).toBe(200);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    const queries = mocks.execute.mock.calls.map(([q]) => q.text as string);
    expect(queries[0]).toContain('FOR UPDATE');
    expect(queries[1]).toContain('author_user_id IS NULL');
    expect(queries[1]).toContain('RETURNING');
    expect(queries[2]).toContain('INSERT INTO audit_log');
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
