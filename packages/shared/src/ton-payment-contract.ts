/**
 * TON network ids: 'tvm:-3' (testnet) and 'tvm:-1' (mainnet). The runtime quote
 * parser below still only accepts testnet until the mainnet migration lands;
 * the union exists so preset-aware code typechecks end to end.
 */
export type TonNetworkId = 'tvm:-3' | 'tvm:-1';

/** Pure testnet amount/quote contract. No network, persistence, or issuer discovery. */
export type Asset = Readonly<
  | { network: TonNetworkId; kind: 'native'; decimals: 9 }
  | { network: TonNetworkId; kind: 'jetton'; masterAddress: string; decimals: number }
>;

/** Target atomic units per source atomic unit. No implicit decimal scaling. */
export type RationalFx = Readonly<{
  numerator: string;
  denominator: string;
  rounding: 'floor' | 'ceil' | 'half-up';
}>;

export interface QuoteInput {
  quoteId: string;
  sourcePrice: { unit: string; amountAtomic: string };
  asset: Asset;
  fx: {
    sourceUnit: string;
    targetAsset: Asset;
    numerator: string;
    denominator: string;
    rounding: RationalFx['rounding'];
    source: string;
    observedAtMs: number;
    expiresAtMs: number;
  };
  /** Explicit additive fee in the target asset's atomic units, including '0'. */
  additionalFeeAtomic: string;
  expiresAtMs: number;
}

export type TonQuote = Readonly<Omit<QuoteInput, 'sourcePrice' | 'fx'> & {
  schemaVersion: 1;
  sourcePrice: Readonly<QuoteInput['sourcePrice']>;
  fx: Readonly<QuoteInput['fx']>;
  amountAtomic: string;
  quotedAtMs: number;
}>;

const DB_MAX = 9223372036854775807n;
const MAX_INPUT_LENGTH = 96;
const MAX_ATOMIC_DIGITS = 78;

function validateDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error('Decimals must be an integer from 0 to 18');
  }
}

/** Parses display units exactly. Deliberately wider than the database boundary. */
export function parseAtomic(text: string, decimals: number): bigint {
  validateDecimals(decimals);
  // End-of-input assertion also rejects a final newline, unlike JavaScript's $.
  if (typeof text !== 'string' || text.length > MAX_INPUT_LENGTH
    || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?![\s\S])/.test(text)) {
    throw new Error('Expected a bounded unsigned plain decimal');
  }
  const dot = text.indexOf('.');
  const fractionLength = dot === -1 ? 0 : text.length - dot - 1;
  if (fractionLength > decimals) throw new Error('Amount exceeds asset precision');
  const digits = text.replace('.', '').replace(/^0+/, '');
  const padding = decimals - fractionLength;
  if (digits.length === 0) throw new Error('Amount must be positive');
  if (digits.length + padding > MAX_ATOMIC_DIGITS) throw new Error('Atomic amount is too large');
  return BigInt(digits + '0'.repeat(padding));
}

/** Use immediately before persisting invoice/credit/fee amounts to signed BIGINT. */
export function toDatabaseAtomic(value: bigint, allowZero = false): string {
  if (typeof value !== 'bigint' || value < (allowZero ? 0n : 1n) || value > DB_MAX) {
    throw new Error('Amount is outside the signed BIGINT persistence range');
  }
  return value.toString();
}

/** Raw 0/-1 workchains only in v1; this does not decode TON friendly addresses. */
export function normalizeAsset(input: unknown): Asset {
  if (!input || typeof input !== 'object') throw new Error('Invalid asset');
  const asset = input as Record<string, unknown>;
  if (asset.network !== 'tvm:-3') throw new Error('Only testnet assets are supported');
  if (asset.kind === 'native') {
    if (asset.decimals !== 9 || 'masterAddress' in asset) throw new Error('Invalid native asset');
    return Object.freeze({ network: 'tvm:-3', kind: 'native', decimals: 9 });
  }
  if (asset.kind !== 'jetton') throw new Error('Invalid asset kind');
  validateDecimals(asset.decimals as number);
  const master = asset.masterAddress;
  if (typeof master !== 'string' || master.length > 67
    || !/^(?:0|-1):[0-9a-fA-F]{64}(?![\s\S])/.test(master)) {
    throw new Error('Expected a raw jetton master address');
  }
  return Object.freeze({
    network: 'tvm:-3', kind: 'jetton', decimals: asset.decimals as number,
    masterAddress: master.toLowerCase(),
  });
}

function identity(asset: Asset): string {
  return `${asset.network}:${asset.kind}:${asset.kind === 'jetton' ? asset.masterAddress : ''}`;
}

/** Decimals are an immutable trust pin in addition to network/kind/master identity. */
export function sameAsset(a: Asset, b: Asset): boolean {
  try {
    const first = normalizeAsset(a);
    const second = normalizeAsset(b);
    return identity(first) === identity(second) && first.decimals === second.decimals;
  } catch {
    return false;
  }
}

