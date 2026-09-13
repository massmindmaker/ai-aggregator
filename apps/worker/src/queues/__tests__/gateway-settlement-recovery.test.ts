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

  it.each([
    "", " postgres://db/recovery", "postgres://db/", "https://db/recovery", "postgres:///recovery",
    "postgres://db/recovery#fragment", "postgres://db/recovery?statement_timeout=1",
    "postgres://db/recovery?QUERY_TIMEOUT=1", "postgres://db/recovery?options=-c%20x",
    "postgres://db/recovery?connect_timeout=1",
  ])("rejects unsafe database URLs without exposing input", (raw) => {
    expect(() => parseGatewaySettlementRecoveryDatabaseUrl(raw)).toThrow("invalid gateway settlement recovery database URL");
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

  it("retains a full page below upper and reuses its frozen cycle", async () => {
    const first = hint();
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
});
