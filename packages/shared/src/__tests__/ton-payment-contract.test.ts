import { describe, expect, it } from 'vitest';
import {
  assertQuoteFresh, convertAtomic, createQuote, normalizeAsset, parseAtomic,
  requireAllowlistedAsset, sameAsset, toDatabaseAtomic,
  type Asset, type QuoteInput, type RationalFx,
} from '../ton-payment-contract';

const native = { network: 'tvm:-3', kind: 'native', decimals: 9 } as const;
// Synthetic test identities; no issuer, reserve, or live-chain claim.
const testJetton = { network: 'tvm:-3', kind: 'jetton', decimals: 6, masterAddress: `0:${'a'.repeat(64)}` } as const;
const max = 9223372036854775807n;
const rate: RationalFx = { numerator: '2', denominator: '3', rounding: 'floor' };
const quoteInput = (): QuoteInput => ({
  quoteId: 'synthetic-quote', sourcePrice: { unit: 'fixture-credit-atomic', amountAtomic: '10' },
  asset: testJetton, additionalFeeAtomic: '2', expiresAtMs: 2000,
  fx: { ...rate, sourceUnit: 'fixture-credit-atomic', targetAsset: testJetton,
    source: 'synthetic-fixture', observedAtMs: 900, expiresAtMs: 3000 },
});

describe('plain decimal parsing', () => {
  it('preserves precision above Number and database ranges', () => {
    expect(parseAtomic('9007199254740993.000001', 6)).toBe(9007199254740993000001n);
    expect(parseAtomic('1.000000001', 9)).toBe(1000000001n);
    expect(parseAtomic('0.000000000000000001', 18)).toBe(1n);
    expect(parseAtomic('12', 0)).toBe(12n);
  });
  it.each(['', '+1', '-1', '1e3', 'NaN', 'Infinity', ' 1', '1 ', '1\n', '.1', '1.', '01', '0', '0.000', '1,2'])('rejects malformed/nonpositive amount %j', (text) => {
    expect(() => parseAtomic(text, 9)).toThrow();
  });
  it('rejects excessive precision even for trailing zeroes', () => {
    expect(() => parseAtomic('0.0000000001', 9)).toThrow();
    expect(() => parseAtomic('1.00', 1)).toThrow();
    expect(() => parseAtomic('1.0', 0)).toThrow();
  });
  it.each([-1, 19, 1.5, NaN, Infinity, 1000000000])('bounds decimals before allocation: %s', (decimals) => {
    expect(() => parseAtomic('1', decimals)).toThrow();
  });
  it('bounds input and atomic output before allocation', () => {
    expect(parseAtomic('9'.repeat(78), 0).toString()).toBe('9'.repeat(78));
    expect(() => parseAtomic('9'.repeat(79), 0)).toThrow();
    expect(() => parseAtomic('9'.repeat(61), 18)).toThrow();
    expect(() => parseAtomic('1'.repeat(97), 0)).toThrow();
    expect(() => parseAtomic(1 as unknown as string, 9)).toThrow();
  });
});

describe('database boundary', () => {
  it('serializes exact positive signed BIGINT and rejects overflow without truncation', () => {
    expect(toDatabaseAtomic(max - 1n)).toBe('9223372036854775806');
    expect(toDatabaseAtomic(max)).toBe('9223372036854775807');
    expect(() => toDatabaseAtomic(max + 1n)).toThrow();
    expect(() => toDatabaseAtomic(parseAtomic('9007199254740993.000001', 6))).toThrow();
    expect(() => toDatabaseAtomic(-1n)).toThrow();
    expect(() => toDatabaseAtomic(0n)).toThrow();
    expect(toDatabaseAtomic(0n, true)).toBe('0');
    expect(() => toDatabaseAtomic(1 as unknown as bigint)).toThrow();
  });
});

