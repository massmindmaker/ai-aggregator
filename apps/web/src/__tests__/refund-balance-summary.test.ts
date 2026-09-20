import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn() }));

const dbExecute = vi.fn();
vi.mock('@/lib/db', () => ({
  db: { execute: (...args: unknown[]) => dbExecute(...args) },
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    raw: strings.raw.join(' '),
    values,
  }),
}));

const getOrCreateDefaultOrg = vi.fn();
vi.mock('@/lib/dashboard/org', () => ({
  getOrCreateDefaultOrg: (...args: unknown[]) => getOrCreateDefaultOrg(...args),
}));

import { auth } from '@/auth';
import { GET } from '@/app/api/dashboard/billing/summary/route';

const mockedAuth = auth as unknown as ReturnType<typeof vi.fn>;

function mockSummaryRows(balance: {
  subscription_credits: string;
  payg_credits: string;
  refund_debt_credits: string;
  refund_pending: boolean;
}) {
  dbExecute.mockImplementation((query: { raw: string }) => {
    if (query.raw.includes('FROM subscriptions')) return Promise.resolve({ rows: [] });
    return Promise.resolve({ rows: [balance] });
  });
}

describe('GET /api/dashboard/billing/summary refund balance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAuth.mockResolvedValue({ user: { id: 'user-1' } });
    getOrCreateDefaultOrg.mockResolvedValue('org-current');
  });

  it.each([
    { debt: '0', pending: false, spendable: 3.5 },
    { debt: '250', pending: false, spendable: 0 },
    { debt: '0', pending: true, spendable: 0 },
    { debt: '250', pending: true, spendable: 0 },
  ])('reports underlying balances with debt=$debt pending=$pending', async ({ debt, pending, spendable }) => {
    mockSummaryRows({
      subscription_credits: '1500',
      payg_credits: '2000',
      refund_debt_credits: debt,
      refund_pending: pending,
    });

    const response = await GET();
    const body = await response.json();

    expect(body.balance).toEqual({
      subscriptionCredits: 1.5,
      paygCredits: 2,
      refundDebtCredits: Number(debt) / 1000,
      refundPending: pending,
      totalSpendableCredits: spendable,
    });
  });

  it('scopes the pending-claim EXISTS to the current organization in the balance snapshot', async () => {
    mockSummaryRows({
      subscription_credits: '0',
      payg_credits: '1000',
      refund_debt_credits: '0',
      refund_pending: false,
    });

    await GET();

    const balanceQuery = dbExecute.mock.calls
      .map(([query]) => query as { raw: string; values: unknown[] })
      .find((query) => query.raw.includes('FROM organizations'));
    expect(balanceQuery?.values).toContain('org-current');
    expect(balanceQuery?.raw).toContain('topup_org_id = organizations.id');
    expect(balanceQuery?.raw).toContain('refund_claim_id IS NOT NULL');
  });

  it.each(['subscription query failure', 'missing organization row'])('fails closed on %s', async (failure) => {
    dbExecute.mockImplementation((query: { raw: string }) => {
      if (query.raw.includes('FROM subscriptions')) {
        return failure === 'subscription query failure'
          ? Promise.reject(new Error('database unavailable'))
          : Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'billing_summary_unavailable' });
  });
});