/** The list MUST be server-owned configuration, never a list supplied by a client. */
export function requireAllowlistedAsset(candidate: unknown, serverAllowlist: readonly Asset[]): Asset {
  const requested = normalizeAsset(candidate);
  const normalized = new Map<string, Asset>();
  for (const entry of serverAllowlist) {
    const asset = normalizeAsset(entry);
    const key = identity(asset);
    const previous = normalized.get(key);
    if (previous && previous.decimals !== asset.decimals) throw new Error('Conflicting server asset decimals');
    normalized.set(key, asset);
  }
  const allowed = normalized.get(identity(requested));
  if (!allowed || allowed.decimals !== requested.decimals) throw new Error('Asset is not server allowlisted');
  return allowed;
}

function databaseInteger(text: string, allowZero = false): bigint {
  if (typeof text !== 'string' || text.length > MAX_ATOMIC_DIGITS
    || !/^(?:0|[1-9][0-9]*)(?![\s\S])/.test(text)) {
    throw new Error('Expected a bounded canonical atomic integer');
  }
  const value = BigInt(text);
  toDatabaseAtomic(value, allowZero);
  return value;
}

/** V1 also caps the product BEFORE division at signed BIGINT; it never truncates. */
export function convertAtomic(amountAtomic: string, rate: RationalFx): bigint {
  if (!rate || !['floor', 'ceil', 'half-up'].includes(rate.rounding)) {
    throw new Error('Explicit supported rounding is required');
  }
  const amount = databaseInteger(amountAtomic);
  const numerator = databaseInteger(rate.numerator);
  const denominator = databaseInteger(rate.denominator);
  if (amount > DB_MAX / numerator) throw new Error('FX intermediate exceeds signed BIGINT');
  const product = amount * numerator;
  const quotient = product / denominator;
  const remainder = product % denominator;
  // Compare to the complement instead of doubling remainder (which could overflow).
  const roundUp = rate.rounding === 'ceil' ? remainder > 0n
    : rate.rounding === 'half-up' && remainder >= denominator - remainder;
  if (roundUp && quotient === DB_MAX) throw new Error('Rounded amount exceeds signed BIGINT');
  const converted = quotient + (roundUp ? 1n : 0n);
  toDatabaseAtomic(converted);
  return converted;
}

function validateTime(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Expected nonnegative safe integer Unix milliseconds');
}

export function assertQuoteFresh(expiresAtMs: number, nowMs: number): void {
  validateTime(expiresAtMs);
  validateTime(nowMs);
  if (expiresAtMs <= nowMs) throw new Error('Quote or FX has expired');
}

function validateLabel(value: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_INPUT_LENGTH || value.trim() !== value) {
    throw new Error('Expected a bounded nonempty label');
  }
}

/**
 * Pure immutable snapshot; caller supplies price, FX, fee, IDs and all time policy.
 * additionalFeeAtomic is explicitly additive in the target asset, not an inferred fee policy.
 * This does not persist an invoice, choose prices, verify issuers, or establish settlement.
 */
export function createQuote(input: QuoteInput, serverAllowlist: readonly Asset[], nowMs: number): TonQuote {
  validateLabel(input.quoteId);
  validateLabel(input.sourcePrice.unit);
  validateLabel(input.fx.sourceUnit);
  validateLabel(input.fx.source);
  const asset = requireAllowlistedAsset(input.asset, serverAllowlist);
  const targetAsset = requireAllowlistedAsset(input.fx.targetAsset, serverAllowlist);
  if (input.fx.sourceUnit !== input.sourcePrice.unit || !sameAsset(asset, targetAsset)) {
    throw new Error('FX units do not match the quoted source and target');
  }
  assertQuoteFresh(input.expiresAtMs, nowMs);
  assertQuoteFresh(input.fx.expiresAtMs, nowMs);
  validateTime(input.fx.observedAtMs);
  if (input.fx.observedAtMs > nowMs || input.expiresAtMs > input.fx.expiresAtMs) {
    throw new Error('FX provenance or quote expiry is outside the valid interval');
  }
  const converted = convertAtomic(input.sourcePrice.amountAtomic, input.fx);
  const fee = databaseInteger(input.additionalFeeAtomic, true);
  if (fee > DB_MAX - converted) throw new Error('Quote total exceeds signed BIGINT');
  return Object.freeze({
    schemaVersion: 1,
    quoteId: input.quoteId,
    sourcePrice: Object.freeze({ unit: input.sourcePrice.unit, amountAtomic: input.sourcePrice.amountAtomic }),
    asset,
    fx: Object.freeze({
      sourceUnit: input.fx.sourceUnit, targetAsset,
      numerator: input.fx.numerator, denominator: input.fx.denominator, rounding: input.fx.rounding,
      source: input.fx.source, observedAtMs: input.fx.observedAtMs, expiresAtMs: input.fx.expiresAtMs,
    }),
    additionalFeeAtomic: input.additionalFeeAtomic,
    amountAtomic: toDatabaseAtomic(converted + fee),
    quotedAtMs: nowMs,
    expiresAtMs: input.expiresAtMs,
  });
}
