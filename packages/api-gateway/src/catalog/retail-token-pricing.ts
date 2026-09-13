import { createHash } from 'node:crypto';
import type { CatalogRetailTokenPricingV1 } from '@aiag/shared/catalog-contract';
import {
  calculateTokenCharge,
  quoteChatMaximum,
  type TokenPrices,
} from '../billing/token-quote';

const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const MAX_DIGITS = 38;
const MAX_FRACTION_DIGITS = 18;

function parseDecimal(value: string, positive: boolean): { digits: bigint; scale: number } {
  if (typeof value !== 'string' || !DECIMAL.test(value))
    throw new TypeError('Invalid exact pricing decimal');
  const [integer, fraction = ''] = value.split('.');
  if (
    fraction.length > MAX_FRACTION_DIGITS ||
    integer!.length + fraction.length > MAX_DIGITS
  )
    throw new RangeError('Exact pricing decimal exceeds supported precision');
  const digits = BigInt(integer! + fraction);
  if (positive && digits === 0n)
    throw new RangeError('Exact pricing multiplier must be positive');
  return { digits, scale: fraction.length };
}

function normalizeProduct(left: string, right: string): string {
  const a = parseDecimal(left, false);
  const b = parseDecimal(right, true);
  const product = a.digits * b.digits;
  if (product === 0n) return '0';
  const scale = a.scale + b.scale;
  let digits = product.toString();
  if (scale === 0) return digits;
  digits = digits.padStart(scale + 1, '0');
  const split = digits.length - scale;
  const normalized = `${digits.slice(0, split)}.${digits.slice(split)}`
    .replace(/0+$/, '')
    .replace(/\.$/, '');
  if (normalized.length > 128)
    throw new RangeError('Public pricing decimal exceeds contract bound');
  return normalized;
}

function revision(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

/**
 * Projects the existing admission tariff into exact public microcredits/token.
 * Supplier prices and markup are consumed only as inputs and never retained.
 */
export function projectCatalogRetailTokenPricing(
  prices: TokenPrices,
  cachingMultiplier: string,
): CatalogRetailTokenPricingV1 {
  // Reuse both existing exact parsers and their PostgreSQL BIGINT authority.
  quoteChatMaximum(prices, 1, 1);
  calculateTokenCharge(
    prices,
    { promptTokens: 0, completionTokens: 0, cachedInputTokens: 0 },
    cachingMultiplier,
  );

  const publicTerms = Object.freeze({
    currency: 'USD' as const,
    settlementUnit: 'microcredit' as const,
    microcreditsPerUsdCent: '1000' as const,
    rates: Object.freeze({
      input: Object.freeze({
        amount: normalizeProduct(prices.inputCentsPer1k, prices.markup),
        unit: 'microcredit_per_token' as const,
      }),
      output: Object.freeze({
        amount: normalizeProduct(prices.outputCentsPer1k, prices.markup),
        unit: 'microcredit_per_token' as const,
      }),
    }),
    actualCharge: Object.freeze({
      formulaVersion:
        'db-input-output-cents-per-1k-legacy-whole-cache-v1' as const,
      cachePolicy: Object.freeze({
        scope: 'whole_input_plus_output_cost' as const,
        multiplier: cachingMultiplier,
        factorFormula:
          'prompt=0?1:((prompt-cached)+cached*multiplier)/prompt' as const,
      }),
      rounding: 'nearest_nonnegative_half_up_once_to_microcredit' as const,
    }),
    maximumAuthorization: Object.freeze({
      formula:
        'input_rate*context+max(output_rate-input_rate,0)*max_output' as const,
      rounding: 'ceil_once_to_microcredit' as const,
    }),
    quoteSemantics: 'terms_only_quote_created_at_admission' as const,
  });

  return Object.freeze({ revision: revision(publicTerms), ...publicTerms });
}
