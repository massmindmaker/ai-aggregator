import { afterEach, describe, expect, it, vi } from "vitest";
import type { TonSettlementResult } from "@aiag/database";
import type { TonEvidenceProvider } from "../ton-payment-provider.js";
import type { TonObserveReconcilerDeps } from "../ton-payment-reconciler.js";
import {
  fixture,
  input,
  source,
  invoice,
  evidence,
  cursor,
  deferred,
} from "./ton-recovery.fixture";
import { receipt } from "./ton-settlement.fixture";
import {
  reconcileTonInvoices,
  reconcileTonInvoicesWithFixtureSettlement,
} from "../ton-payment-reconciler.js";
import { TonOperationBudget } from "../ton-recovery-control.js";
const done = { kind: "completed", processed: 1, pagesAdvanced: 1 };
function create(result: unknown = { kind: "settled", receipt: receipt() }) {
  const f = fixture();
  const scan = vi.fn<TonEvidenceProvider["scanAccountPage"]>(async () =>
    f.deps.provider.scanAccountPage(),
  );
  const deps = {
    ...f.deps,
    provider: { ...f.deps.provider, scanAccountPage: scan },
  };
  const settle = vi.fn(async () => {
    f.events.push("settle");
    return result as TonSettlementResult;
  });
  return {
    ...f,
    deps,
    settle,
    hook: { mode: "settle" as const, settleVerifiedCredit: settle },
  };
}
afterEach(() => vi.useRealTimers());
describe("fixture-only native settlement ordering", () => {
  it.each([
    "settled",
    "already_settled",
    "review_required",
    "evidence_conflict",
  ] as const)(
    "%s counts a processed page only after all durable ACKs",
    async (kind) => {
      const value =
        kind === "settled" || kind === "already_settled"
          ? { kind, receipt: receipt() }
          : kind === "review_required"
            ? {
                kind,
                invoiceId: invoice().invoiceId,
                eventId: receipt().eventId,
                reason: "late_payment",
              }
            : { kind, eventId: receipt().eventId };
      const f = create(value);
      expect(
        await reconcileTonInvoicesWithFixtureSettlement(
          input(),
          f.deps,
          f.hook,
        ),
      ).toEqual(done);
      expect(f.events.indexOf("observe")).toBeLessThan(
        f.events.indexOf("settle"),
      );
      expect(f.events.lastIndexOf("observe")).toBeLessThan(
        f.events.indexOf("advance"),
      );
      expect(f.settle).toHaveBeenCalledTimes(1);
      if (kind === "evidence_conflict") {
        expect(f.observations).toHaveLength(2);
        expect(f.observations[1]).toMatchObject({
          invoiceId: invoice().invoiceId,
          result: {
            kind: "review_required",
            reason: "settlement_evidence_conflict",
          },
          snapshot: { eventId: receipt().eventId },
        });
      }
    },
  );
  it("stops on not_found without advancing or invoking the next candidate", async () => {
    const f = create({ kind: "not_found" });
    expect(
      await reconcileTonInvoicesWithFixtureSettlement(input(), f.deps, f.hook),
    ).toEqual({
      kind: "stopped",
      reason: "settlement_not_found",
      processed: 0,
      pagesAdvanced: 0,
    });
    expect(f.deps.advanceCursor).not.toHaveBeenCalled();
  });
  it.each([
    {},
    null,
    {
      kind: "settled",
      receipt: {
        ...receipt(),
        invoiceId: "90000000-0000-4000-8000-000000000009",
      },
    },
  ])("marks malformed ACK as unknown without advancing", async (value) => {
    const f = create(value),
      i = input(),
      b = new TonOperationBudget(i.signal);
    expect(
      await reconcileTonInvoicesWithFixtureSettlement(i, f.deps, f.hook, b),
    ).toMatchObject({ kind: "stopped", reason: "db_error", processed: 0 });
    expect(b.mutationOutcome).toBe("unknown");
    expect(f.deps.advanceCursor).not.toHaveBeenCalled();
  });
  it("never settles before observation commit acknowledgement", async () => {
    const f = create();
    f.deps.recordObservation.mockRejectedValueOnce(
      Error("lost observation ACK"),
    );
    expect(
      await reconcileTonInvoicesWithFixtureSettlement(input(), f.deps, f.hook),
    ).toMatchObject({ kind: "stopped", reason: "db_error" });
    expect(f.settle).not.toHaveBeenCalled();
    expect(f.deps.advanceCursor).not.toHaveBeenCalled();
  });
  it("loses no money identity on settlement commit/ACK loss and replay", async () => {
    const f = create();
    let persisted = false;
    f.settle.mockImplementation(async () => {
      if (!persisted) {
        persisted = true;
        throw Error("settled but ACK lost");
      }
      return { kind: "already_settled", receipt: receipt() };
    });
    expect(
      await reconcileTonInvoicesWithFixtureSettlement(input(), f.deps, f.hook),
    ).toMatchObject({ kind: "stopped", reason: "db_error", processed: 0 });
    expect(f.deps.advanceCursor).not.toHaveBeenCalled();
    expect(
      await reconcileTonInvoicesWithFixtureSettlement(input(), f.deps, f.hook),
    ).toEqual(done);
    expect(f.committed.size).toBe(1);
  });
  it("requires the second conflict observation ACK before advancing", async () => {
    const f = create({ kind: "evidence_conflict", eventId: receipt().eventId });
    const persist = f.deps.recordObservation.getMockImplementation()!;
    let fail = true;
    f.deps.recordObservation.mockImplementation(async (data) => {
      const ack = await persist(data);
      if (data.result.reason === "settlement_evidence_conflict" && fail) {
        fail = false;
        throw Error("conflict ACK lost");
      }
      return ack;
    });
    expect(
      await reconcileTonInvoicesWithFixtureSettlement(input(), f.deps, f.hook),
    ).toMatchObject({ kind: "stopped", processed: 0 });
    expect(f.deps.advanceCursor).not.toHaveBeenCalled();
    expect(
      await reconcileTonInvoicesWithFixtureSettlement(input(), f.deps, f.hook),
    ).toEqual(done);
    expect(f.committed.size).toBe(2);
  });
  it("retains only previous ACKed-page counters on later failure", async () => {
    const f = create();
    f.deps.provider.scanAccountPage.mockResolvedValueOnce({
      kind: "page",
      evidence: [evidence()],
      nextCursor: cursor(),
      exhausted: false,
    });
    f.deps.provider.scanAccountPage.mockResolvedValueOnce({
      kind: "page",
      evidence: [evidence("999")],
      nextCursor: null,
      exhausted: true,
    });
    f.settle
      .mockResolvedValueOnce({ kind: "settled", receipt: receipt() })
      .mockResolvedValueOnce({ kind: "not_found" });
    expect(
      await reconcileTonInvoicesWithFixtureSettlement(input(), f.deps, f.hook),
    ).toEqual({
      kind: "stopped",
      reason: "settlement_not_found",
      processed: 1,
      pagesAdvanced: 1,
    });
    expect(f.deps.advanceCursor).toHaveBeenCalledTimes(1);
  });
  it.each(["settle", "conflict-observation"])(
    "bounds hung %s at10seconds and suppresses late work",
    async (where) => {
      vi.useFakeTimers();
      const f = create(
          where === "settle"
            ? { kind: "settled", receipt: receipt() }
            : { kind: "evidence_conflict", eventId: receipt().eventId },
        ),
        d = deferred<any>(),
        i = input(),
        b = new TonOperationBudget(i.signal);
      if (where === "settle") f.settle.mockImplementationOnce(() => d.promise);
      else {
        const original = f.deps.recordObservation.getMockImplementation()!;
        f.deps.recordObservation.mockImplementation((data) =>
          data.result.kind === "review_required" ? d.promise : original(data),
        );
      }
      const run = reconcileTonInvoicesWithFixtureSettlement(
        i,
        f.deps,
        f.hook,
        b,
      );
      await vi.advanceTimersByTimeAsync(10001);
      expect(await run).toMatchObject({
        kind: "stopped",
        reason: "db_operation_timeout",
        processed: 0,
      });
      expect(b.mutationOutcome).toBe("unknown");
      d.resolve({ kind: "settled", receipt: receipt() });
      await vi.advanceTimersByTimeAsync(0);
      expect(f.deps.advanceCursor).not.toHaveBeenCalled();
    },
  );
  it("shutdown during settlement waits bounded ACK but starts no dependent work", async () => {
    vi.useFakeTimers();
    const f = create(),
      controller = new AbortController(),
      d = deferred<TonSettlementResult>();
    f.settle.mockImplementationOnce(() => d.promise);
    const run = reconcileTonInvoicesWithFixtureSettlement(
      { ...input(), signal: controller.signal },
      f.deps,
      f.hook,
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    d.resolve({ kind: "settled", receipt: receipt() });
    await vi.advanceTimersByTimeAsync(0);
    expect(await run).toMatchObject({
      kind: "stopped",
      reason: "shutdown",
      processed: 0,
    });
    expect(f.deps.advanceCursor).not.toHaveBeenCalled();
  });
  it.each(["incomplete", "wrong-amount", "unmatched", "forged", "jetton"])(
    "does not settle unverified %s input",
    async (kind) => {
      const f = create();
      if (kind === "jetton") {
        await reconcileTonInvoicesWithFixtureSettlement(
          {
            ...input(),
            source: {
              ...source(),
              asset: {
                network: "tvm:-3",
                kind: "jetton",
                decimals: 6,
                masterAddress: source().invoiceRecipient,
              },
            },
          },
          f.deps,
          f.hook,
        );
      } else {
        const e = evidence();
        if (kind === "incomplete") e.trace.complete = false;
        if (kind === "wrong-amount")
          e.transactions[0].inMessage.amountAtomic = "2";
        if (kind === "unmatched") f.deps.findInvoices.mockResolvedValue([]);
        f.deps.provider.scanAccountPage.mockResolvedValueOnce({
          kind: "page",
          evidence: [
            kind === "forged"
              ? ({ verified: true, finalized: true, boc: "fake" } as any)
              : e,
          ],
          nextCursor: null,
          exhausted: true,
        });
        await reconcileTonInvoicesWithFixtureSettlement(
          input(),
          f.deps,
          f.hook,
        );
      }
      expect(f.settle).not.toHaveBeenCalled();
    },
  );
  it("observation-only callers cannot promote an injected extra dependency into settlement", async () => {
    const f = create();
    expect(
      await reconcileTonInvoices(input(), {
        ...f.deps,
        settleVerifiedCredit: f.settle,
      } as any),
    ).toEqual(done);
    expect(f.settle).not.toHaveBeenCalled();
  });
  it("rejects unrecognized fixture mode before claim", async () => {
    const f = create();
    await expect(
      reconcileTonInvoicesWithFixtureSettlement(input(), f.deps, {
        ...f.hook,
        mode: "live",
      } as any),
    ).rejects.toBeDefined();
    expect(f.deps.claimLease).not.toHaveBeenCalled();
  });
  it.each(["before-settle", "after-settle", "renew-ack-lost"])(
    "stops at %s boundary without later candidate or cursor work",
    async (boundary) => {
      const f = create();
      let stolen = false;
      const observe = f.deps.recordObservation.getMockImplementation()!;
      const settle = vi.fn(async () => {
        f.events.push("settle");
        stolen = true;
        return { kind: "settled" as const, receipt: receipt() };
      });
      const deps: TonObserveReconcilerDeps = {
        ...f.deps,
        recordObservation: async (data) => {
          const r = await observe(data);
          if (boundary !== "after-settle") stolen = true;
          return r;
        },
        renewLease: async () => {
          f.events.push("renew");
          if (stolen) {
            if (boundary === "renew-ack-lost")
              throw Error("renew committed ACK lost");
            return "lease_lost";
          }
          return "renewed";
        },
      };
      const result = await reconcileTonInvoicesWithFixtureSettlement(
        input(),
        deps,
        { mode: "settle", settleVerifiedCredit: settle },
      );
      expect(result).toEqual({
        kind: "stopped",
        reason: boundary === "renew-ack-lost" ? "db_error" : "lease_lost",
        processed: 0,
        pagesAdvanced: 0,
      });
      expect(settle).toHaveBeenCalledTimes(boundary === "after-settle" ? 1 : 0);
      expect(f.deps.advanceCursor).not.toHaveBeenCalled();
      expect(f.deps.releaseLease).toHaveBeenCalledTimes(1);
    },
  );
  it("conflict outcome never writes the second observation after ownership loss", async () => {
    const f = create();
    let stolen = false;
    const deps: TonObserveReconcilerDeps = {
      ...f.deps,
      renewLease: async () => (stolen ? "lease_lost" : "renewed"),
    };
    const result = await reconcileTonInvoicesWithFixtureSettlement(
      input(),
      deps,
      {
        mode: "settle",
        settleVerifiedCredit: async () => {
          stolen = true;
          return { kind: "evidence_conflict", eventId: receipt().eventId };
        },
      },
    );
    expect(result).toEqual({
      kind: "stopped",
      reason: "lease_lost",
      processed: 0,
      pagesAdvanced: 0,
    });
    expect(f.observations).toHaveLength(1);
    expect(f.deps.advanceCursor).not.toHaveBeenCalled();
  });
  it.each(["not_found", "throw", "conflict"] as const)(
    "never reports a partial two-candidate page after second %s",
    async (branch) => {
      const f = create();
      f.deps.provider.scanAccountPage.mockResolvedValueOnce({
        kind: "page",
        evidence: [evidence("1000"), evidence("999")],
        nextCursor: null,
        exhausted: true,
      });
      let calls = 0;
      f.settle.mockImplementation(async () => {
        calls++;
        if (calls === 1) return { kind: "settled", receipt: receipt() };
        if (branch === "throw") throw Error("lost second ACK");
        if (branch === "not_found") return { kind: "not_found" };
        return { kind: "evidence_conflict", eventId: receipt().eventId };
      });
      if (branch === "conflict") {
        const original = f.deps.recordObservation.getMockImplementation()!;
        f.deps.recordObservation.mockImplementation((data) =>
          data.result.kind === "review_required"
            ? Promise.reject(Error("conflict ACK lost"))
            : original(data),
        );
      }
      expect(
        await reconcileTonInvoicesWithFixtureSettlement(
          input(),
          f.deps,
          f.hook,
        ),
      ).toEqual({
        kind: "stopped",
        reason: branch === "not_found" ? "settlement_not_found" : "db_error",
        processed: 0,
        pagesAdvanced: 0,
      });
      expect(f.settle).toHaveBeenCalledTimes(2);
      expect(f.deps.advanceCursor).not.toHaveBeenCalled();
    },
  );
  it.each(['reject','invalid','timeout'] as const)('preserves a known settlement stop while release %s remains operationally unknown',async mode=>{
    vi.useFakeTimers();const f=create({kind:'not_found'}),value=input(),budget=new TonOperationBudget(value.signal);
    if(mode==='reject')f.deps.releaseLease.mockRejectedValueOnce(new Error('release ACK lost'));
    else if(mode==='invalid')f.deps.releaseLease.mockResolvedValueOnce('invalid' as never);
    else f.deps.releaseLease.mockImplementationOnce(()=>new Promise(()=>{}));
    const result=reconcileTonInvoicesWithFixtureSettlement(value,f.deps,f.hook,budget);
    await vi.advanceTimersByTimeAsync(mode==='timeout'?10001:0);
    expect(await result).toEqual({kind:'stopped',reason:'settlement_not_found',processed:0,pagesAdvanced:0});
    expect(budget.mutationOutcome).toBe('unknown');expect(f.deps.advanceCursor).not.toHaveBeenCalled();expect(f.deps.releaseLease).toHaveBeenCalledTimes(1);
  });

});
