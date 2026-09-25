export type MediaUnitPrices = Readonly<{
  priceCentsPerUnit: string;
  markup: string;
}>;

export type MediaUnitQuote = Readonly<{
  formulaVersion: 'media-unit-microcredits-v1';
  supplierFormulaVersion: 'media-supplier-unit-microcredits-v1';
  units: number;
  supplierMaxMicrocredits: bigint;
  retailMaxMicrocredits: bigint;
}>;

type Rational = Readonly<{ numerator: bigint; denominator: bigint }>;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const MAX_DECIMAL_DIGITS = 38;
const MAX_DECIMAL_FRACTION_DIGITS = 18;

function decimal(value: string, name: string): Rational {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value))
    throw new TypeError(`${name} must be a plain canonical nonnegative decimal`);
  const [integer, fraction = ''] = value.split('.');
  if (
    fraction.length > MAX_DECIMAL_FRACTION_DIGITS ||
    integer.length + fraction.length > MAX_DECIMAL_DIGITS
  )
    throw new RangeError(`${name} exceeds the supported decimal precision`);
  return {
    numerator: BigInt(integer + fraction),
    denominator: 10n ** BigInt(fraction.length),
  };
}
function positive(value: Rational, name: string): Rational {
  if (value.numerator <= 0n) throw new RangeError(`${name} must be greater than zero`);
  return value;
}
function multiply(a: Rational, b: Rational): Rational {
  return { numerator: a.numerator * b.numerator, denominator: a.denominator * b.denominator };
}
function integer(value: Rational, multiplier: number): Rational {
  if (!Number.isSafeInteger(multiplier) || multiplier <= 0)
    throw new RangeError('units must be a positive safe integer');
  return { numerator: value.numerator * BigInt(multiplier), denominator: value.denominator };
}
function ceil(value: Rational): bigint {
  return (value.numerator + value.denominator - 1n) / value.denominator;
}
function money(value: bigint): bigint {
  if (value <= 0n || value > POSTGRES_BIGINT_MAX)
    throw new RangeError('media monetary amount must fit positive PostgreSQL BIGINT');
  return value;
}

export function quoteMediaUnits(prices: MediaUnitPrices, units: number): MediaUnitQuote {
  const price = positive(decimal(prices.priceCentsPerUnit, 'priceCentsPerUnit'), 'priceCentsPerUnit');
  const markup = positive(decimal(prices.markup, 'markup'), 'markup');
  const baseMicro = integer(multiply(price, { numerator: 1000n, denominator: 1n }), units);
  const supplierMaxMicrocredits = money(ceil(baseMicro));
  const retailMaxMicrocredits = money(ceil(multiply(baseMicro, markup)));
  return Object.freeze({
    formulaVersion: 'media-unit-microcredits-v1',
    supplierFormulaVersion: 'media-supplier-unit-microcredits-v1',
    units,
    supplierMaxMicrocredits,
    retailMaxMicrocredits,
  });
}
