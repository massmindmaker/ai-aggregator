/**
 * Exact billing arithmetic for the gateway admission boundary.
 *
 * Catalog prices are US cents per 1,000 tokens and balances are
 * micro-credits (1,000 per cent). Those factors cancel, so multiplying a
 * token count by a catalog price directly yields micro-credits before markup.
 */
export type TokenPrices = Readonly<{
  inputCentsPer1k: string;
  outputCentsPer1k: string;
  markup: string;
}>;

export type TokenUsage = Readonly<{
  promptTokens: number;
  completionTokens: number;
  cachedInputTokens: number;
}>;

type Rational = Readonly<{ numerator: bigint; denominator: bigint }>;

const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const MAX_DECIMAL_DIGITS = 38;
const MAX_DECIMAL_FRACTION_DIGITS = 18;
const ONE: Rational = { numerator: 1n, denominator: 1n };

function decimal(value: string, name: string): Rational {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a plain canonical nonnegative decimal`);
  }

  const [integer, fraction = ''] = value.split('.');
  if (fraction.length > MAX_DECIMAL_FRACTION_DIGITS || integer.length + fraction.length > MAX_DECIMAL_DIGITS) {
    throw new RangeError(`${name} exceeds the supported decimal precision`);
  }

  return {
    numerator: BigInt(integer + fraction),
    denominator: 10n ** BigInt(fraction.length),
  };
}

function assertPositive(value: Rational, name: string): Rational {
  if (value.numerator <= 0n) throw new RangeError(`${name} must be greater than zero`);
  return value;
}

function add(left: Rational, right: Rational): Rational {
  return {
    numerator: left.numerator * right.denominator + right.numerator * left.denominator,
    denominator: left.denominator * right.denominator,
  };
}

function subtractNonnegative(left: Rational, right: Rational): Rational {
  const numerator = left.numerator * right.denominator - right.numerator * left.denominator;
  if (numerator < 0n) return { numerator: 0n, denominator: 1n };
  return { numerator, denominator: left.denominator * right.denominator };
}

function multiply(left: Rational, right: Rational): Rational {
  return {
    numerator: left.numerator * right.numerator,
    denominator: left.denominator * right.denominator,
  };
}

function multiplyInteger(value: Rational, multiplier: number): Rational {
  return { numerator: value.numerator * BigInt(multiplier), denominator: value.denominator };
}

function ceiling(value: Rational): bigint {
  return (value.numerator + value.denominator - 1n) / value.denominator;
}

function nearestNonnegativeHalfUp(value: Rational): bigint {
  return (value.numerator * 2n + value.denominator) / (value.denominator * 2n);
}

function checkedMoney(amount: bigint): bigint {
  if (amount < 0n || amount > POSTGRES_BIGINT_MAX) {
    throw new RangeError('monetary amount exceeds PostgreSQL signed BIGINT');
  }
  return amount;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonnegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a nonnegative safe integer`);
  }
  return value;
}

function parsePrices(prices: TokenPrices): Readonly<{ input: Rational; output: Rational; markup: Rational }> {
  const input = decimal(prices.inputCentsPer1k, 'inputCentsPer1k');
  const output = decimal(prices.outputCentsPer1k, 'outputCentsPer1k');
  const markup = assertPositive(decimal(prices.markup, 'markup'), 'markup');
  return { input, output, markup };
}

/** Returns the immutable upper bound when the caller has enforced its context/cap invariant. */
export function quoteChatMaximum(prices: TokenPrices, contextWindowTokens: number, maxOutputTokens: number): bigint {
  const context = positiveSafeInteger(contextWindowTokens, 'contextWindowTokens');
  const cap = positiveSafeInteger(maxOutputTokens, 'maxOutputTokens');
  if (cap > context) throw new RangeError('maxOutputTokens cannot exceed contextWindowTokens');

  const { input, output, markup } = parsePrices(prices);
  const beforeMarkup = add(multiplyInteger(input, context), multiplyInteger(subtractNonnegative(output, input), cap));
  return checkedMoney(ceiling(multiply(beforeMarkup, markup)));
}

/** Returns the immutable upper bound for an embedding request with inputCount independent inputs. */
export function quoteEmbeddingMaximum(prices: TokenPrices, contextWindowTokens: number, inputCount: number): bigint {
  const context = positiveSafeInteger(contextWindowTokens, 'contextWindowTokens');
  const count = positiveSafeInteger(inputCount, 'inputCount');
  const { input, markup } = parsePrices(prices);
  return checkedMoney(ceiling(multiply(multiplyInteger(multiplyInteger(input, context), count), markup)));
}

/**
 * Calculates actual usage with the legacy cache factor applied to the whole
 * input-plus-output cost. A tariff change to input-only caching needs a
 * separately versioned billing policy.
 */
export function calculateTokenCharge(prices: TokenPrices, usage: TokenUsage, cachingDiscount: string): bigint {
  const prompt = nonnegativeSafeInteger(usage.promptTokens, 'promptTokens');
  const completion = nonnegativeSafeInteger(usage.completionTokens, 'completionTokens');
  const cached = nonnegativeSafeInteger(usage.cachedInputTokens, 'cachedInputTokens');
  if (cached > prompt) throw new RangeError('cachedInputTokens cannot exceed promptTokens');

  const discount = decimal(cachingDiscount, 'cachingDiscount');
  if (discount.numerator > discount.denominator) throw new RangeError('cachingDiscount must be between zero and one');

  const { input, output, markup } = parsePrices(prices);
  const base = add(multiplyInteger(input, prompt), multiplyInteger(output, completion));
  const cacheFactor = prompt === 0
    ? ONE
    : {
      numerator: BigInt(prompt - cached) * discount.denominator + BigInt(cached) * discount.numerator,
      denominator: BigInt(prompt) * discount.denominator,
    };

  return checkedMoney(nearestNonnegativeHalfUp(multiply(multiply(base, markup), cacheFactor)));
}

/** Converts a configured whole-credit BYOK fee to micro-credits, rounding once. */
export function calculateByokFee(feeCredits: string): bigint {
  return checkedMoney(nearestNonnegativeHalfUp(multiply(decimal(feeCredits, 'feeCredits'), { numerator: 1000n, denominator: 1n })));
}

/** Serializes an exact nonnegative micro-credit amount to the USD-micro header unit. */
export function microCreditsToUsdMicroString(amount: bigint): string {
  return checkedMoney(amount).toString().concat('0');
}
