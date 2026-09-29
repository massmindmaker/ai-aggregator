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

});
