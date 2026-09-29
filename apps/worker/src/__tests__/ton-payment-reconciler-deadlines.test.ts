import { afterEach, describe, expect, it, vi } from "vitest";
import { reconcileTonInvoices } from "../ton-payment-reconciler.js";
import {
  fixture,
  input,
  deferred,
  cursor,
  evidence,
} from "./ton-recovery.fixture";
afterEach(() => vi.useRealTimers());
describe("TON lease, timeout and shutdown boundaries", () => {
  it("ignores a pre-aborted call without any database/provider work", async () => {
    const f = fixture(),
      controller = new AbortController();
    controller.abort();
    expect(
      await reconcileTonInvoices(
        { ...input(), signal: controller.signal },
        f.deps,
      ),
    ).toEqual({
      kind: "stopped",
      reason: "shutdown",
      processed: 0,
      pagesAdvanced: 0,
    });
    expect(f.events).toEqual([]);
  });
  it("bounds an entire hung page at60seconds and preserves cursor on backoff", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      late = deferred<never>();
    f.deps.provider.scanAccountPage.mockImplementationOnce(() => late.promise);
    const running = reconcileTonInvoices(input(), f.deps);
    await vi.advanceTimersByTimeAsync(60000);
    expect(await running).toEqual({
      kind: "source_error",
      code: "timeout",
      processed: 0,
      pagesAdvanced: 0,
    });
    expect(f.deps.recordObservation).not.toHaveBeenCalled();
    expect(f.deps.advanceCursor).toHaveBeenCalledWith(
      expect.objectContaining({
        expected: null,
        next: null,
        outcome: "source_error",
        errorCode: "timeout",
      }),
    );
    const calls = f.events.length;
    late.resolve({
      kind: "page",
      evidence: [evidence()],
      nextCursor: null,
      exhausted: true,
    } as never);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.events).toHaveLength(calls);
  });
  it("shutdown wins a same-turn provider deadline and performs no backoff", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      controller = new AbortController();
    f.deps.provider.scanAccountPage.mockImplementationOnce(
      () => new Promise(() => {}),
    );
    const running = reconcileTonInvoices(
      { ...input(), signal: controller.signal },
      f.deps,
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(60000);
    expect(await running).toMatchObject({
      kind: "stopped",
      reason: "shutdown",
    });
    expect(f.deps.advanceCursor).not.toHaveBeenCalled();
    expect(f.deps.recordObservation).not.toHaveBeenCalled();
  });
  it("losing ownership at timeout cannot change backoff", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.deps.provider.scanAccountPage.mockImplementationOnce(
      () => new Promise(() => {}),
    );
    f.deps.renewLease
      .mockResolvedValueOnce("renewed")
      .mockResolvedValueOnce("lease_lost" as never);
    const running = reconcileTonInvoices(input(), f.deps);
    await vi.advanceTimersByTimeAsync(60000);
    expect(await running).toMatchObject({
      kind: "stopped",
      reason: "lease_lost",
    });
    expect(f.deps.advanceCursor).not.toHaveBeenCalled();
  });
  it.each([
    "claimLease",
    "bindRecipient",
    "renewLease",
    "findInvoices",
    "recordObservation",
    "advanceCursor",
  ] as const)(
    "bounds hung %s and never chains a late result",
    async (method) => {
      vi.useFakeTimers();
      const f = fixture(),
        late = deferred<never>();
      f.deps[method].mockImplementationOnce(() => late.promise);
      const running = reconcileTonInvoices(input(), f.deps);
      await vi.advanceTimersByTimeAsync(10000);
      const result = await running;
      expect(result).toEqual({
        kind: "stopped",
        reason: "db_operation_timeout",
        processed: 0,
        pagesAdvanced: 0,
      });
      expect(result).not.toHaveProperty("cursor");
      if (method === "claimLease")
        expect(f.deps.releaseLease).not.toHaveBeenCalled();
      const calls = f.events.length;
      late.reject(Error("late private failure"));
      await vi.advanceTimersByTimeAsync(1);
      expect(f.events).toHaveLength(calls);
    },
  );
  it("release timeout does not claim absence of earlier accepted observations", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.deps.releaseLease.mockImplementationOnce(() => new Promise(() => {}));
    const running = reconcileTonInvoices(input(), f.deps);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await running).toEqual({
      kind: "stopped",
      reason: "db_operation_timeout",
      processed: 1,
      pagesAdvanced: 1,
    });
  });
  it.each([
    "claimLease",
    "bindRecipient",
    "renewLease",
    "findInvoices",
    "recordObservation",
    "advanceCursor",
  ] as const)(
    "during %s shutdown waits only its current10s deadline",
    async (method) => {
      vi.useFakeTimers();
      const f = fixture(),
        controller = new AbortController(),
        late = deferred<never>();
      f.deps[method].mockImplementationOnce(() => {
        controller.abort();
        return late.promise;
      });
      const running = reconcileTonInvoices(
        { ...input(), signal: controller.signal },
        f.deps,
      );
      await vi.advanceTimersByTimeAsync(10000);
      expect(await running).toMatchObject({
        kind: "stopped",
        reason: "db_operation_timeout",
      });
      const calls = f.events.length;
      late.reject(Error("late"));
      await vi.advanceTimersByTimeAsync(1);
      expect(f.events).toHaveLength(calls);
    },
  );
  it.each(["findInvoices", "recordObservation"] as const)(
    "shutdown after an ACKed %s starts no dependent work",
    async (method) => {
      const f = fixture(),
        controller = new AbortController();
      const original = f.deps[method].getMockImplementation()!;
      f.deps[method].mockImplementationOnce(((...args: never[]) => {
        const result = (original as (...a: never[]) => Promise<never>)(...args);
        controller.abort();
        return result;
      }) as never);
      const r = await reconcileTonInvoices(
        { ...input(), signal: controller.signal },
        f.deps,
      );
      expect(r).toMatchObject({ kind: "stopped", reason: "shutdown" });
      expect(f.deps.advanceCursor).not.toHaveBeenCalled();
    },
  );
  it("refuses an account binding change before scanning a different account", async () => {
    const f = fixture();
    f.deps.bindRecipient.mockResolvedValueOnce("binding_mismatch" as never);
    expect(await reconcileTonInvoices(input(), f.deps)).toMatchObject({
      kind: "source_error",
      code: "recipient_binding_changed",
    });
    expect(f.deps.provider.scanAccountPage).not.toHaveBeenCalled();
  });
  it("fails closed on provider cursor regression, duplicate transaction or whole overlarge page", async () => {
    for (const page of [
      {
        kind: "page",
        evidence: [evidence(), evidence()],
        nextCursor: null,
        exhausted: true,
      },
      {
        kind: "page",
        evidence: Array.from({ length: 9 }, (_, i) =>
          evidence(String(1000 - i)),
        ),
        nextCursor: null,
        exhausted: true,
      },
      {
        kind: "page",
        evidence: [evidence()],
        nextCursor: cursor("1001", "1001"),
        exhausted: false,
      },
    ]) {
      const f = fixture();
      f.deps.provider.scanAccountPage.mockResolvedValueOnce(page as never);
      const r = await reconcileTonInvoices(input(), f.deps);
      expect(r.kind).toBe("source_error");
      expect(f.deps.findInvoices).not.toHaveBeenCalled();
      expect(
        f.deps.recordObservation.mock.calls.every(
          ([o]) => o.invoiceId === null,
        ),
      ).toBe(true);
    }
  });
});