describe('server asset identity', () => {
  it('normalizes raw hex and returns only immutable allowlisted identity', () => {
    const candidate = { ...testJetton, masterAddress: `0:${'A'.repeat(64)}`, ticker: 'UNTRUSTED' };
    const asset = requireAllowlistedAsset(candidate, [testJetton]);
    expect(asset).toEqual(testJetton);
    expect(Object.isFrozen(asset)).toBe(true);
    expect(sameAsset(candidate, testJetton)).toBe(true);
    expect(normalizeAsset({ ...testJetton, masterAddress: `-1:${'A'.repeat(64)}` })).toEqual({ ...testJetton, masterAddress: `-1:${'a'.repeat(64)}` });
  });
  it('distinguishes master, kind, decimals and workchain', () => {
    expect(sameAsset(testJetton, { ...testJetton, masterAddress: `0:${'b'.repeat(64)}` })).toBe(false);
    expect(sameAsset(testJetton, { ...testJetton, masterAddress: `-1:${'a'.repeat(64)}` })).toBe(false);
    expect(sameAsset(testJetton, { ...testJetton, decimals: 9 })).toBe(false);
    expect(sameAsset(testJetton, native)).toBe(false);
    expect(sameAsset(native, { ...native })).toBe(true);
  });
  it.each([
    { ...native, network: 'tvm:-239' }, { ...native, decimals: 6 },
    { ...native, masterAddress: testJetton.masterAddress },
    { ...testJetton, decimals: 19 }, { ...testJetton, decimals: 1.5 },
    { ...testJetton, masterAddress: `0:${'a'.repeat(63)}` },
    { ...testJetton, masterAddress: `0:${'g'.repeat(64)}` },
    { ...testJetton, masterAddress: ` 0:${'a'.repeat(64)}` },
    { ...testJetton, masterAddress: 'EQ-fake-friendly-address' },
    { ...testJetton, masterAddress: `0:${'a'.repeat(64)}\n` },
    null, {},
  ])('rejects invalid asset %j', (asset) => {
    expect(() => normalizeAsset(asset)).toThrow();
    expect(sameAsset(asset as Asset, native)).toBe(false);
  });
  it('never trusts client ticker or decimals to extend an allowlist', () => {
    expect(() => requireAllowlistedAsset(testJetton, [])).toThrow();
    expect(() => requireAllowlistedAsset({ ...testJetton, decimals: 9 }, [testJetton])).toThrow();
    expect(() => requireAllowlistedAsset({ ...testJetton, masterAddress: `0:${'b'.repeat(64)}`, ticker: 'USDt' }, [testJetton])).toThrow();
    expect(requireAllowlistedAsset(native, [native])).toEqual(native);
  });
  it('rejects conflicting normalized server decimal pins even after a matching entry', () => {
    expect(() => requireAllowlistedAsset(testJetton, [testJetton, { ...testJetton, decimals: 9 }])).toThrow();
  });
});

describe('bounded rational conversion', () => {
  it.each([
    ['floor', '10', 6n], ['ceil', '10', 7n], ['half-up', '10', 7n],
    ['floor', '9', 6n], ['ceil', '9', 6n], ['half-up', '9', 6n],
  ] as const)('uses explicit %s rounding for %s', (rounding, amount, expected) => {
    expect(convertAtomic(amount, { ...rate, rounding })).toBe(expected);
  });
  it('rounds half up exactly and never converts money to Number', () => {
    expect(convertAtomic('5', { numerator: '1', denominator: '2', rounding: 'half-up' })).toBe(3n);
    expect(convertAtomic('4', { numerator: '1', denominator: '3', rounding: 'half-up' })).toBe(1n);
    expect(convertAtomic('9007199254740993', { numerator: '1', denominator: '1', rounding: 'floor' })).toBe(9007199254740993n);
    expect(convertAtomic(max.toString(), { numerator: '1', denominator: max.toString(), rounding: 'half-up' })).toBe(1n);
  });
  it.each(['0', '-1', '+1', '1e3', '01', '1.0', '1\n', '9'.repeat(79), '9223372036854775808'])('rejects invalid operands %j', (operand) => {
    expect(() => convertAtomic(operand, rate)).toThrow();
    expect(() => convertAtomic('1', { ...rate, numerator: operand })).toThrow();
    expect(() => convertAtomic('1', { ...rate, denominator: operand })).toThrow();
  });
  it('requires explicit rounding, rejects zero rounded amount and oversized intermediate', () => {
    expect(() => convertAtomic('1', { ...rate, rounding: undefined } as unknown as RationalFx)).toThrow();
    expect(() => convertAtomic('1', rate)).toThrow();
    expect(convertAtomic('1', { ...rate, rounding: 'ceil' })).toBe(1n);
    expect(() => convertAtomic(max.toString(), { numerator: '2', denominator: '2', rounding: 'floor' })).toThrow();
    expect(convertAtomic('3074457345618258602', { numerator: '3', denominator: '1', rounding: 'floor' })).toBe(9223372036854775806n);
    expect(() => convertAtomic('3074457345618258603', { numerator: '3', denominator: '3', rounding: 'floor' })).toThrow();
  });
  it('pins the int64 grant ceiling of the storefront fx pair (numerator 1e10)', () => {
    // Production pair from ton-checkout-policy-builder at 5 USD/TON:
    // numerator 10^10 / denominator 5x10^6 caps grant x numerator at int64,
    // i.e. grants > ~$9 223 are not quotable at ANY rate with numerator 1e10
    // (operator package budget; fail-closed).
    const storefrontFx: RationalFx = { numerator: '10000000000', denominator: '5000000', rounding: 'ceil' };
    // Exactly under the ceiling: 922337203 x 1e10 = 9223372030000000000 <= int64.
    expect(convertAtomic('922337203', storefrontFx)).toBe(1844674406000n);
    // One micro more overflows the intermediate before division: fail closed.
    expect(() => convertAtomic('922337204', storefrontFx)).toThrow('FX intermediate exceeds signed BIGINT');
  });
});

