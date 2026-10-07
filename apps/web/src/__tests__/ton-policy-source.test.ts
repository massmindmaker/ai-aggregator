import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbExecute = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db', () => ({
  db: { execute: dbExecute },
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));

import { createCheckoutPolicySource } from '@/lib/ton-wallet/checkout-policy-source';

describe('TON checkout policy source: database first, env fallback (plan task 3.4)', () => {
  beforeEach(() => {
    dbExecute.mockReset();
    process.env.TON_CHECKOUT_POLICY = JSON.stringify({ env: true });
  });

  it('prefers the admin_settings row over the env variable', async () => {
    const dbPolicy = JSON.stringify({ from: 'database' });
    dbExecute.mockResolvedValueOnce({ rows: [{ value: { from: 'database' } }] });
    const source = await createCheckoutPolicySource();
    expect(source).toBe(dbPolicy);
    expect(source).not.toContain('env');
  });

  it('falls back to env when no admin_settings row exists', async () => {
    dbExecute.mockResolvedValueOnce({ rows: [] });
    const source = await createCheckoutPolicySource();
    expect(source).toBe(JSON.stringify({ env: true }));
  });

  it('falls back to env when the database read fails', async () => {
    dbExecute.mockRejectedValueOnce(new Error('db down'));
    const source = await createCheckoutPolicySource();
    expect(source).toBe(JSON.stringify({ env: true }));
  });
});
