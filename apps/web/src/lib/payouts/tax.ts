/**
 * Phase 14-04 — pure tax calculator for author payouts.
 *
 * Tax models per spec §6:
 *   - self_employed (НПД): AIAG withholds 0%; author pays НПД (4% / 6%) themselves via «Мой налог».
 *   - ip (ИП на УСН):       AIAG withholds 0%; author pays УСН themselves.
 *   - individual (физлицо): AIAG withholds 13% НДФЛ as tax agent.
 *
 * Pure function, no DB / IO — fully unit-testable.
 */

export type KycType = 'self_employed' | 'ip' | 'individual';

export interface TaxResult {
  /** Amount withheld by AIAG (acting as tax agent for физлицо). 0 for НПД/ИП. */
  tax_withheld_rub: number;
  /** Amount actually transferred to the author's bank account. */
  net_rub: number;
  /** Effective withholding percentage applied. */
  withholding_pct: number;
}

// Spec §6: only kyc_type === 'individual' (физлицо) is taxed at 13% НДФЛ
// (AIAG acts as tax agent). Self-employed and IP authors pay their own taxes.
const WITHHOLDING_PCT: Record<KycType, number> = {
  self_employed: 0,
  ip: 0,
  individual: 13,
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function calculateTax(
  amount_rub: number,
  kyc_type: KycType | null
): TaxResult {
  if (kyc_type == null) throw new Error('KYC_TYPE_REQUIRED');
  if (!Number.isFinite(amount_rub) || amount_rub <= 0) {
    throw new Error('INVALID_AMOUNT');
  }
  const pct = WITHHOLDING_PCT[kyc_type];
  if (pct === undefined) throw new Error('UNKNOWN_KYC_TYPE');

  const tax = round2(amount_rub * (pct / 100));
  const net = round2(amount_rub - tax);

  return {
    tax_withheld_rub: tax,
    net_rub: net,
    withholding_pct: pct,
  };
}
