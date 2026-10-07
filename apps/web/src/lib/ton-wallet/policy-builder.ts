/**
 * Pure builder for the server-owned TON checkout policy JSON blob consumed by
 * parseCheckoutPolicy (zod) in checkout-policy.ts. The FX oracle is NOT
 * consulted here: the caller supplies usdPerTon, this module only renders a
 * string that the schema must accept. FX is a fixed-point ratio scaled by 1e6
 * with 'ceil' rounding (in favour of the receiver).
 */
export interface PolicyBuilderInput {
  usdPerTon: number;
  recipient: string;
  revision: string;
  finalityPolicyId: string;
  verifierVersion: string;
  packages: Array<{ id: string; label: string; grantMicrocredits: bigint }>;
  quoteLifetimeSeconds?: number;
  maxFxAgeSeconds?: number;
}

export interface PolicyBuilderDeps {
  /** Test seam for deterministic observedAtMs/expiresAtMs. */
  nowMs?: () => number;
}

/** Defaults must stay inside the zod bounds (30..600 and 1..86400). */
const DEFAULT_QUOTE_LIFETIME_SECONDS = 120;
const DEFAULT_MAX_FX_AGE_SECONDS = 60;
const FX_SCALE = 1_000_000n;
const FX_SOURCE = 'coingecko:the-open-network';
const MAX_SIGNED_BIGINT = 9223372036854775807n;

/** Guards stay ahead of serialization so a bad input never masquerades as a 503 policy outage. */
function positiveAtomicString(value: bigint, code: string): string {
  if (typeof value !== 'bigint' || value <= 0n || value > MAX_SIGNED_BIGINT) {
    throw new Error(code);
  }
  return value.toString();
}

export function buildCheckoutPolicy(input: PolicyBuilderInput, deps?: PolicyBuilderDeps): string {
  const nowMs = deps?.nowMs ?? Date.now;
  const observedAtMs = nowMs();
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
    throw new Error('TON_POLICY_BUILDER_CLOCK_INVALID');
  }
  const maxFxAgeSeconds = input.maxFxAgeSeconds ?? DEFAULT_MAX_FX_AGE_SECONDS;
  if (typeof input.usdPerTon !== 'number' || !Number.isFinite(input.usdPerTon) || input.usdPerTon <= 0) {
    throw new Error('TON_POLICY_BUILDER_FX_INVALID');
  }
  const numerator = positiveAtomicString(BigInt(Math.round(input.usdPerTon * 1_000_000)), 'TON_POLICY_BUILDER_FX_INVALID');
  const policy = {
    revision: input.revision,
    recipient: input.recipient,
    network: 'tvm:-3' as const,
    finalityPolicyId: input.finalityPolicyId,
    verifierVersion: input.verifierVersion,
    quoteLifetimeSeconds: input.quoteLifetimeSeconds ?? DEFAULT_QUOTE_LIFETIME_SECONDS,
    maxFxAgeSeconds,
    fx: {
      numerator,
      denominator: FX_SCALE.toString(),
      rounding: 'ceil' as const,
      source: FX_SOURCE,
      observedAtMs,
      expiresAtMs: observedAtMs + maxFxAgeSeconds * 1000,
    },
    additionalFeeAtomic: '0',
    packages: input.packages.map((entry) => ({
      id: entry.id,
      label: entry.label,
      grantMicrocredits: positiveAtomicString(entry.grantMicrocredits, 'TON_POLICY_BUILDER_GRANT_INVALID'),
    })),
  };
  return JSON.stringify(policy);
}
