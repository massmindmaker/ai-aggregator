import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startTonObservationFromEnv } from "../ton-payment-bootstrap.js";
import { fixture } from "./ton-recovery.fixture";

// The bootstrap reads the FX oracle through '@aiag/shared/server' at runtime;
// a deterministic fresh observation keeps the refresher out of the stale skip.
vi.mock("@aiag/shared/server", () => ({
  getTonUsdRate: () => Promise.resolve(5),
  readTonFxObservation: () => ({ usd: 5, observedAtMs: Date.now() }),
}));

const env = () => ({
  TON_RECONCILIATION_MODE: "observe",
  TON_RECONCILIATION_NETWORK: "tvm:-3",
  TON_RECONCILIATION_ASSET_KIND: "native",
  TON_RECONCILIATION_PROVIDER_ID: "toncenter-v3-testnet",
  TON_RECONCILIATION_PROVIDER_ORIGIN: "https://testnet.toncenter.com",
  TON_RECONCILIATION_VERIFIER_VERSION: "aiag-toncenter-v3-verifier-v1",
  TON_RECONCILIATION_FINALITY_POLICY_ID:
    "toncenter-v3-testnet-provider-attested-mc-depth-2-v1",
  DATABASE_URL: "postgresql://test@127.0.0.1:15432/ai_aggregator_test",
  TON_POLICY_TEMPLATE: JSON.stringify({
    recipient: "0:" + "1".repeat(64),
    revision: "rev-1",
    finalityPolicyId: "toncenter-v3-testnet-provider-attested-mc-depth-2-v1",
    verifierVersion: "aiag-toncenter-v3-verifier-v1",
    packages: [
      {
        id: "credit-1200",
        label: "Basic — 1 200 кредитов",
        grantMicrocredits: 1200000,
      },
    ],
  }),
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("TON_POLICY_TEMPLATE wiring in bootstrap (BigInt grants)", () => {
  it("coerces JSON-number grants to BigInt and writes the checkout policy", async () => {
    const f = fixture();
    const close = vi.fn(async () => ({ kind: "closed" as const }));
    const writePolicy = vi.fn(async () => {});
    const makeDatabase = vi.fn(async () => ({
      deps: f.deps,
      close,
      writeCheckoutPolicy: writePolicy,
    }));
    const makeProvider = vi.fn(() => f.deps.provider);
    const h = await startTonObservationFromEnv({
      makeDatabase,
      makeProvider,
      env: env(),
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(writePolicy.mock.calls.length).toBeGreaterThanOrEqual(1);
    const written = writePolicy.mock.calls[0]![0] as string;
    expect(() => JSON.parse(written)).not.toThrow();
    expect(written).toContain('"grantMicrocredits":"1200000"');
    expect(written).toContain('"network":"tvm:-3"');
    await h.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
