import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startTonObservationFromEnv, startTonReconciliationFromEnv } from "../ton-payment-bootstrap.js";
import { fixture, deferred } from "./ton-recovery.fixture";
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
});
function setup() {
  const f = fixture();
  const close = vi.fn(async () => ({ kind: "closed" as const }));
  const makeDatabase = vi.fn(async () => ({ deps: f.deps, close }));
  const makeProvider = vi.fn(() => f.deps.provider);
  return { ...f, close, makeDatabase, makeProvider };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
describe("disabled and observe-only TON bootstrap", () => {
  it.each([undefined, "disabled"])(
    "does not load providers, databases or timers in mode %s",
    async (mode) => {
      const f = setup(),
        before = vi.getTimerCount();
      const h = await startTonObservationFromEnv({
        ...f,
        env: { TON_RECONCILIATION_MODE: mode },
      });
      expect(f.makeDatabase).not.toHaveBeenCalled();
      expect(f.makeProvider).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(before);
      expect(h.close()).toBe(h.close());
      expect(await h.close()).toEqual({
        kind: "closed",
        mutationOutcome: "known",
      });
    },
  );
  it.each([
    { TON_RECONCILIATION_MODE: "settle" },
    { TON_RECONCILIATION_NETWORK: "tvm:-239" },
    { TON_RECONCILIATION_ASSET_KIND: "jetton" },
    { TON_RECONCILIATION_PROVIDER_ORIGIN: "https://evil.test" },
    { TON_RECONCILIATION_VERIFIER_VERSION: "unknown" },
    { TON_RECONCILIATION_SOURCE_ID: "forged" },
    { DATABASE_URL: "" },
  ])("rejects unsafe configuration before factories: %j", async (patch) => {
    const f = setup();
    await expect(
      startTonObservationFromEnv({ ...f, env: { ...env(), ...patch } }),
    ).rejects.toBeDefined();
    expect(f.makeDatabase).not.toHaveBeenCalled();
    expect(f.makeProvider).not.toHaveBeenCalled();
  });
  it("runs bounded source discovery and serial polling without overlap, closes once", async () => {
    const f = setup(),
      gate = deferred<never>();
    f.deps.provider.scanAccountPage.mockImplementationOnce(() => gate.promise);
    const h = await startTonObservationFromEnv({ ...f, env: env() });
    await vi.advanceTimersByTimeAsync(30000);
    expect(f.deps.listSources).toHaveBeenCalledTimes(1);
    const closing = h.close();
    expect(h.close()).toBe(closing);
    await vi.advanceTimersByTimeAsync(0);
    expect(await closing).toEqual({ kind: "closed", mutationOutcome: "known" });
    expect(f.deps.releaseLease).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledTimes(1);
    gate.reject(Error("late"));
    await vi.advanceTimersByTimeAsync(120000);
    expect(f.deps.listSources).toHaveBeenCalledTimes(1);
  });
  it("closes hung source-list work within10s without claiming a source", async () => {
    const f = setup();
    f.deps.listSources.mockImplementationOnce(() => new Promise(() => {}));
    const h = await startTonObservationFromEnv({ ...f, env: env() });
    await vi.advanceTimersByTimeAsync(0);
    const closing = h.close();
    await vi.advanceTimersByTimeAsync(10000);
    expect(await closing).toEqual({
      kind: "deadline_exceeded",
      phase: "active_operation",
      mutationOutcome: "known",
    });
    expect(f.deps.claimLease).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it("does not release an unacknowledged hung claim and reports unknown mutation", async () => {
    const f = setup();
    f.deps.claimLease.mockImplementationOnce(() => new Promise(() => {}));
    const h = await startTonObservationFromEnv({ ...f, env: env() });
    await vi.advanceTimersByTimeAsync(0);
    const closing = h.close();
    await vi.advanceTimersByTimeAsync(10000);
    expect(await closing).toEqual({
      kind: "deadline_exceeded",
      phase: "active_operation",
      mutationOutcome: "unknown",
    });
    expect(f.deps.releaseLease).not.toHaveBeenCalled();
  });
  it("completes active-write10s, release10s and pool5s inside the30s close envelope", async () => {
    const f = setup();
    f.deps.recordObservation.mockImplementationOnce(
      () => new Promise(() => {}),
    );
    f.deps.releaseLease.mockImplementationOnce(() => new Promise(() => {}));
    f.close.mockImplementationOnce(() => new Promise(() => {}));
    const h = await startTonObservationFromEnv({ ...f, env: env() });
    await vi.advanceTimersByTimeAsync(0);
    const closing = h.close();
    await vi.advanceTimersByTimeAsync(25000);
    expect(await closing).toEqual({
      kind: "deadline_exceeded",
      phase: "active_operation",
      mutationOutcome: "unknown",
    });
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.deps.releaseLease).toHaveBeenCalledTimes(1);
  });
  it("preserves unknown operation outcome even when shutdown and pool close succeed", async () => {
    const f = setup();
    f.deps.recordObservation.mockRejectedValueOnce(Error("lost ACK"));
    const h = await startTonObservationFromEnv({ ...f, env: env() });
    await vi.advanceTimersByTimeAsync(0);
    expect(await h.close()).toEqual({
      kind: "closed",
      mutationOutcome: "unknown",
    });
  });
  it("classifies a pool timeout separately and memoizes the close", async () => {
    const f = setup();
    f.close.mockImplementationOnce(() => new Promise(() => {}));
    const h = await startTonObservationFromEnv({ ...f, env: env() });
    await vi.advanceTimersByTimeAsync(0);
    const closing = h.close();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await closing).toEqual({
      kind: "deadline_exceeded",
      phase: "pool",
      mutationOutcome: "known",
    });
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it("does not call a malformed observation acknowledgement a known mutation", async () => {
    const f = setup();
    f.deps.recordObservation.mockResolvedValueOnce({
      observationId: "bad",
      outcome: "inserted",
      invoiceStatus: "observed",
    });
    const h = await startTonObservationFromEnv({ ...f, env: env() });
    await vi.advanceTimersByTimeAsync(0);
    expect(await h.close()).toEqual({
      kind: "closed",
      mutationOutcome: "unknown",
    });
    expect(f.deps.advanceCursor).not.toHaveBeenCalled();
  });
  it.each([
    {
      DATABASE_URL: "postgresql://test@127.0.0.1/test?statement_timeout=999999",
    },
    {
      TON_RECONCILIATION_PROVIDER_ORIGIN:
        "https://testnet.toncenter.com.evil.test",
    },
    { TON_RECONCILIATION_FINALITY_POLICY_ID: "relaxed" },
  ])("keeps exact owned startup limits %j", async (patch) => {
    const f = setup();
    await expect(
      startTonObservationFromEnv({ ...f, env: { ...env(), ...patch } }),
    ).rejects.toBeDefined();
    expect(f.makeDatabase).not.toHaveBeenCalled();
  });
  it("never accepts an injected runtime settlement function", async () => {
    const f = setup(),
      settleVerifiedCredit = vi.fn();
    await expect(
      startTonObservationFromEnv({
        ...f,
        env: env(),
        settleVerifiedCredit,
      } as never),
    ).rejects.toThrow("TON_RUNTIME_SETTLEMENT_FORBIDDEN");
    expect(f.makeDatabase).not.toHaveBeenCalled();
    expect(settleVerifiedCredit).not.toHaveBeenCalled();
  });

  describe("settle mode behind the dual gate (plan task 3.2)", () => {
    const confirmation = "I-UNDERSTAND-WORKER-ONLY-SETTLEMENT";
    const workerUrl = "postgresql://aiag_ton_worker@127.0.0.1:15432/ai_aggregator_test";

    it.each([undefined, "", "yes", "i-understand-worker-only-settlement"])(
      "refuses settle mode without the exact confirmation: %j",
      async (value) => {
        const f = setup();
        await expect(
          startTonReconciliationFromEnv({
            ...f,
            env: {
              ...env(),
              TON_RECONCILIATION_MODE: "settle",
              TON_SETTLEMENT_CONFIRMATION: value,
              TON_SETTLEMENT_DATABASE_URL: workerUrl,
            },
          }),
        ).rejects.toThrow("TON_RECONCILIATION_STARTUP_REFUSED");
        expect(f.makeDatabase).not.toHaveBeenCalled();
      },
    );

    it("refuses settle mode without a worker-principal settlement url", async () => {
      const f = setup();
      await expect(
        startTonReconciliationFromEnv({
          ...f,
          env: {
            ...env(),
            TON_RECONCILIATION_MODE: "settle",
            TON_SETTLEMENT_CONFIRMATION: confirmation,
          },
        }),
      ).rejects.toThrow("TON_RECONCILIATION_STARTUP_REFUSED");
      await expect(
        startTonReconciliationFromEnv({
          ...f,
          env: {
            ...env(),
            TON_RECONCILIATION_MODE: "settle",
            TON_SETTLEMENT_CONFIRMATION: confirmation,
            TON_SETTLEMENT_DATABASE_URL: "postgresql://web@127.0.0.1:15432/ai_aggregator_test",
          },
        }),
      ).rejects.toThrow("TON_RECONCILIATION_STARTUP_REFUSED");
      expect(f.makeDatabase).not.toHaveBeenCalled();
    });

    it("runs the worker settlement path when both gates pass", async () => {
      const f = setup();
      const settleVerifiedCredit = vi.fn(async () => ({ kind: "settled" }));
      const close = vi.fn(async () => ({ kind: "closed" as const, mutationOutcome: "known" as const }));
      const makeDatabase = vi.fn(async () => ({ deps: { ...f.deps, settleVerifiedCredit }, close }));
      const h = await startTonObservationFromEnv({
        ...f,
        makeDatabase,
        env: {
          ...env(),
          TON_RECONCILIATION_MODE: "settle",
          TON_SETTLEMENT_CONFIRMATION: confirmation,
          TON_SETTLEMENT_DATABASE_URL: workerUrl,
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(settleVerifiedCredit).toHaveBeenCalledTimes(1);
      await h.close();
      expect(close).toHaveBeenCalledTimes(1);
    });

    it("still refuses an injected settlement function even in settle mode", async () => {
      const f = setup();
      await expect(
        startTonObservationFromEnv({
          ...f,
          env: {
            ...env(),
            TON_RECONCILIATION_MODE: "settle",
            TON_SETTLEMENT_CONFIRMATION: confirmation,
            TON_SETTLEMENT_DATABASE_URL: workerUrl,
          },
          settleVerifiedCredit: vi.fn(),
        } as never),
      ).rejects.toThrow("TON_RUNTIME_SETTLEMENT_FORBIDDEN");
    });

    it("boots mainnet reconciliation when every preset constant matches (mainnet wiring)", async () => {
      const f = setup();
      const h = await startTonObservationFromEnv({
        ...f,
        env: {
          ...env(),
          TON_NETWORK_PRESET: "mainnet",
          TON_RECONCILIATION_NETWORK: "tvm:-1",
          TON_RECONCILIATION_PROVIDER_ID: "toncenter-v3-mainnet",
          TON_RECONCILIATION_PROVIDER_ORIGIN: "https://toncenter.com",
          TON_RECONCILIATION_FINALITY_POLICY_ID: "toncenter-v3-provider-attested-mc-depth-2-v1",
        },
      });
      expect(f.makeProvider).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: "https://toncenter.com" }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(f.deps.listSources).toHaveBeenCalledTimes(1);
      await h.close();
    });

    it.each([
      ["testnet network with mainnet preset", { TON_NETWORK_PRESET: "mainnet" }],
      ["mainnet network with testnet preset", { TON_RECONCILIATION_NETWORK: "tvm:-1" }],
      ["unknown preset", { TON_NETWORK_PRESET: "devnet" }],
    ])("refuses %s", async (_label, patch) => {
      const f = setup();
      await expect(
        startTonReconciliationFromEnv({ ...f, env: { ...env(), ...patch } }),
      ).rejects.toThrow("TON_RECONCILIATION_STARTUP_REFUSED");
      expect(f.makeDatabase).not.toHaveBeenCalled();
    });
  });
  it("preserves unknown release outcome when the database acknowledgement is malformed", async () => {
    const f = setup();
    f.deps.releaseLease.mockResolvedValueOnce("not-an-ack" as never);
    const h = await startTonObservationFromEnv({ ...f, env: env() });
    await vi.advanceTimersByTimeAsync(0);
    expect(await h.close()).toEqual({
      kind: "closed",
      mutationOutcome: "unknown",
    });
  });
  it('provides the worker entrypoint with a disabled no-resource handle',async()=>{
    const f=setup();const handle=await startTonReconciliationFromEnv({...f,env:{}});
    expect(f.makeDatabase).not.toHaveBeenCalled();expect(f.makeProvider).not.toHaveBeenCalled();
    expect(await handle.close()).toEqual({kind:'closed',mutationOutcome:'known'});
  });
  it('redacts initialization failures at the worker boundary',async()=>{
    const f=setup();f.makeDatabase.mockRejectedValueOnce(new Error('postgresql://private:secret@private-host/db'));
    await expect(startTonReconciliationFromEnv({...f,env:env()})).rejects.toThrow('TON_RECONCILIATION_STARTUP_REFUSED');
    expect(f.makeProvider).not.toHaveBeenCalled();
  });
  it.each(['settle','unknown'])('entrypoint rejects mode %s before creating any TON resource',async mode=>{
    const f=setup();await expect(startTonReconciliationFromEnv({...f,env:{...env(),TON_RECONCILIATION_MODE:mode}})).rejects.toThrow('TON_RECONCILIATION_STARTUP_REFUSED');
    expect(f.makeDatabase).not.toHaveBeenCalled();expect(f.makeProvider).not.toHaveBeenCalled();
  });

  it('passes the TonCenter api key into the provider config (plan task 1.3)',async()=>{
    const f=setup();
    const fixtureApiKey=['toncenter','bootstrap','fixture'].join(':');
    const h=await startTonObservationFromEnv({...f,env:{...env(),TONCENTER_API_KEY:fixtureApiKey}});
    expect(f.makeProvider).toHaveBeenCalledWith(expect.objectContaining({apiKey:fixtureApiKey}));
    await h.close();
  });
  it('wires the secondary-source crosscheck only when the env flag asks for it (plan task 1.3)',async()=>{
    const f=setup();
    const crosscheck=vi.fn(async()=>({kind:'agree'} as const));
    const h=await startTonObservationFromEnv({
      ...f,
      env:{...env(),TON_EVIDENCE_CROSSCHECK:'1'},
      crosscheckMasterchain:crosscheck,
    });
    // Flush the startup tick only; the 30s interval must not run here.
    await vi.advanceTimersByTimeAsync(0);
    expect(f.observations[0]).toMatchObject({result:{kind:'verified_candidate'}});
    expect(crosscheck).toHaveBeenCalledTimes(1);
    await h.close();
  });
  it('keeps the crosscheck absent without the env flag',async()=>{
    const f=setup();
    const crosscheck=vi.fn(async()=>({kind:'agree'} as const));
    const h=await startTonObservationFromEnv({...f,env:env(),crosscheckMasterchain:crosscheck});
    await vi.advanceTimersByTimeAsync(30000);
    expect(f.observations[0]).toMatchObject({result:{kind:'verified_candidate'}});
    expect(crosscheck).not.toHaveBeenCalled();
    await h.close();
  });

});
