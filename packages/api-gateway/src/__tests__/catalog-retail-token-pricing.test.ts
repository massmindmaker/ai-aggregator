import { describe, expect, it } from 'vitest';
import { projectCatalogRetailTokenPricing } from '../catalog/retail-token-pricing';
import {
  calculateTokenCharge,
  quoteChatMaximum,
  type TokenPrices,
  type TokenUsage,
} from '../billing/token-quote';

function publicPrices(prices: TokenPrices, multiplier: string): TokenPrices {
  const projected = projectCatalogRetailTokenPricing(prices, multiplier);
  return {
    inputCentsPer1k: projected.rates.input.amount,
    outputCentsPer1k: projected.rates.output.amount,
    markup: '1',
  };
}

describe('catalog retail token pricing', () => {
  it.each([
    [{ inputCentsPer1k: '0.0000000001', outputCentsPer1k: '1.25', markup: '1.8' }, '0.00000000018', '2.25'],
    [{ inputCentsPer1k: '2', outputCentsPer1k: '1', markup: '1' }, '2', '1'],
    [{ inputCentsPer1k: '0', outputCentsPer1k: '0', markup: '1.000000000000000001' }, '0', '0'],
    [{ inputCentsPer1k: '999999999999999999.999999999999999999', outputCentsPer1k: '0', markup: '0.000000000000000001' }, '0.999999999999999999999999999999999999', '0'],
  ] as const)('multiplies exact DB decimals without Number: %j', (prices, input, output) => {
    const projected = projectCatalogRetailTokenPricing(prices, '0.5');
    expect(projected.rates.input.amount).toBe(input);
    expect(projected.rates.output.amount).toBe(output);
    expect(JSON.stringify(projected)).not.toContain('inputCentsPer1k');
    expect(JSON.stringify(projected)).not.toContain('markup');
  });

  const priceVectors: readonly TokenPrices[] = [
    { inputCentsPer1k: '0.5', outputCentsPer1k: '0', markup: '1' },
    { inputCentsPer1k: '0.000000001', outputCentsPer1k: '0', markup: '1.000000001' },
    { inputCentsPer1k: '1.25', outputCentsPer1k: '3.75', markup: '1.8' },
    { inputCentsPer1k: '2', outputCentsPer1k: '1', markup: '1.125' },
  ];
  const usages: readonly TokenUsage[] = [
    { promptTokens: 1, completionTokens: 0, cachedInputTokens: 0 },
    { promptTokens: 100, completionTokens: 50, cachedInputTokens: 50 },
    { promptTokens: 0, completionTokens: 1, cachedInputTokens: 0 },
    { promptTokens: Number.MAX_SAFE_INTEGER, completionTokens: 0, cachedInputTokens: 0 },
  ];

  it.each(['0', '1', '0.5'] as const)(
    'reproduces accepted whole-cost half-up actual charge with cache multiplier %s',
    (multiplier) => {
      for (const prices of priceVectors) {
        for (const usage of usages) {
          expect(
            calculateTokenCharge(publicPrices(prices, multiplier), usage, multiplier),
          ).toBe(calculateTokenCharge(prices, usage, multiplier));
        }
      }
    },
  );

  it('reproduces accepted maximum ceil including output below input and values beyond 2^53', () => {
    for (const prices of priceVectors) {
      const projected = publicPrices(prices, '0.5');
      for (const [context, cap] of [
        [128_000, 16_384],
        [Number.MAX_SAFE_INTEGER, 1],
      ] as const) {
        expect(quoteChatMaximum(projected, context, cap)).toBe(
          quoteChatMaximum(prices, context, cap),
        );
      }
    }
  });

  it('revisions only the public exact terms and fails closed on invalid inputs', () => {
    const a = projectCatalogRetailTokenPricing(
      { inputCentsPer1k: '1', outputCentsPer1k: '2', markup: '2' },
      '0.5',
    );
    const b = projectCatalogRetailTokenPricing(
      { inputCentsPer1k: '2', outputCentsPer1k: '4', markup: '1' },
      '0.5',
    );
    expect(a).toEqual(b);
    expect(a.revision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => projectCatalogRetailTokenPricing(
      { inputCentsPer1k: '01', outputCentsPer1k: '0', markup: '1' },
      '0.5',
    )).toThrow();
    expect(() => projectCatalogRetailTokenPricing(
      { inputCentsPer1k: '1', outputCentsPer1k: '0', markup: '0' },
      '0.5',
    )).toThrow();
  });
});
