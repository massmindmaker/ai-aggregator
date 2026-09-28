import { isValidElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ execute: vi.fn(), transaction: vi.fn(), requireAdmin: vi.fn() }));
vi.mock('@/lib/db', () => ({
  db: { execute: mocks.execute, transaction: mocks.transaction },
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ text: strings.join('?'), values }),
}));
vi.mock('@/lib/admin/guard', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('not found'); },
  redirect: () => { throw new Error('redirect'); },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../app/admin/models/[slug]/edit/ModelStatusActions', () => ({ ModelStatusActions: () => null }));
vi.mock('../app/admin/models/[slug]/edit/_components/ImageUpload', () => ({ ImageUpload: () => null }));
import Page from '../app/admin/models/[slug]/edit/page';
import NewModelPage from '../app/admin/models/new/page';
const model = {
  id: '00000000-0000-4000-8000-000000000002', slug: 'example-model', type: 'chat',
  enabled: false, display_name: 'Example', description: 'Example model', status: 'draft',
  frozen_reason: null, depublished_reason: null, image_url: null,
  author_user_id: null, has_author_version: false,
};
type Action = (data: FormData) => Promise<void>;
function actionsFrom(node: unknown, result: Map<string, Action> = new Map()): Map<string, Action> {
  if (Array.isArray(node)) { node.forEach((item) => actionsFrom(item, result)); return result; }
  if (!isValidElement(node)) return result;
  const props = node.props as { children?: unknown; action?: Action; formAction?: Action };
  const action = props.action ?? props.formAction;
  if (typeof action === 'function') result.set(action.name, action);
  actionsFrom(props.children, result);
  return result;
}
async function pageActions() {
  mocks.execute.mockResolvedValueOnce({ rows: [model] })
    .mockResolvedValueOnce({ rows: [{ id: 'route-1', upstream_id: 'provider', upstream_model_id: 'test' }] })
    .mockResolvedValueOnce({ rows: [{ id: 'provider', provider: 'openai' }] });
  return actionsFrom(await Page({ params: Promise.resolve({ slug: model.slug }) }));
}
function input() {
  const data = new FormData();
  data.set('enabled', 'on'); data.set('type', 'chat'); data.set('display_name', 'Example');
  data.set('description', 'Example model'); data.set('upstream_id', 'provider');
  data.set('upstream_model_id', 'test'); data.set('id', 'route-1');
  return data;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireAdmin.mockResolvedValue({ user: { id: 'admin', email: 'admin@example.test' } });
  mocks.execute.mockResolvedValue({ rows: [] });
  mocks.transaction.mockImplementation(async (run) => run({ execute: mocks.execute }));
});
describe('admin model edit server action authorization', () => {
  it.each(['updateModel', 'disableModel', 'addUpstream', 'deleteUpstream'])(
    '%s rechecks admin authorization at invocation rather than trusting page render', async (name) => {
      const actions = await pageActions();
      expect(actions.has(name)).toBe(true);
      mocks.execute.mockClear();
      mocks.requireAdmin.mockRejectedValueOnce(new Error('ADMIN_ACCESS_REVOKED'));
      await expect(actions.get(name)!(input())).rejects.toThrow('ADMIN_ACCESS_REVOKED');
      expect(mocks.execute).not.toHaveBeenCalled();
    },
  );
  it('guards the page data before queries even without its layout', async () => {
    mocks.requireAdmin.mockRejectedValueOnce(new Error('ADMIN_ACCESS_REVOKED'));
    await expect(Page({ params: Promise.resolve({ slug: model.slug }) })).rejects.toThrow('ADMIN_ACCESS_REVOKED');
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it.each(['updateModel', 'addUpstream', 'deleteUpstream'])(
    '%s cannot mutate an authored model through the legacy editor', async (name) => {
      const actions = await pageActions();
      mocks.execute.mockReset().mockResolvedValueOnce({ rows: [{ ...model, author_user_id: 'author', has_author_version: true }] });
      await expect(actions.get(name)!(input())).rejects.toThrow('AUTHOR_VERSION_REVIEW_REQUIRED');
      expect(mocks.execute.mock.calls.some(([q]) => /UPDATE models|INSERT INTO model_upstreams|DELETE FROM model_upstreams/.test(q.text))).toBe(false);
    },
  );
  it('binds upstream deletion to the displayed model', async () => {
    const actions = await pageActions();
    mocks.execute.mockReset().mockResolvedValueOnce({ rows: [model] }).mockResolvedValue({ rows: [] });
    await actions.get('deleteUpstream')!(input());
    const query = mocks.execute.mock.calls.find(([q]) => /DELETE FROM model_upstreams/.test(q.text))?.[0];
    expect(query?.text).toMatch(/model_id\s*=/);
    expect(query?.values).toContain(model.id);
  });
});


describe('new admin model action and form structure', () => {
  it('rechecks admin authorization when the create action is invoked', async () => {
    const actions = actionsFrom(await NewModelPage());
    mocks.requireAdmin.mockRejectedValueOnce(new Error('ADMIN_ACCESS_REVOKED'));
    const data = input(); data.set('slug', 'example-model');
    await expect(actions.get('createModel')!(data)).rejects.toThrow('ADMIN_ACCESS_REVOKED');
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('guards direct rendering of the create page', async () => {
    mocks.requireAdmin.mockRejectedValueOnce(new Error('ADMIN_ACCESS_REVOKED'));
    await expect(Promise.resolve().then(() => NewModelPage())).rejects.toThrow('ADMIN_ACCESS_REVOKED');
  });
  it('does not nest the disable form inside the update form', async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [model] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const tree = await Page({ params: Promise.resolve({ slug: model.slug }) });
    const nested: unknown[] = [];
    const visit = (node: unknown, inForm = false): void => {
      if (Array.isArray(node)) { node.forEach((item) => visit(item, inForm)); return; }
      if (!isValidElement(node)) return;
      if (node.type === 'form' && inForm) nested.push(node);
      visit((node.props as { children?: unknown }).children, inForm || node.type === 'form');
    };
    visit(tree);
    expect(nested).toHaveLength(0);
  });
});
