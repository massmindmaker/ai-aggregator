import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQuote } from '@aiag/shared/ton-payment-contract';
import { buildGramPricingView, readGramPricing } from '@/lib/ton-wallet/pricing-packages';

const dbExecute = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db', () => ({
  db: { execute: dbExecute },
}));

const policy = (over: Record<string, unknown> = {}) => ({
  revision: 'rev-1', recipient: `0:${'1'.repeat(64)}`, network: 'tvm:-3',
  finalityPolicyId: 'f', verifierVersion: 'v',
  quoteLifetimeSeconds: 600, maxFxAgeSeconds: 300,
  fx: { numerator: '10000000000', denominator: '5000000', rounding: 'ceil', source: 'coingecko:the-open-network', observedAtMs: 1_000, expiresAtMs: 61_000 },
  additionalFeeAtomic: '0',
  packages: [
    { id: 'credit-600', label: 'Стартовый — 600 кредитов', grantMicrocredits: '600000' },
    { id: 'credit-10000', label: 'Pro — 10 000 кредитов', grantMicrocredits: '10000000' },
  ],
  ...over,
}) as never;

describe('gram pricing view (storefront plan, task 3)', () => {
  it('prices 1000 credits at 5 USD/TON as exactly 2.0 grams — same math as createQuote', () => {
    const view = buildGramPricingView(policy(), 30_000);
    const big = view.packages.find((p) => p.id === 'credit-10000')!;
    // 10_000_000 micro × 1e10 / 5e6 = 2e10 nanoTON = 20.0 grams
    expect(big.amountAtomic).toBe('20000000000');
    expect(big.grams).toBe('20');
  });
  it('marks the view stale when fx has expired and keeps packages visible', () => {
    const view = buildGramPricingView(policy(), 120_000);
    expect(view.stale).toBe(true);
    expect(view.packages).toHaveLength(2);
  });
  it('includes the additional fee in the displayed amount', () => {
    const withFee = policy({ additionalFeeAtomic: '150000000' }); // +0.15 grams
    const view = buildGramPricingView(withFee, 30_000);
    const start = view.packages.find((p) => p.id === 'credit-600')!;
    expect(BigInt(start.amountAtomic)).toBeGreaterThan(BigInt('1200000000'));
  });
  it('matches createQuote exactly on the same fixture', () => {
    const asset = { network: 'tvm:-3', kind: 'native', decimals: 9 } as const;
    const fx = {
      sourceUnit: 'gateway_microcredits',
      targetAsset: asset,
      numerator: '10000000000',
      denominator: '5000000',
      rounding: 'ceil',
      source: 'coingecko:the-open-network',
      observedAtMs: 1_000,
      expiresAtMs: 61_000,
    } as const;
    const view = buildGramPricingView(policy(), 30_000);
    const big = view.packages.find((p) => p.id === 'credit-10000')!;
    const quote = createQuote(
      {
        quoteId: 'q',
        sourcePrice: { unit: 'gateway_microcredits', amountAtomic: '10000000' },
        asset,
        fx,
        additionalFeeAtomic: '0',
        expiresAtMs: 60_000,
      },
      [asset],
      30_000,
    );
    expect(quote.amountAtomic).toBe('20000000000');
    expect(quote.amountAtomic).toBe(big.amountAtomic);
  });
  it('renders sub-gram amounts with a 0. prefix (formatNano scheme)', () => {
    // 100_000 micro × 1e10 / 5e6 = 2e8 nanoTON = 0.2 grams
    const small = policy({ packages: [{ id: 'credit-100', label: 'Мини — 100 кредитов', grantMicrocredits: '100000' }] });
    const view = buildGramPricingView(small, 30_000);
    expect(view.packages[0].amountAtomic).toBe('200000000');
    expect(view.packages[0].grams).toBe('0.2');
  });
  it('formats credits human-readably with space grouping', () => {
    const view = buildGramPricingView(policy(), 30_000);
    const big = view.packages.find((p) => p.id === 'credit-10000')!;
    expect(big.credits).toBe('10 000');
    expect(view.fxSource).toBe('coingecko:the-open-network');
    expect(view.fxExpiresAtMs).toBe(61_000);
    expect(view.testnet).toBe(true);
  });
});

describe('readGramPricing (never throws)', () => {
  beforeEach(() => {
    dbExecute.mockReset();
    dbExecute.mockResolvedValue({ rows: [] });
  });
  afterEach(() => {
    delete process.env.TON_CHECKOUT_POLICY;
  });

  it('returns null when the policy is unavailable or broken', async () => {
    process.env.TON_CHECKOUT_POLICY = 'not-json';
    await expect(readGramPricing()).resolves.toBeNull();
  });
  it('builds a fresh view from a valid env policy', async () => {
    process.env.TON_CHECKOUT_POLICY = JSON.stringify(
      policy({ fx: { numerator: '10000000000', denominator: '5000000', rounding: 'ceil', source: 'coingecko:the-open-network', observedAtMs: 1_000, expiresAtMs: Date.now() + 60_000 } }),
    );
    const view = await readGramPricing();
    expect(view).not.toBeNull();
    expect(view!.stale).toBe(false);
    expect(view!.packages).toHaveLength(2);
    expect(view!.packages[1].amountAtomic).toBe('20000000000');
  });
});
