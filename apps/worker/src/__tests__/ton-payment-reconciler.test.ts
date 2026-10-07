import { afterEach, describe, expect, it, vi } from "vitest";
import {
  reconcileTonInvoices,
  reconcileTonInvoice,
} from "../ton-payment-reconciler.js";
import {
  fixture,
  input,
  source,
  evidence,
  cursor,
  owner,
  address,
  deferred,
  invoice,
} from "./ton-recovery.fixture";
afterEach(() => vi.useRealTimers());
describe("native TON observation recovery", () => {
  it("commits observations between lease fences, never a credit or provider retry", async () => {
    const f = fixture();
    expect(await reconcileTonInvoices(input(), f.deps)).toEqual({
      kind: "completed",
      processed: 1,
      pagesAdvanced: 1,
    });
    expect(f.events).toEqual([
      "claim",
      "resolve",
      "bind",
      "renew",
      "scan",
      "renew",
      "find",
      "observe",
      "advance",
      "release",
    ]);
    expect(f.observations[0]).toMatchObject({
      invoiceId: invoice().invoiceId,
      result: { kind: "verified_candidate", reason: "verified_candidate" },
      snapshot: { reference: invoice().reference },
    });
    expect(JSON.stringify(f.observations)).not.toMatch(
      /transactions|rawBody|authorization|boc/i,
    );
  });
  it("takes the exact cursor only from claim, including the pinned transaction hash", async () => {
    const f = fixture(),
      c = cursor("1100", "1200");
    f.deps.claimLease.mockResolvedValueOnce({
      kind: "claimed",
      cursor: c,
      binding: {
        recipientAccount: address,
        derivation: { kind: "native", ownerAddress: address },
      },
    } as never);
    await reconcileTonInvoices(input(), f.deps);
    expect(f.deps.provider.scanAccountPage).toHaveBeenCalledWith(
      address,
      c,
      expect.any(AbortSignal),
    );
    expect(f.deps.advanceCursor).toHaveBeenCalledWith(
      expect.objectContaining({ expected: c, next: null }),
    );
  });
  it.each([{ cursor: null }, { limit: 0 }, { limit: 17 }])(
    "rejects injected cursor and invalid outer limits before claim: %j",
    async (patch) => {
      const f = fixture();
      await expect(
        reconcileTonInvoices({ ...input(), ...patch } as never, f.deps),
      ).rejects.toBeDefined();
      expect(f.events).toEqual([]);
    },
  );
  it.each([
    { sourceId: "a".repeat(64) },
    { network: "tvm:-239" },
    {
      asset: {
        kind: "jetton",
        network: "tvm:-3",
        decimals: 9,
        masterAddress: address,
      },
    },
    { invoiceRecipient: "http://evil.test" },
  ])(
    "source mismatch never starts network or database writes: %j",
    async (patch) => {
      const f = fixture();
      expect(
        await reconcileTonInvoices(
          { ...input(), source: { ...source(), ...patch } } as never,
          f.deps,
        ),
      ).toEqual({ kind: "not_started", reason: "source_identity_mismatch" });
      expect(f.events).toEqual([]);
    },
  );
  it.each(["busy", "source_identity_mismatch"] as const)(
    "honors claim %s with no caller cursor",
    async (kind) => {
      const f = fixture();
      f.deps.claimLease.mockResolvedValueOnce({ kind } as never);
      expect(await reconcileTonInvoices(input(), f.deps)).toEqual({
        kind: "not_started",
        reason: kind,
      });
      expect(f.events).toEqual([]);
    },
  );
  it("rejects malformed persisted cursor before any provider operation", async () => {
    const f = fixture();
    f.deps.claimLease.mockResolvedValueOnce({
      kind: "claimed",
      cursor: { ...cursor(), beforeLt: "01" },
      binding: null,
    } as never);
    expect(await reconcileTonInvoices(input(), f.deps)).toMatchObject({
      kind: "stopped",
      reason: "db_error",
    });
    expect(f.deps.provider.resolveRecipientAccount).not.toHaveBeenCalled();
  });
  it.each(["lease_lost", "cursor_conflict"] as const)(
    "stops before scan on pre-page %s",
    async (reason) => {
      const f = fixture();
      f.deps.renewLease.mockResolvedValueOnce(reason as never);
      expect(await reconcileTonInvoices(input(), f.deps)).toEqual({
        kind: "stopped",
        reason,
        processed: 0,
        pagesAdvanced: 0,
      });
      expect(f.deps.provider.scanAccountPage).not.toHaveBeenCalled();
    },
  );
  it.each(["lease_lost", "cursor_conflict"] as const)(
    "discards returned page after ownership %s",
    async (reason) => {
      const f = fixture();
      f.deps.renewLease
        .mockResolvedValueOnce("renewed")
        .mockResolvedValueOnce(reason as never);
      expect(await reconcileTonInvoices(input(), f.deps)).toMatchObject({
        kind: "stopped",
        reason,
      });
      expect(f.observations).toHaveLength(0);
      expect(f.deps.advanceCursor).not.toHaveBeenCalled();
    },
  );
  it("persists unknown reference once without changing any unrelated invoice", async () => {
    const f = fixture();
    f.deps.findInvoices.mockResolvedValue([]);
    await reconcileTonInvoices(input(), f.deps);
    await reconcileTonInvoices(input(), f.deps);
    expect(f.observations[0]).toMatchObject({
      invoiceId: null,
      result: { kind: "unmatched", reason: "invoice_reference_not_found" },
    });
    expect(f.committed.size).toBe(1);
  });
  it.each(["trace_incomplete", "finality_pending", "amount_mismatch"] as const)(
    "retains verifier classification %s without credit",
    async (reason) => {
      const f = fixture(),
        e = evidence();
      if (reason === "trace_incomplete") e.trace.complete = false;
      if (reason === "finality_pending") e.latestIndexedMasterchain.seqno = 101;
      if (reason === "amount_mismatch")
        e.transactions[0].inMessage.amountAtomic = "2";
      f.deps.provider.scanAccountPage.mockResolvedValue({
        kind: "page",
        evidence: [e],
        nextCursor: null,
        exhausted: true,
      });
      await reconcileTonInvoices(input(), f.deps);
      expect(f.observations[0].result.reason).toBe(reason);
    },
  );
  it("does not lose previous successful pages on a later provider error", async () => {
    const f = fixture();
    f.deps.provider.scanAccountPage
      .mockResolvedValueOnce({
        kind: "page",
        evidence: [evidence()],
        nextCursor: cursor(),
        exhausted: false,
      } as never)
      .mockResolvedValueOnce({
        kind: "source_error",
        code: "rate_limited",
        retryAfterMs: 5000,
      } as never);
    expect(await reconcileTonInvoices(input(), f.deps)).toEqual({
      kind: "source_error",
      code: "rate_limited",
      processed: 1,
      pagesAdvanced: 1,
    });
    expect(f.deps.advanceCursor).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expected: cursor(),
        next: cursor(),
        outcome: "source_error",
        retryAfterMs: 5000,
      }),
    );
  });
  it("keeps the fourth nonterminal page cursor, rather than resetting unread history", async () => {
    const f = fixture();
    for (const lt of ["1000", "900", "800", "700"])
      f.deps.provider.scanAccountPage.mockResolvedValueOnce({
        kind: "page",
        evidence: [evidence(lt)],
        nextCursor: cursor(lt),
        exhausted: false,
      } as never);
    expect(await reconcileTonInvoices(input(), f.deps)).toEqual({
      kind: "completed",
      processed: 4,
      pagesAdvanced: 4,
    });
    expect(f.deps.advanceCursor).toHaveBeenLastCalledWith(
      expect.objectContaining({ next: cursor("700") }),
    );
  });
  it("null-resets at source floor only after eligible observations", async () => {
    const f = fixture(),
      e = evidence();
    e.transactions[0].chainTimeMs = 1699999800000;
    f.deps.provider.scanAccountPage.mockResolvedValueOnce({
      kind: "page",
      evidence: [e],
      nextCursor: cursor(),
      exhausted: false,
    } as never);
    expect(await reconcileTonInvoices(input(), f.deps)).toEqual({
      kind: "completed",
      processed: 0,
      pagesAdvanced: 1,
    });
    expect(f.observations).toHaveLength(0);
    expect(f.deps.advanceCursor).toHaveBeenCalledWith(
      expect.objectContaining({ next: null }),
    );
  });
  it("does not advance partial observations on a failed durable write", async () => {
    const f = fixture();
    f.deps.recordObservation.mockRejectedValueOnce(
      Error("lost observation ACK"),
    );
    expect(await reconcileTonInvoices(input(), f.deps)).toEqual({
      kind: "stopped",
      reason: "db_error",
      processed: 0,
      pagesAdvanced: 0,
    });
    expect(f.deps.advanceCursor).not.toHaveBeenCalled();
    expect(await reconcileTonInvoices(input(), f.deps)).toMatchObject({
      kind: "completed",
      processed: 1,
    });
  });
  it("treats an unknown advance ACK as requiring a fresh claim, without returning a cursor", async () => {
    const f = fixture();
    f.deps.advanceCursor.mockRejectedValueOnce(Error("lost commit ACK"));
    const r = await reconcileTonInvoices(input(), f.deps);
    expect(r).toMatchObject({
      kind: "stopped",
      reason: "db_error",
      pagesAdvanced: 0,
    });
    expect(r).not.toHaveProperty("cursor");
    expect(f.committed.size).toBe(1);
  });
  it("empty terminal pages record absence at source level rather than marking invoices failed", async () => {
    const f = fixture();
    f.deps.provider.scanAccountPage.mockResolvedValueOnce({
      kind: "page",
      evidence: [],
      nextCursor: null,
      exhausted: true,
    });
    expect(await reconcileTonInvoices(input(), f.deps)).toMatchObject({
      processed: 0,
      pagesAdvanced: 1,
    });
    expect(f.observations[0]).toMatchObject({
      invoiceId: null,
      eventIdentity: null,
      result: { kind: "observed", reason: "candidate_not_found" },
    });
  });
  it("on-demand reconciliation still uses a durable claim and refuses a supplied cursor", async () => {
    const f = fixture();
    expect(
      await reconcileTonInvoice(
        {
          invoiceId: invoice().invoiceId,
          cursor: null,
          limit: 16,
          signal: input().signal,
        },
        f.deps,
      ),
    ).toMatchObject({ kind: "verified_candidate" });
    await expect(
      reconcileTonInvoice(
        {
          invoiceId: invoice().invoiceId,
          cursor: cursor(),
          limit: 16,
          signal: input().signal,
        },
        f.deps,
      ),
    ).rejects.toBeDefined();
  });
  it("does not report no candidate when on-demand work was never allowed to start", async () => {
    const f = fixture();
    f.deps.claimLease.mockResolvedValueOnce({ kind: "busy" } as never);
    expect(
      await reconcileTonInvoice(
        {
          invoiceId: invoice().invoiceId,
          cursor: null,
          limit: 16,
          signal: input().signal,
        },
        f.deps,
      ),
    ).toEqual({ kind: "source_error", code: "timeout" });
  });
});