describe('immutable quote snapshot', () => {
  it('pins source units, target asset, FX provenance, rounding, explicit fee and expiry', () => {
    const input = quoteInput();
    const quote = createQuote(input, [testJetton], 1000);
    expect(quote).toEqual({ ...input, schemaVersion: 1, quotedAtMs: 1000, amountAtomic: '8' });
    expect(JSON.parse(JSON.stringify(quote)).amountAtomic).toBe('8');
    expect(Object.isFrozen(quote)).toBe(true);
    expect(Object.isFrozen(quote.fx)).toBe(true);
    expect(Object.isFrozen(quote.sourcePrice)).toBe(true);
    input.sourcePrice.amountAtomic = '100';
    input.fx.numerator = '3';
    expect(quote.sourcePrice.amountAtomic).toBe('10');
    expect(quote.fx.numerator).toBe('2');
  });
  it('supports explicit zero fee but guards addition overflow', () => {
    const input = quoteInput();
    input.additionalFeeAtomic = '0';
    expect(createQuote(input, [testJetton], 1000).amountAtomic).toBe('6');
    input.additionalFeeAtomic = '9223372036854775801';
    expect(createQuote(input, [testJetton], 1000).amountAtomic).toBe('9223372036854775807');
    input.additionalFeeAtomic = '9223372036854775802';
    expect(() => createQuote(input, [testJetton], 1000)).toThrow();
  });
  it('requires trusted asset and matching explicit FX units/target', () => {
    const input = quoteInput();
    expect(() => createQuote(input, [], 1000)).toThrow();
    expect(() => createQuote({ ...input, fx: { ...input.fx, sourceUnit: 'different-unit' } }, [testJetton], 1000)).toThrow();
    expect(() => createQuote({ ...input, fx: { ...input.fx, targetAsset: native } }, [testJetton, native], 1000)).toThrow();
    expect(() => createQuote({ ...input, fx: { ...input.fx, source: '' } }, [testJetton], 1000)).toThrow();
    expect(() => createQuote({ ...input, additionalFeeAtomic: undefined } as unknown as QuoteInput, [testJetton], 1000)).toThrow();
  });
  it('rejects stale quote, expired FX, future provenance and quote beyond FX expiry', () => {
    const input = quoteInput();
    expect(() => createQuote(input, [testJetton], 2000)).toThrow();
    expect(() => createQuote({ ...input, fx: { ...input.fx, expiresAtMs: 1000 } }, [testJetton], 1000)).toThrow();
    expect(() => createQuote({ ...input, fx: { ...input.fx, observedAtMs: 1001 } }, [testJetton], 1000)).toThrow();
    expect(() => createQuote({ ...input, expiresAtMs: 3001 }, [testJetton], 1000)).toThrow();
    expect(createQuote({ ...input, expiresAtMs: 3000 }, [testJetton], 1000).expiresAtMs).toBe(3000);
  });
  it('enforces expiry at equality and validates the supplied clock', () => {
    expect(() => assertQuoteFresh(1001, 1000)).not.toThrow();
    expect(() => assertQuoteFresh(1000, 1000)).toThrow();
    expect(() => assertQuoteFresh(999, 1000)).toThrow();
    for (const time of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => assertQuoteFresh(time, 0)).toThrow();
      expect(() => assertQuoteFresh(1000, time)).toThrow();
    }
  });
});
