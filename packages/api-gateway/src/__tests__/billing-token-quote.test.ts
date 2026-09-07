import { describe, expect, it } from 'vitest';
import {
  calculateByokFee,
  calculateTokenCharge,
  microCreditsToUsdMicroString,
  quoteChatMaximum,
  quoteEmbeddingMaximum,
} from '../billing/token-quote';

const prices = {
  inputCentsPer1k: '0.015',
  outputCentsPer1k: '0.06',
  markup: '1.3',
} as const;

describe('billing/token-quote', () => {
  it('ceilings the bounded chat maximum, including the output<input branch', () => {
    expect(quoteChatMaximum(prices, 128_000, 4096)).toBe(2736n);
    expect(quoteChatMaximum({ inputCentsPer1k: '2', outputCentsPer1k: '1', markup: '1' }, 100, 25)).toBe(200n);
  });

  it('ceilings an embedding maximum for every input', () => {
    expect(quoteEmbeddingMaximum({ inputCentsPer1k: '0.015', outputCentsPer1k: '0', markup: '1.3' }, 100, 3)).toBe(6n);
  });

  it('rounds actual token charges once, to nearest nonnegative half up', () => {
    expect(calculateTokenCharge(prices, { promptTokens: 100, completionTokens: 20, cachedInputTokens: 0 }, '1')).toBe(4n);
    expect(calculateTokenCharge({ inputCentsPer1k: '0.5', outputCentsPer1k: '0', markup: '1' }, { promptTokens: 1, completionTokens: 0, cachedInputTokens: 0 }, '1')).toBe(1n);
  });

  it('preserves the legacy whole-cost cached fraction formula', () => {
    expect(calculateTokenCharge({ inputCentsPer1k: '1', outputCentsPer1k: '2', markup: '1' }, { promptTokens: 100, completionTokens: 50, cachedInputTokens: 50 }, '0.5')).toBe(150n);
  });

  it('keeps legitimate tiny and zero tariffs at zero', () => {
    expect(calculateTokenCharge({ inputCentsPer1k: '0.0001', outputCentsPer1k: '0', markup: '1' }, { promptTokens: 1, completionTokens: 0, cachedInputTokens: 0 }, '1')).toBe(0n);
    expect(quoteChatMaximum({ inputCentsPer1k: '0', outputCentsPer1k: '0', markup: '1' }, 1, 1)).toBe(0n);
    expect(calculateByokFee('0')).toBe(0n);
  });

  it('scales fractional BYOK fees and rounds their micro-credit half boundary', () => {
    expect(calculateByokFee('1.2345')).toBe(1235n);
    expect(calculateByokFee('0.0004')).toBe(0n);
    expect(calculateByokFee('0.0005')).toBe(1n);
  });

  it('performs header conversion exactly beyond Number.MAX_SAFE_INTEGER', () => {
    expect(microCreditsToUsdMicroString(0n)).toBe('0');
    expect(microCreditsToUsdMicroString(123n)).toBe('1230');
    expect(microCreditsToUsdMicroString(9007199254740993n)).toBe('90071992547409930');
  });

  it('handles a high-precision decimal boundary without floating point', () => {
    expect(calculateTokenCharge({ inputCentsPer1k: '0.000000000000000001', outputCentsPer1k: '0', markup: '1.000000000000000001' }, { promptTokens: 9_007_199_254_740_991, completionTokens: 0, cachedInputTokens: 0 }, '1')).toBe(0n);
  });

  it.each([
    ['inputCentsPer1k', '-1'],
    ['inputCentsPer1k', '+1'],
    ['inputCentsPer1k', '01'],
    ['inputCentsPer1k', '.1'],
    ['inputCentsPer1k', '1.'],
    ['inputCentsPer1k', '1e2'],
    ['inputCentsPer1k', ' 1'],
    ['inputCentsPer1k', ''],
    ['inputCentsPer1k', 'NaN'],
    ['inputCentsPer1k', '0.0000000000000000001'],
    ['inputCentsPer1k', '123456789012345678901234567890123456789'],
  ] as const)('rejects non-canonical price %s=%s', (field, value) => {
    expect(() => quoteChatMaximum({ ...prices, [field]: value }, 1, 1)).toThrow();
  });

  it('rejects invalid financial ranges and overflowing results', () => {
    expect(() => quoteChatMaximum({ ...prices, markup: '0' }, 1, 1)).toThrow();
    expect(() => quoteChatMaximum({ ...prices, markup: '0.000000000000000000' }, 1, 1)).toThrow();
    expect(() => calculateTokenCharge(prices, { promptTokens: 1, completionTokens: 0, cachedInputTokens: 0 }, '-0.1')).toThrow();
    expect(() => calculateTokenCharge(prices, { promptTokens: 1, completionTokens: 0, cachedInputTokens: 0 }, '1.000000000000000001')).toThrow();
    expect(() => quoteChatMaximum({ inputCentsPer1k: '99999999999999999999999999999999999999', outputCentsPer1k: '0', markup: '1' }, Number.MAX_SAFE_INTEGER, 1)).toThrow();
  });

  it('rejects invalid token bounds and does not mutate inputs', () => {
    const mutablePrices = { ...prices };
    const usage = { promptTokens: 1, completionTokens: 0, cachedInputTokens: 0 };
    calculateTokenCharge(mutablePrices, usage, '1');
    expect(mutablePrices).toEqual(prices);
    expect(usage).toEqual({ promptTokens: 1, completionTokens: 0, cachedInputTokens: 0 });

    expect(() => quoteChatMaximum(prices, 1, 2)).toThrow();
    expect(() => quoteChatMaximum(prices, 0, 0)).toThrow();
    expect(() => quoteEmbeddingMaximum(prices, 1, 0)).toThrow();
    expect(() => quoteEmbeddingMaximum(prices, Number.MAX_SAFE_INTEGER + 1, 1)).toThrow();
    expect(() => calculateTokenCharge(prices, { promptTokens: -1, completionTokens: 0, cachedInputTokens: 0 }, '1')).toThrow();
    expect(() => calculateTokenCharge(prices, { promptTokens: 1, completionTokens: 0, cachedInputTokens: 2 }, '1')).toThrow();
  });
});
