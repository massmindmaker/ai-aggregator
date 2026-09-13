import { describe, expect, it, vi } from "vitest";

import {
  createGatewaySettlementRecoveryLoop,
  parseGatewaySettlementRecoveryDatabaseUrl,
  parseGatewaySettlementRecoveryMode,
  startGatewaySettlementRecovery,
  type GatewaySettlementRecoveryDb,
  type GatewaySettlementRecoveryAck,
  type GatewaySettlementRecoveryHint,
  type GatewaySettlementRecoveryPosition,
} from "../gateway-settlement-recovery.js";

const timestamp = "2026-09-13T10:11:12.123456Z";
const laterTimestamp = "2026-09-13T10:11:12.123457Z";
const orgId = "00000000-0000-4000-8000-000000000001";
const apiKeyId = "00000000-0000-4000-8000-000000000002";
const billingId = "00000000-0000-4000-8000-000000000003";
const laterBillingId = "00000000-0000-4000-8000-000000000004";

function hint(overrides: Partial<GatewaySettlementRecoveryHint> = {}): GatewaySettlementRecoveryHint {
  return { orgId, apiKeyId, billingRequestId: billingId, reconcileAt: timestamp, ...overrides };
}

function position(overrides: Partial<GatewaySettlementRecoveryPosition> = {}): GatewaySettlementRecoveryPosition {
  return { reconcileAt: timestamp, billingRequestId: billingId, ...overrides };
}

function ack(item: GatewaySettlementRecoveryHint): GatewaySettlementRecoveryAck {
  return {
    orgId: item.orgId, apiKeyId: item.apiKeyId, billingRequestId: item.billingRequestId,
    state: "settled", routeKind: "chat", billingMode: "stored", outcomeKind: "success",
  };
}

function database(input: Partial<GatewaySettlementRecoveryDb> = {}): GatewaySettlementRecoveryDb {
  return {
    captureCycle: vi.fn(async () => ({ cycleDueBefore: laterTimestamp, upper: position() })),
    selectPage: vi.fn(async () => ({ hints: [] })),
    recover: vi.fn(async (item) => ack(item)),
    close: vi.fn(async () => undefined),
    ...input,
  };
}

describe("gateway settlement recovery parsers", () => {
  it("accepts only the two recovery modes", () => {
    expect(parseGatewaySettlementRecoveryMode(undefined)).toBe("disabled");
    expect(parseGatewaySettlementRecoveryMode("disabled")).toBe("disabled");
    expect(parseGatewaySettlementRecoveryMode("stored_chat_v1")).toBe("stored_chat_v1");
    expect(() => parseGatewaySettlementRecoveryMode("disabled ")).toThrow("invalid gateway settlement recovery mode");
  });

  it("accepts a safe opaque postgres URL without rewriting it", () => {
    const raw = "postgresql://user:secret@db.example.test:5432/recovery?application_name=worker";
    expect(parseGatewaySettlementRecoveryDatabaseUrl(raw)).toBe(raw);
  });

  it("accepts an exact postgres URL without rewriting it", () => {
    const raw = "postgres://user:secret@db.example.test:5432/recovery?application_name=worker";
    expect(parseGatewaySettlementRecoveryDatabaseUrl(raw)).toBe(raw);
  });

  it.each([
    "", " postgres://db/recovery", "postgres://db", "postgresql://db?application_name=worker", "postgres://db/", "https://db/recovery", "postgres:///recovery",
    "postgres://db/recovery#fragment", "postgres://db/recovery?statement_timeout=1",
    "postgres://db/recovery?QUERY_TIMEOUT=1", "postgres://db/recovery?options=-c%20x",
    "postgres://db/recovery?connect_timeout=1",
  ])("rejects unsafe database URLs without exposing input", (raw) => {
    expect(() => parseGatewaySettlementRecoveryDatabaseUrl(raw)).toThrow("invalid gateway settlement recovery database URL");
  });

  it("uses one fixed, secret-free failure for every invalid URL", () => {
    try {
      parseGatewaySettlementRecoveryDatabaseUrl("postgres://user:super-secret@db?options=unsafe");
      throw new Error("expected parser to reject the URL");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("invalid gateway settlement recovery database URL");
    }
  });

  it("rejects a decoded encoded forbidden database URL key", () => {
    expect(() => parseGatewaySettlementRecoveryDatabaseUrl("postgres://db/recovery?%73tatement_timeout=1"))
      .toThrow("invalid gateway settlement recovery database URL");
  });

  it("rejects every duplicate case-variant forbidden URL key occurrence", () => {
    expect(() => parseGatewaySettlementRecoveryDatabaseUrl("postgres://db/recovery?statement_timeout=1&STATEMENT_TIMEOUT=1"))
      .toThrow("invalid gateway settlement recovery database URL");
  });
});

