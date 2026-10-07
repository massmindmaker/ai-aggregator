import { describe, expect, it } from 'vitest';
import { buildCheckoutPolicy, type PolicyBuilderInput } from '../lib/ton-wallet/policy-builder';
import { parseCheckoutPolicy } from '../lib/ton-wallet/checkout-policy';

const baseInput = (): PolicyBuilderInput => ({
  usdPerTon: 5.23,
  recipient: `0:${'a1'.repeat(32)}`,
  revision: '2026-10-07.1',
  finalityPolicyId: 'mc-finality-2of3',
  verifierVersion: 'ton-verifier-1.4.0',
  packages: [
    { id: 'starter', label: 'Starter pack', grantMicrocredits: 500n },
    { id: 'pro', label: 'Pro pack', grantMicrocredits: 1_500_000_000n },
  ],
});
const fixedNowMs = 1_760_000_000_000;
const nowMs = () => fixedNowMs;

describe('ton checkout policy builder', () => {
  it('emits a policy string that parseCheckoutPolicy accepts unchanged', () => {
    const policy = parseCheckoutPolicy(buildCheckoutPolicy(baseInput(), { nowMs }));
    expect(policy.network).toBe('tvm:-3');
    expect(policy.recipient).toBe(`0:${'a1'.repeat(32)}`);
    expect(policy.revision).toBe('2026-10-07.1');
    expect(policy.finalityPolicyId).toBe('mc-finality-2of3');
    expect(policy.verifierVersion).toBe('ton-verifier-1.4.0');
    expect(policy.additionalFeeAtomic).toBe('0');
    expect(policy.packages).toEqual([
      { id: 'starter', label: 'Starter pack', grantMicrocredits: '500' },
      { id: 'pro', label: 'Pro pack', grantMicrocredits: '1500000000' },
    ]);
  });

  it('encodes 5.23 USD/TON as the exact 1e6-scaled numerator', () => {
    const policy = parseCheckoutPolicy(buildCheckoutPolicy(baseInput(), { nowMs }));
    expect(policy.fx.numerator).toBe('5230000');
    expect(policy.fx.denominator).toBe('1000000');
    expect(policy.fx.rounding).toBe('ceil');
    expect(policy.fx.source).toBe('coingecko:the-open-network');
  });

  it('anchors FX provenance to the injected clock and maxFxAgeSeconds', () => {
    const policy = parseCheckoutPolicy(buildCheckoutPolicy(baseInput(), { nowMs }));
    expect(policy.fx.observedAtMs).toBe(fixedNowMs);
    expect(policy.fx.expiresAtMs).toBe(fixedNowMs + 60 * 1000);
    const custom = parseCheckoutPolicy(buildCheckoutPolicy({ ...baseInput(), maxFxAgeSeconds: 3600 }, { nowMs }));
    expect(custom.fx.expiresAtMs).toBe(fixedNowMs + 3_600_000);
  });

  it('defaults lifetime and max FX age inside the zod bounds', () => {
    const raw = buildCheckoutPolicy(baseInput(), { nowMs });
    expect(JSON.parse(raw).quoteLifetimeSeconds).toBe(120);
    expect(JSON.parse(raw).maxFxAgeSeconds).toBe(60);
    expect(() => parseCheckoutPolicy(raw)).not.toThrow();
  });

  it('accepts explicit values at both zod boundaries', () => {
    for (const quoteLifetimeSeconds of [30, 600]) {
      const policy = parseCheckoutPolicy(buildCheckoutPolicy({ ...baseInput(), quoteLifetimeSeconds }, { nowMs }));
      expect(policy.quoteLifetimeSeconds).toBe(quoteLifetimeSeconds);
    }
    expect(parseCheckoutPolicy(buildCheckoutPolicy({ ...baseInput(), maxFxAgeSeconds: 1 }, { nowMs })).maxFxAgeSeconds).toBe(1);
    expect(parseCheckoutPolicy(buildCheckoutPolicy({ ...baseInput(), maxFxAgeSeconds: 86_400 }, { nowMs })).maxFxAgeSeconds).toBe(86_400);
  });

  it('supports the full 1..20 package range with unique ids', () => {
    const twenty = Array.from({ length: 20 }, (_, index) => ({
      id: `pack-${index}`, label: `Pack ${index}`, grantMicrocredits: 1n,
    }));
    expect(parseCheckoutPolicy(buildCheckoutPolicy({ ...baseInput(), packages: twenty }, { nowMs })).packages).toHaveLength(20);
    const one = [{ id: 'solo', label: 'Solo', grantMicrocredits: 42n }];
    expect(parseCheckoutPolicy(buildCheckoutPolicy({ ...baseInput(), packages: one }, { nowMs })).packages).toHaveLength(1);
  });

  it('refuses non-positive or unrepresentable FX rates before emitting an unparsable policy', () => {
    for (const usdPerTon of [0, -5.23, Number.NaN, Number.POSITIVE_INFINITY, 4.9e-7]) {
      expect(() => buildCheckoutPolicy({ ...baseInput(), usdPerTon }, { nowMs })).toThrow();
    }
  });

  it('refuses non-positive microcredit grants', () => {
    expect(() => buildCheckoutPolicy({
      ...baseInput(), packages: [{ id: 'broken', label: 'Broken', grantMicrocredits: 0n }],
    }, { nowMs })).toThrow();
    expect(() => buildCheckoutPolicy({
      ...baseInput(), packages: [{ id: 'broken', label: 'Broken', grantMicrocredits: -1n }],
    }, { nowMs })).toThrow();
  });

  it('rejects a bogus injected clock instead of emitting invalid timestamps', () => {
    expect(() => buildCheckoutPolicy(baseInput(), { nowMs: () => -1 })).toThrow();
    expect(() => buildCheckoutPolicy(baseInput(), { nowMs: () => 1.5 })).toThrow();
  });
});
