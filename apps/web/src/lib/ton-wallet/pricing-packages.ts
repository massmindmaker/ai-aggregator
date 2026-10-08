import type { TonCheckoutPolicy } from '@aiag/database';
import { activeCheckoutPolicy } from './checkout-policy-source';

/**
 * Storefront pricing view over the active TON checkout policy (Gram-storefront
 * plan, task 3). Pure BigInt math mirrors `convertAtomic`/`createQuote` from
 * `@aiag/shared/ton-payment-contract`, so displayed prices always match the
 * invoiced amount for the same fx snapshot.
 */

export interface GramPackageView {
  id: string;
  label: string;
  /** Human-readable credit amount, e.g. "10 000". */
  credits: string;
  /** BigInt nanoTON as a string — safe to render through formatGrams/formatNano. */
  amountAtomic: string;
  /** Display grams, e.g. "20" or "0.2" — derived via formatGrams. */
  grams: string;
}

export interface GramPricingView {
  packages: GramPackageView[];
  /** policy.fx.source */
  fxSource: string;
  fxExpiresAtMs: number;
  /** fx.expiresAtMs <= now */
  stale: boolean;
  /** policy.network === 'tvm:-3' */
  testnet: boolean;
}

const NANO: bigint = 1_000_000_000n;

/**
 * Same rounding contract as convertAtomic in ton-payment-contract.ts:
 * BigInt division with explicit ceil / floor / half-up on the remainder.
 * Policy values are zod-bounded (<= signed 64-bit) before they get here.
 */
function convertGrantAtomic(grantMicrocredits: string, fx: TonCheckoutPolicy['fx']): bigint {
  const amount = BigInt(grantMicrocredits);
  const numerator = BigInt(fx.numerator);
  const denominator = BigInt(fx.denominator);
  const product = amount * numerator;
  const quotient = product / denominator;
  const remainder = product % denominator;
  const roundUp = fx.rounding === 'ceil'
    ? remainder > 0n
    : fx.rounding === 'half-up' && remainder >= denominator - remainder;
  return quotient + (roundUp ? 1n : 0n);
}

/** Group the integer part with spaces: 10000 -> "10 000"; keeps sub-credit remainder. */
function formatCredits(grantMicrocredits: string): string {
  const micro = BigInt(grantMicrocredits);
  const grouped = (micro / 1000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const rest = micro % 1000n;
  if (rest === 0n) return grouped;
  return `${grouped},${rest.toString().padStart(3, '0').replace(/0+$/, '')}`;
}

/**
 * formatNano scheme from TonWalletPanel.tsx:113 — BigInt division by 1e9,
 * remainder padded to 9 digits with trailing zeros trimmed; amounts below one
 * gram keep the "0." prefix (e.g. "0.2"). No float/toFixed anywhere.
 */
export function formatGrams(amountAtomic: string): string {
  if (!/^\d+$/.test(amountAtomic)) return '—';
  const value = BigInt(amountAtomic);
  const fraction = (value % NANO).toString().padStart(9, '0').replace(/0+$/, '');
  return (value / NANO).toString() + (fraction ? `.${fraction}` : '');
}

/** Pure, testable projection of a parsed policy into display-ready packages. */
export function buildGramPricingView(policy: TonCheckoutPolicy, nowMs?: number): GramPricingView {
  const now = nowMs ?? Date.now();
  const fee = BigInt(policy.additionalFeeAtomic);
  const packages: GramPackageView[] = policy.packages.map((pkg) => {
    const amountAtomic = convertGrantAtomic(pkg.grantMicrocredits, policy.fx) + fee;
    const amountAtomicText = amountAtomic.toString();
    return {
      id: pkg.id,
      label: pkg.label,
      credits: formatCredits(pkg.grantMicrocredits),
      amountAtomic: amountAtomicText,
      grams: formatGrams(amountAtomicText),
    };
  });
  return {
    packages,
    fxSource: policy.fx.source,
    fxExpiresAtMs: policy.fx.expiresAtMs,
    stale: policy.fx.expiresAtMs <= now,
    testnet: policy.network === 'tvm:-3',
  };
}

/** Never throws: null when the policy is missing or fails validation. */
export async function readGramPricing(): Promise<GramPricingView | null> {
  try {
    const policy = await activeCheckoutPolicy();
    return buildGramPricingView(policy, Date.now());
  } catch {
    return null;
  }
}