describe("masterchain crosscheck gate (plan task 1.3)", () => {
  it("keeps a verified candidate only when both indexers agree", async () => {
    const f = fixture();
    f.deps.crosscheckMasterchain = vi.fn(async () => ({ kind: "agree" } as const));
    expect(await reconcileTonInvoices(input(), f.deps)).toEqual({
      kind: "completed",
      processed: 1,
      pagesAdvanced: 1,
    });
    expect(f.deps.crosscheckMasterchain).toHaveBeenCalledTimes(1);
    expect(f.observations[0]).toMatchObject({
      result: { kind: "verified_candidate", reason: "verified_candidate" },
    });
  });

  it("downgrades a verified candidate to finality_pending when the secondary source lags", async () => {
    const f = fixture();
    f.deps.crosscheckMasterchain = vi.fn(async () => ({ kind: "lag" } as const));
    expect(await reconcileTonInvoices(input(), f.deps)).toEqual({
      kind: "completed",
      processed: 1,
      pagesAdvanced: 1,
    });
    expect(f.observations[0]).toMatchObject({
      result: { kind: "observed", reason: "finality_pending" },
    });
  });

  it("routes a secondary root mismatch to review_required without trusting the primary", async () => {
    const f = fixture();
    f.deps.crosscheckMasterchain = vi.fn(async () => ({ kind: "mismatch" } as const));
    await reconcileTonInvoices(input(), f.deps);
    expect(f.observations[0]).toMatchObject({
      result: {
        kind: "review_required",
        reason: "settlement_evidence_conflict",
      },
    });
  });

  it("degrades open when the secondary source is unavailable", async () => {
    const f = fixture();
    f.deps.crosscheckMasterchain = vi.fn(async () => ({ kind: "unavailable" } as const));
    await reconcileTonInvoices(input(), f.deps);
    expect(f.observations[0]).toMatchObject({
      result: { kind: "verified_candidate", reason: "verified_candidate" },
    });
  });

  it("never consults the secondary source for a non-verified outcome", async () => {
    const f = fixture();
    f.deps.getInvoice = vi.fn(async () => null);
    f.deps.findInvoices = vi.fn(async () => []);
    f.deps.crosscheckMasterchain = vi.fn(async () => ({ kind: "agree" } as const));
    await reconcileTonInvoices(input(), f.deps);
    expect(f.deps.crosscheckMasterchain).not.toHaveBeenCalled();
    expect(f.observations[0]).toMatchObject({
      result: { kind: "unmatched", reason: "invoice_reference_not_found" },
    });
  });
});
