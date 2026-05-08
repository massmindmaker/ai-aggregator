/**
 * Phase 14-04 Task 1 — pure tax calculator unit tests.
 * Spec §6: НПД (self_employed) → 0%, ИП (ip) → 0%, физлицо (individual) → 13% НДФЛ.
 */
import { describe, it, expect } from 'vitest';
import { calculateTax } from '@/lib/payouts/tax';

describe('calculateTax', () => {
  it('self_employed (НПД) — withholds 0%, net == amount', () => {
    expect(calculateTax(10000, 'self_employed')).toEqual({
      tax_withheld_rub: 0,
      net_rub: 10000,
      withholding_pct: 0,
    });
  });

  it('ip (ИП) — withholds 0%, author pays own taxes', () => {
    expect(calculateTax(10000, 'ip')).toEqual({
      tax_withheld_rub: 0,
      net_rub: 10000,
      withholding_pct: 0,
    });
  });

  it('individual (физлицо) — withholds 13% НДФЛ', () => {
    expect(calculateTax(10000, 'individual')).toEqual({
      tax_withheld_rub: 1300,
      net_rub: 8700,
      withholding_pct: 13,
    });
  });

  it('throws KYC_TYPE_REQUIRED when kyc_type is null', () => {
    expect(() => calculateTax(10000, null)).toThrow('KYC_TYPE_REQUIRED');
  });

  it('throws INVALID_AMOUNT for non-positive amount', () => {
    expect(() => calculateTax(0, 'individual')).toThrow('INVALID_AMOUNT');
    expect(() => calculateTax(-50, 'individual')).toThrow('INVALID_AMOUNT');
    expect(() => calculateTax(NaN, 'individual')).toThrow('INVALID_AMOUNT');
  });

  it('rounds to kopecks (2dp) for individual at 12345.67', () => {
    // 12345.67 * 0.13 = 1604.9371 → round to 1604.94
    // net = 12345.67 - 1604.94 = 10740.73
    expect(calculateTax(12345.67, 'individual')).toEqual({
      tax_withheld_rub: 1604.94,
      net_rub: 10740.73,
      withholding_pct: 13,
    });
  });
});