describe("gateway settlement recovery loop", () => {
  it("returns complete for an empty captured window", async () => {
    const db = database({ captureCycle: vi.fn(async () => null) });
    const result = await createGatewaySettlementRecoveryLoop(db).runTick(() => false);
    expect(result).toMatchObject({ classification: "complete", selected: 0, attempted: 0, settled: 0, unconfirmed: 0, deferred: 0, cursor: null });
    expect(db.selectPage).not.toHaveBeenCalled();
  });

  it("rejects a malformed page before recovery", async () => {
    const db = database({ selectPage: vi.fn(async () => ({ hints: [hint({ reconcileAt: "bad" })] })) });
    const result = await createGatewaySettlementRecoveryLoop(db).runTick(() => false);
    expect(result.classification).toBe("selection_unavailable");
    expect(db.recover).not.toHaveBeenCalled();
  });

  it("rejects malformed capture timestamp and UUID before selecting", async () => {
    for (const capture of [
      { cycleDueBefore: "bad", upper: position() },
      { cycleDueBefore: laterTimestamp, upper: position({ billingRequestId: "not-a-uuid" }) },
      { cycleDueBefore: timestamp, upper: position({ reconcileAt: laterTimestamp }) },
    ]) {
      const db = database({ captureCycle: vi.fn(async () => capture) });
      const result = await createGatewaySettlementRecoveryLoop(db).runTick(() => false);
      expect(result).toMatchObject({ classification: "selection_unavailable", selected: 0, cursor: null });
      expect(db.selectPage).not.toHaveBeenCalled();
    }
  });

  it("closes an installed cycle on a valid empty page", async () => {
    const db = database({ selectPage: vi.fn(async () => ({ hints: [] })) });
    const result = await createGatewaySettlementRecoveryLoop(db).runTick(() => false);
    expect(result).toMatchObject({ classification: "complete", selected: 0, cursor: null });
    expect(db.selectPage).toHaveBeenCalledWith({ cycleDueBefore: laterTimestamp, after: null, upper: position(), limit: 20 });
  });

  it("keeps the complete cursor unchanged when a later page query fails", async () => {
    const upper = position({ billingRequestId: "00000000-0000-4000-8000-000000000030" });
    const firstPage = Array.from({ length: 20 }, (_, index) => hint({ billingRequestId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}` }));
    const db = database({
      captureCycle: vi.fn(async () => ({ cycleDueBefore: laterTimestamp, upper })),
      selectPage: vi.fn().mockResolvedValueOnce({ hints: firstPage }).mockRejectedValueOnce(new Error("selector lost")),
    });
    const loop = createGatewaySettlementRecoveryLoop(db);
    const beforeFailure = await loop.runTick(() => false);
    const failure = await loop.runTick(() => false);
    expect(failure).toMatchObject({ classification: "selection_unavailable", selected: 0, cursor: beforeFailure.cursor });
    expect(loop.getCursor()).toEqual(beforeFailure.cursor);
    expect(db.recover).toHaveBeenCalledTimes(20);
  });

  it("rejects an invalid UUID in a page before the first recover", async () => {
    const db = database({ selectPage: vi.fn(async () => ({ hints: [hint({ orgId: "bad" })] })) });
    expect((await createGatewaySettlementRecoveryLoop(db).runTick(() => false)).classification).toBe("selection_unavailable");
    expect(db.recover).not.toHaveBeenCalled();
  });

  it("uses microseconds and PostgreSQL UUID byte order for a complete page", async () => {
    const lower = hint({ billingRequestId: "00000000-0000-4000-8000-00000000000a" });
    const upper = hint({ billingRequestId: "00000000-0000-4000-8000-000000000010" });
    const db = database({
      captureCycle: vi.fn(async () => ({ cycleDueBefore: "2026-09-13T10:11:12.123458Z", upper: position({ billingRequestId: upper.billingRequestId }) })),
      selectPage: vi.fn(async () => ({ hints: [lower, upper] })),
    });
    const result = await createGatewaySettlementRecoveryLoop(db).runTick(() => false);
    expect(result).toMatchObject({ classification: "complete", selected: 2, settled: 2, cursor: null });
  });

  it("rejects duplicate, descending, and out-of-range pages before recovery", async () => {
    const first = hint();
    const upper = hint({ reconcileAt: laterTimestamp, billingRequestId: laterBillingId });
    for (const page of [[first, first], [upper, first], [hint({ reconcileAt: "2026-09-13T10:11:12.123459Z" })]]) {
      const db = database({
        captureCycle: vi.fn(async () => ({ cycleDueBefore: "2026-09-13T10:11:12.123458Z", upper: position({ reconcileAt: laterTimestamp, billingRequestId: laterBillingId }) })),
        selectPage: vi.fn(async () => ({ hints: page })),
      });
      expect((await createGatewaySettlementRecoveryLoop(db).runTick(() => false)).classification).toBe("selection_unavailable");
      expect(db.recover).not.toHaveBeenCalled();
    }
  });

  it("keeps the cycle after exactly 20 rows and closes it when the upper disappears", async () => {
    const upper = position({ reconcileAt: laterTimestamp, billingRequestId: "00000000-0000-4000-8000-000000000030" });
    const db = database({
      captureCycle: vi.fn(async () => ({ cycleDueBefore: "2026-09-13T10:11:12.123458Z", upper })),
      selectPage: vi.fn()
        .mockResolvedValueOnce({ hints: Array.from({ length: 20 }, (_, index) => hint({ billingRequestId: `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}` })) })
        .mockResolvedValueOnce({ hints: [] }),
    });
    const loop = createGatewaySettlementRecoveryLoop(db);
    const firstResult = await loop.runTick(() => false);
    expect(firstResult.cursor).not.toBeNull();
    expect(await loop.runTick(() => false)).toMatchObject({ classification: "complete", cursor: null });
    expect(db.captureCycle).toHaveBeenCalledTimes(1);
  });

  it("allows a newly visible pre-cutoff row only inside frozen tuple bounds", async () => {
    const upper = position({ billingRequestId: "00000000-0000-4000-8000-000000000030" });
    const firstPage = Array.from({ length: 20 }, (_, index) => hint({ billingRequestId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}` }));
    const lateButBounded = hint({ billingRequestId: "00000000-0000-4000-8000-000000000025" });
    const db = database({
      captureCycle: vi.fn(async () => ({ cycleDueBefore: laterTimestamp, upper })),
      selectPage: vi.fn().mockResolvedValueOnce({ hints: firstPage }).mockResolvedValueOnce({ hints: [lateButBounded] }),
    });
    const loop = createGatewaySettlementRecoveryLoop(db);
    await loop.runTick(() => false);
    const result = await loop.runTick(() => false);
    expect(result).toMatchObject({ classification: "complete", selected: 1, settled: 1, cursor: null });
    expect(db.selectPage).toHaveBeenLastCalledWith({ cycleDueBefore: laterTimestamp, after: position({ billingRequestId: "00000000-0000-4000-8000-000000000020" }), upper, limit: 20 });
  });

  it("defers rows below cursor or above frozen upper to the next cycle", async () => {
    const upper = position({ billingRequestId: "00000000-0000-4000-8000-000000000030" });
    const firstPage = Array.from({ length: 20 }, (_, index) => hint({ billingRequestId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}` }));
    for (const laterPage of [
      hint({ billingRequestId: "00000000-0000-4000-8000-000000000015" }),
      hint({ billingRequestId: "00000000-0000-4000-8000-000000000031" }),
    ]) {
      const db = database({
        captureCycle: vi.fn(async () => ({ cycleDueBefore: laterTimestamp, upper })),
        selectPage: vi.fn().mockResolvedValueOnce({ hints: firstPage }).mockResolvedValueOnce({ hints: [laterPage] }),
      });
      const loop = createGatewaySettlementRecoveryLoop(db);
      await loop.runTick(() => false);
      expect((await loop.runTick(() => false)).classification).toBe("selection_unavailable");
      expect(db.recover).toHaveBeenCalledTimes(20);
    }
  });

  it("waits for the next cycle when a post-cutoff outcome was not selected", async () => {
    const postCutoff = hint({ billingRequestId: laterBillingId });
    const db = database({
      captureCycle: vi.fn()
        .mockResolvedValueOnce({ cycleDueBefore: timestamp, upper: position() })
        .mockResolvedValueOnce({ cycleDueBefore: laterTimestamp, upper: position({ billingRequestId: laterBillingId }) }),
      selectPage: vi.fn().mockResolvedValueOnce({ hints: [] }).mockResolvedValueOnce({ hints: [postCutoff] }),
    });
    const loop = createGatewaySettlementRecoveryLoop(db);
    expect(await loop.runTick(() => false)).toMatchObject({ classification: "complete", selected: 0, cursor: null });
    expect(await loop.runTick(() => false)).toMatchObject({ classification: "complete", selected: 1, settled: 1 });
    expect(db.selectPage).toHaveBeenNthCalledWith(1, { cycleDueBefore: timestamp, after: null, upper: position(), limit: 20 });
    expect(db.recover).toHaveBeenCalledTimes(1);
  });

  it("waits for a new cycle when a pre-cutoff late commit is outside frozen bounds", async () => {
    const oldUpper = position({ billingRequestId: billingId });
    const lateOutsideOldWindow = hint({ billingRequestId: laterBillingId });
    const db = database({
      captureCycle: vi.fn()
        .mockResolvedValueOnce({ cycleDueBefore: timestamp, upper: oldUpper })
        .mockResolvedValueOnce({ cycleDueBefore: laterTimestamp, upper: position({ billingRequestId: laterBillingId }) }),
      selectPage: vi.fn().mockResolvedValueOnce({ hints: [] }).mockResolvedValueOnce({ hints: [lateOutsideOldWindow] }),
    });
    const loop = createGatewaySettlementRecoveryLoop(db);
    await loop.runTick(() => false);
    expect(await loop.runTick(() => false)).toMatchObject({ classification: "complete", selected: 1, settled: 1 });
    expect(db.captureCycle).toHaveBeenCalledTimes(2);
  });

  it("uses a later cycle to revisit an unconfirmed old prefix", async () => {
    const old = hint();
    const newer = hint({ billingRequestId: laterBillingId });
    const db = database({
      captureCycle: vi.fn().mockResolvedValue({ cycleDueBefore: laterTimestamp, upper: position({ billingRequestId: laterBillingId }) }),
      selectPage: vi.fn().mockResolvedValueOnce({ hints: [old, newer] }).mockResolvedValueOnce({ hints: [old] }),
      recover: vi.fn().mockRejectedValueOnce(new Error("lost ack")).mockImplementation(async (item) => ack(item)),
    });
    const loop = createGatewaySettlementRecoveryLoop(db);
    expect((await loop.runTick(() => false)).classification).toBe("partial_unconfirmed");
    expect(await loop.runTick(() => false)).toMatchObject({ classification: "complete", selected: 1, settled: 1 });
    expect(db.captureCycle).toHaveBeenCalledTimes(2);
    expect(db.recover).toHaveBeenCalledTimes(3);
  });

  it("does not call recover until an earlier rejection has settled", async () => {
    let rejectFirst: ((error: Error) => void) | undefined;
    const first = hint();
    const second = hint({ reconcileAt: laterTimestamp, billingRequestId: laterBillingId });
    const db = database({
      captureCycle: vi.fn(async () => ({ cycleDueBefore: "2026-09-13T10:11:12.123458Z", upper: position({ reconcileAt: laterTimestamp, billingRequestId: laterBillingId }) })),
      selectPage: vi.fn(async () => ({ hints: [first, second] })),
      recover: vi.fn((item) => item.billingRequestId === first.billingRequestId
        ? new Promise((_, reject) => { rejectFirst = reject; })
        : Promise.resolve(ack(item))),
    });
    const pending = createGatewaySettlementRecoveryLoop(db).runTick(() => false);
    await vi.waitFor(() => expect(db.recover).toHaveBeenCalledTimes(1));
    expect(db.recover).toHaveBeenCalledTimes(1);
    rejectFirst?.(new Error("lost acknowledgement"));
    await pending;
    expect(db.recover).toHaveBeenCalledTimes(2);
  });

  it("counts a mismatched acknowledgment as unconfirmed and advances", async () => {
    const item = hint();
    const db = database({
      selectPage: vi.fn(async () => ({ hints: [item] })),
      recover: vi.fn(async () => ({ orgId, apiKeyId, billingRequestId: laterBillingId, state: "settled", routeKind: "chat", billingMode: "stored", outcomeKind: "success" } as const)),
    });
    const result = await createGatewaySettlementRecoveryLoop(db).runTick(() => false);
    expect(result).toMatchObject({ classification: "partial_unconfirmed", selected: 1, attempted: 1, settled: 0, unconfirmed: 1, deferred: 0, cursor: null });
  });

  it("defers the suffix when stopped between candidates", async () => {
    let stopping = false;
    const first = hint();
    const second = hint({ reconcileAt: laterTimestamp, billingRequestId: laterBillingId });
    const db = database({
      captureCycle: vi.fn(async () => ({ cycleDueBefore: "2026-09-13T10:11:12.123458Z", upper: position({ reconcileAt: laterTimestamp, billingRequestId: laterBillingId }) })),
      selectPage: vi.fn(async () => ({ hints: [first, second] })),
      recover: vi.fn(async (item) => { stopping = true; return ack(item); }),
    });
    const result = await createGatewaySettlementRecoveryLoop(db).runTick(() => stopping);
    expect(result).toMatchObject({ classification: "stopped", selected: 2, attempted: 1, settled: 1, deferred: 1 });
    expect(db.recover).toHaveBeenCalledTimes(1);
  });

  it("stops before capture, before page, and before the first candidate", async () => {
    const beforeCapture = database();
    expect((await createGatewaySettlementRecoveryLoop(beforeCapture).runTick(() => true)).classification).toBe("stopped");
    expect(beforeCapture.captureCycle).not.toHaveBeenCalled();

    let stopBeforePage = false;
    const beforePage = database({ captureCycle: vi.fn(async () => { stopBeforePage = true; return { cycleDueBefore: laterTimestamp, upper: position() }; }) });
    const pageResult = await createGatewaySettlementRecoveryLoop(beforePage).runTick(() => stopBeforePage);
    expect(pageResult).toMatchObject({ classification: "stopped", selected: 0, cursor: { after: null } });
    expect(beforePage.selectPage).not.toHaveBeenCalled();

    let stopBeforeCandidate = false;
    const beforeCandidate = database({ selectPage: vi.fn(async () => { stopBeforeCandidate = true; return { hints: [hint()] }; }) });
    const candidateResult = await createGatewaySettlementRecoveryLoop(beforeCandidate).runTick(() => stopBeforeCandidate);
    expect(candidateResult).toMatchObject({ classification: "stopped", selected: 1, attempted: 0, deferred: 1 });
    expect(beforeCandidate.recover).not.toHaveBeenCalled();
  });
});

describe("gateway settlement recovery scheduler", () => {
  it("runs immediately, serializes ticks, and closes the DB once", async () => {
    let callback: (() => void) | undefined;
    const scheduler = { setTimeout: vi.fn((fn: () => void) => { callback = fn; return 1; }), clearTimeout: vi.fn() };
    const db = database({ captureCycle: vi.fn(async () => null) });
    const handle = startGatewaySettlementRecovery({ db, scheduler, onTick: vi.fn() });
    await vi.waitFor(() => expect(scheduler.setTimeout).toHaveBeenCalledTimes(1));
    callback?.();
    await vi.waitFor(() => expect(scheduler.setTimeout).toHaveBeenCalledTimes(2));
    const first = handle.close();
    const second = handle.close();
    expect(first).toBe(second);
    await first;
    expect(db.close).toHaveBeenCalledTimes(1);
  });

  it("does not overlap a scheduled tick even if its callback is invoked twice", async () => {
    const callbacks: Array<() => void> = [];
    let resolveSecondCapture: (() => void) | undefined;
    const scheduler = {
      setTimeout: vi.fn((callback: () => void) => { callbacks.push(callback); return callbacks.length; }),
      clearTimeout: vi.fn(),
    };
    const db = database({
      captureCycle: vi.fn()
        .mockResolvedValueOnce(null)
        .mockImplementationOnce(() => new Promise((resolve) => { resolveSecondCapture = () => resolve(null); })),
    });
    const handle = startGatewaySettlementRecovery({ db, scheduler, onTick: vi.fn() });
    await vi.waitFor(() => expect(callbacks).toHaveLength(1));
    callbacks[0]();
    await vi.waitFor(() => expect(db.captureCycle).toHaveBeenCalledTimes(2));
    callbacks[0]();
    expect(db.captureCycle).toHaveBeenCalledTimes(2);
    resolveSecondCapture?.();
    await vi.waitFor(() => expect(callbacks).toHaveLength(2));
    await handle.close();
  });

  it("stops during an unresolved candidate, counts it, and defers only its suffix", async () => {
    let resolveRecover: ((value: GatewaySettlementRecoveryAck) => void) | undefined;
    const first = hint();
    const second = hint({ reconcileAt: laterTimestamp, billingRequestId: laterBillingId });
    const results: unknown[] = [];
    const db = database({
      captureCycle: vi.fn(async () => ({ cycleDueBefore: "2026-09-13T10:11:12.123458Z", upper: position({ reconcileAt: laterTimestamp, billingRequestId: laterBillingId }) })),
      selectPage: vi.fn(async () => ({ hints: [first, second] })),
      recover: vi.fn(() => new Promise((resolve) => { resolveRecover = resolve; })),
    });
    const scheduler = { setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() };
    const handle = startGatewaySettlementRecovery({ db, scheduler, onTick: (tick) => results.push(tick) });
    await vi.waitFor(() => expect(db.recover).toHaveBeenCalledTimes(1));
    const closing = handle.close();
    resolveRecover?.(ack(first));
    await closing;
    expect(results).toContainEqual(expect.objectContaining({ classification: "stopped", selected: 2, attempted: 1, settled: 1, deferred: 1 }));
    expect(db.recover).toHaveBeenCalledTimes(1);
    expect(scheduler.setTimeout).not.toHaveBeenCalled();
  });

  it("clears a pending null timer handle before closing the DB", async () => {
    const events: string[] = [];
    const scheduler = {
      setTimeout: vi.fn(() => null),
      clearTimeout: vi.fn(() => { events.push("clear"); }),
    };
    const db = database({ captureCycle: vi.fn(async () => null), close: vi.fn(async () => { events.push("close"); }) });
    const handle = startGatewaySettlementRecovery({ db, scheduler, onTick: vi.fn() });
    await vi.waitFor(() => expect(scheduler.setTimeout).toHaveBeenCalledWith(expect.any(Function), 60_000));
    await handle.close();
    expect(scheduler.clearTimeout).toHaveBeenCalledTimes(1);
    expect(scheduler.clearTimeout).toHaveBeenCalledWith(null);
    expect(events).toEqual(["clear", "close"]);
  });
});
