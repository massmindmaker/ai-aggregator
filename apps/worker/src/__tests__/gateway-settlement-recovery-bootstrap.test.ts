import { Writable } from "node:stream";

import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  GatewaySettlementRecoveryBoundaryError,
  logGatewaySettlementRecoveryBoundaryFailure,
  parseGatewaySettlementRecoveryStartupConfig,
  startGatewaySettlementRecoveryFromEnv,
  type GatewaySettlementRecoveryLogger,
} from "../gateway-settlement-recovery-bootstrap.js";
import type {
  GatewaySettlementRecoveryAck,
  GatewaySettlementRecoveryDb,
  GatewaySettlementRecoveryHint,
  GatewaySettlementRecoveryScheduler,
} from "../queues/gateway-settlement-recovery.js";

const databaseUrl = "postgresql://worker:super-secret@db.example.test:5432/recovery?application_name=worker";
const recoverySql = "SELECT * FROM aiag_recover_gateway_http_settlement_v1($1, $2, $3)";
const timestamp = "2026-09-13T10:11:12.123456Z";
const orgId = "00000000-0000-4000-8000-000000000001";
const apiKeyId = "00000000-0000-4000-8000-000000000002";
const billingRequestId = "00000000-0000-4000-8000-000000000003";

function hint(): GatewaySettlementRecoveryHint {
  return { orgId, apiKeyId, billingRequestId, reconcileAt: timestamp };
}

function ack(item: GatewaySettlementRecoveryHint): GatewaySettlementRecoveryAck {
  return {
    orgId: item.orgId,
    apiKeyId: item.apiKeyId,
    billingRequestId: item.billingRequestId,
    state: "settled",
    routeKind: "chat",
    billingMode: "stored",
    outcomeKind: "success",
  };
}

function database(overrides: Partial<GatewaySettlementRecoveryDb> = {}): GatewaySettlementRecoveryDb {
  return {
    captureCycle: vi.fn(async () => null),
    selectPage: vi.fn(async () => ({ hints: [] })),
    recover: vi.fn(async (item) => ack(item)),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

function scheduler(): GatewaySettlementRecoveryScheduler & { callbacks: Array<() => void> } {
  const callbacks: Array<() => void> = [];
  return {
    callbacks,
    setTimeout: vi.fn((callback: () => void) => {
      callbacks.push(callback);
      return callbacks.length;
    }),
    clearTimeout: vi.fn(),
  };
}

function capturedPino(): Readonly<{
  logger: GatewaySettlementRecoveryLogger;
  records: Array<Record<string, unknown>>;
}> {
  const records: Array<Record<string, unknown>> = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      records.push(JSON.parse(String(chunk)) as Record<string, unknown>);
      callback();
    },
  });
  return {
    logger: pino({ base: null, timestamp: false }, destination),
    records,
  };
}

function withoutLevel(record: Record<string, unknown>): Record<string, unknown> {
  const { level: _level, ...binding } = record;
  return binding;
}

function expectFixedBoundary(error: unknown): void {
  expect(error).toBeInstanceOf(GatewaySettlementRecoveryBoundaryError);
  expect(error).toMatchObject({
    name: "GatewaySettlementRecoveryBoundaryError",
    message: "gateway settlement recovery startup refused",
    classification: "startup_refused",
  });
  expect(Object.prototype.hasOwnProperty.call(error, "cause")).toBe(false);
}

describe("gateway settlement recovery startup config", () => {
  it("returns disabled before reading poisoned local-mode and database values", () => {
    const reads: string[] = [];
    const env = new Proxy({ GATEWAY_SETTLEMENT_RECOVERY_MODE: "disabled" }, {
      get(target, property, receiver) {
        reads.push(String(property));
        if (property === "GATEWAY_HTTP_EXECUTION_MODE" || property === "DATABASE_URL") {
          throw new Error("poisoned value was read");
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(parseGatewaySettlementRecoveryStartupConfig(env)).toEqual({ mode: "disabled" });
    expect(reads).toEqual(["GATEWAY_SETTLEMENT_RECOVERY_MODE"]);
  });

  it.each([undefined, "legacy", "stored_chat_only ", "arbitrary"])(
    "rejects enabled recovery without exact stored_chat_only agreement (%s)",
    (httpExecutionMode) => {
      let databaseReads = 0;
      const env = new Proxy({
        GATEWAY_SETTLEMENT_RECOVERY_MODE: "stored_chat_v1",
        GATEWAY_HTTP_EXECUTION_MODE: httpExecutionMode,
      }, {
        get(target, property, receiver) {
          if (property === "DATABASE_URL") databaseReads += 1;
          return Reflect.get(target, property, receiver);
        },
      });
      try {
        parseGatewaySettlementRecoveryStartupConfig(env);
        throw new Error("expected startup refusal");
      } catch (error) {
        expectFixedBoundary(error);
      }
      expect(databaseReads).toBe(0);
    },
  );

  it("rejects an invalid recovery mode with the fixed boundary error", () => {
    try {
      parseGatewaySettlementRecoveryStartupConfig({ GATEWAY_SETTLEMENT_RECOVERY_MODE: "disabled " });
      throw new Error("expected startup refusal");
    } catch (error) {
      expectFixedBoundary(error);
    }
  });

  it.each([
    "",
    " postgres://db/recovery",
    "postgres://db",
    "postgresql://db?application_name=worker",
    "postgres://db/",
    "https://db/recovery",
    "postgres:///recovery",
    "postgres://db/recovery#fragment",
    "postgres://db/recovery?statement_timeout=1",
    "postgres://db/recovery?QUERY_TIMEOUT=1",
    "postgres://db/recovery?options=-c%20x",
    "postgres://db/recovery?connect_timeout=1",
    "postgres://db/recovery?%73tatement_timeout=1",
    "postgres://db/recovery?statement_timeout=1&STATEMENT_TIMEOUT=1",
  ])("rejects unsafe URL before loading the database capability: %s", async (raw) => {
    const loadDb = vi.fn(async () => database());
    await expect(startGatewaySettlementRecoveryFromEnv({
      env: {
        GATEWAY_SETTLEMENT_RECOVERY_MODE: "stored_chat_v1",
        GATEWAY_HTTP_EXECUTION_MODE: "stored_chat_only",
        DATABASE_URL: raw,
      },
      logger: capturedPino().logger,
      loadDb,
    })).rejects.toBeInstanceOf(GatewaySettlementRecoveryBoundaryError);
    expect(loadDb).not.toHaveBeenCalled();
  });

  it.each([
    "postgres://worker:secret@db.example.test:5432/recovery?application_name=worker",
    databaseUrl,
  ])("preserves a valid opaque URL after exact local-mode agreement", (raw) => {
    expect(parseGatewaySettlementRecoveryStartupConfig({
      GATEWAY_SETTLEMENT_RECOVERY_MODE: "stored_chat_v1",
      GATEWAY_HTTP_EXECUTION_MODE: "stored_chat_only",
      DATABASE_URL: raw,
    })).toEqual({ mode: "stored_chat_v1", httpExecutionMode: "stored_chat_only", databaseUrl: raw });
  });

  it("pairs combined execution with the explicit combined recovery mode", async () => {
    expect(parseGatewaySettlementRecoveryStartupConfig({
      GATEWAY_SETTLEMENT_RECOVERY_MODE: "stored_chat_embeddings_v1",
      GATEWAY_HTTP_EXECUTION_MODE: "stored_chat_embeddings",
      DATABASE_URL: databaseUrl,
    })).toEqual({
      mode: "stored_chat_embeddings_v1",
      httpExecutionMode: "stored_chat_embeddings",
      databaseUrl,
    });
    const db = database();
    const loadDb = vi.fn(async () => db);
    const handle = await startGatewaySettlementRecoveryFromEnv({
      env: {
        GATEWAY_SETTLEMENT_RECOVERY_MODE: "stored_chat_embeddings_v1",
        GATEWAY_HTTP_EXECUTION_MODE: "stored_chat_embeddings",
        DATABASE_URL: databaseUrl,
      },
      logger: capturedPino().logger,
      loadDb,
    });
    expect(loadDb).toHaveBeenCalledWith(databaseUrl, ["chat", "embeddings"]);
    await handle?.close();
  });

  it("pairs completions execution with the strict three-route recovery mode", async () => {
    expect(parseGatewaySettlementRecoveryStartupConfig({
      GATEWAY_SETTLEMENT_RECOVERY_MODE: "stored_chat_embeddings_completions_v1",
      GATEWAY_HTTP_EXECUTION_MODE: "stored_chat_embeddings_completions",
      DATABASE_URL: databaseUrl,
    })).toEqual({
      mode: "stored_chat_embeddings_completions_v1",
      httpExecutionMode: "stored_chat_embeddings_completions",
      databaseUrl,
    });
    const db = database();
    const loadDb = vi.fn(async () => db);
    const handle = await startGatewaySettlementRecoveryFromEnv({
      env: {
        GATEWAY_SETTLEMENT_RECOVERY_MODE: "stored_chat_embeddings_completions_v1",
        GATEWAY_HTTP_EXECUTION_MODE: "stored_chat_embeddings_completions",
        DATABASE_URL: databaseUrl,
      },
      logger: capturedPino().logger,
      loadDb,
    });
    expect(loadDb).toHaveBeenCalledWith(databaseUrl, ["chat", "embeddings", "completions"]);
    await handle?.close();
  });

  it("refuses a completions recovery mode paired with an older execution mode", () => {
    expect(() => parseGatewaySettlementRecoveryStartupConfig({
      GATEWAY_SETTLEMENT_RECOVERY_MODE: "stored_chat_embeddings_completions_v1",
      GATEWAY_HTTP_EXECUTION_MODE: "stored_chat_embeddings",
      DATABASE_URL: databaseUrl,
    })).toThrow(GatewaySettlementRecoveryBoundaryError);
  });
});

describe("gateway settlement recovery bootstrap boundary", () => {
  it("is inert while disabled even when later values and seams are poisoned", async () => {
    const log = capturedPino();
    const loadDb = vi.fn(async () => { throw new Error("database loader called"); });
    const poisonedScheduler = {
      setTimeout: vi.fn(() => { throw new Error("timer called"); }),
      clearTimeout: vi.fn(() => { throw new Error("timer clear called"); }),
    };

    expect(await startGatewaySettlementRecoveryFromEnv({
      env: {
        GATEWAY_SETTLEMENT_RECOVERY_MODE: "disabled",
        GATEWAY_HTTP_EXECUTION_MODE: "poisoned",
        DATABASE_URL: "poisoned",
      },
      logger: log.logger,
      scheduler: poisonedScheduler,
      loadDb,
    })).toBeNull();
    expect(loadDb).not.toHaveBeenCalled();
    expect(poisonedScheduler.setTimeout).not.toHaveBeenCalled();
    expect(poisonedScheduler.clearTimeout).not.toHaveBeenCalled();
    expect(log.records).toEqual([]);
  });

  it.each([
    { GATEWAY_SETTLEMENT_RECOVERY_MODE: "invalid", GATEWAY_HTTP_EXECUTION_MODE: "stored_chat_only" },
    { GATEWAY_SETTLEMENT_RECOVERY_MODE: "stored_chat_v1", GATEWAY_HTTP_EXECUTION_MODE: undefined },
    { GATEWAY_SETTLEMENT_RECOVERY_MODE: "stored_chat_v1", GATEWAY_HTTP_EXECUTION_MODE: "legacy" },
    { GATEWAY_SETTLEMENT_RECOVERY_MODE: "stored_chat_v1", GATEWAY_HTTP_EXECUTION_MODE: "arbitrary" },
  ])("refuses mode disagreement before database loading", async (env) => {
    const loadDb = vi.fn(async () => database());
    await expect(startGatewaySettlementRecoveryFromEnv({
      env: { ...env, DATABASE_URL: databaseUrl },
      logger: capturedPino().logger,
      loadDb,
    })).rejects.toBeInstanceOf(GatewaySettlementRecoveryBoundaryError);
    expect(loadDb).not.toHaveBeenCalled();
  });

  it("refuses a missing database URL before database loading", async () => {
    const loadDb = vi.fn(async () => database());
    await expect(startGatewaySettlementRecoveryFromEnv({
      env: { GATEWAY_SETTLEMENT_RECOVERY_MODE: "stored_chat_v1", GATEWAY_HTTP_EXECUTION_MODE: "stored_chat_only" },
      logger: capturedPino().logger,
      loadDb,
    })).rejects.toBeInstanceOf(GatewaySettlementRecoveryBoundaryError);
    expect(loadDb).not.toHaveBeenCalled();
  });

  it("starts immediately, logs a fixed complete tick, and schedules only after completion", async () => {
    let finishCapture: (() => void) | undefined;
    const db = database({ captureCycle: vi.fn(() => new Promise((resolve) => { finishCapture = () => resolve(null); })) });
    const timers = scheduler();
    const log = capturedPino();
    const loadDb = vi.fn(async () => db);

    const handle = await startGatewaySettlementRecoveryFromEnv({
      env: {
        GATEWAY_SETTLEMENT_RECOVERY_MODE: "stored_chat_v1",
        GATEWAY_HTTP_EXECUTION_MODE: "stored_chat_only",
        DATABASE_URL: databaseUrl,
      },
      logger: log.logger,
      scheduler: timers,
      loadDb,
    });

    expect(handle).not.toBeNull();
    expect(loadDb).toHaveBeenCalledWith(databaseUrl, ["chat"]);
    expect(db.captureCycle).toHaveBeenCalledTimes(1);
    expect(timers.setTimeout).not.toHaveBeenCalled();
    finishCapture?.();
    await vi.waitFor(() => expect(timers.setTimeout).toHaveBeenCalledWith(expect.any(Function), 60_000));
    expect(log.records.map(withoutLevel)).toEqual([{
      component: "gateway_settlement_recovery",
      classification: "complete",
      selected: 0,
      attempted: 0,
      settled: 0,
      unconfirmed: 0,
      deferred: 0,
      msg: "gateway settlement recovery tick complete",
    }]);
    await handle?.close();
    expect(timers.clearTimeout).toHaveBeenCalledTimes(1);
    expect(db.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["selection_unavailable", "gateway settlement recovery selection unavailable", "warn"],
    ["partial_unconfirmed", "gateway settlement recovery tick unconfirmed", "warn"],
  ] as const)("logs %s with exact safe counters", async (classification, message, method) => {
    const item = hint();
    const db = classification === "selection_unavailable"
      ? database({ captureCycle: vi.fn(async () => { throw new Error(`${databaseUrl} ${recoverySql}`); }) })
      : database({
        captureCycle: vi.fn(async () => ({ cycleDueBefore: timestamp, upper: { reconcileAt: timestamp, billingRequestId } })),
        selectPage: vi.fn(async () => ({ hints: [item] })),
        recover: vi.fn(async () => { throw new Error(`${databaseUrl} ${recoverySql}`); }),
      });
    const timers = scheduler();
    const log = capturedPino();
    const handle = await startGatewaySettlementRecoveryFromEnv({
      env: { GATEWAY_SETTLEMENT_RECOVERY_MODE: "stored_chat_v1", GATEWAY_HTTP_EXECUTION_MODE: "stored_chat_only", DATABASE_URL: databaseUrl },
      logger: log.logger,
      scheduler: timers,
      loadDb: async () => db,
    });
    await vi.waitFor(() => expect(log.records).toHaveLength(1));
    expect(log.records[0].level).toBe(method === "warn" ? 40 : 30);
    expect(withoutLevel(log.records[0])).toEqual({
      component: "gateway_settlement_recovery",
      classification,
      selected: classification === "partial_unconfirmed" ? 1 : 0,
      attempted: classification === "partial_unconfirmed" ? 1 : 0,
      settled: 0,
      unconfirmed: classification === "partial_unconfirmed" ? 1 : 0,
      deferred: 0,
      msg: message,
    });
    await handle?.close();
  });

  it("waits for an active item, logs stopped, starts no later work, and closes once", async () => {
    let finishRecovery: ((value: GatewaySettlementRecoveryAck) => void) | undefined;
    const first = hint();
    const second = { ...hint(), billingRequestId: "00000000-0000-4000-8000-000000000004" };
    const db = database({
      captureCycle: vi.fn(async () => ({ cycleDueBefore: timestamp, upper: { reconcileAt: timestamp, billingRequestId: second.billingRequestId } })),
      selectPage: vi.fn(async () => ({ hints: [first, second] })),
      recover: vi.fn(() => new Promise((resolve) => { finishRecovery = resolve; })),
    });
    const timers = scheduler();
    const log = capturedPino();
    const handle = await startGatewaySettlementRecoveryFromEnv({
      env: { GATEWAY_SETTLEMENT_RECOVERY_MODE: "stored_chat_v1", GATEWAY_HTTP_EXECUTION_MODE: "stored_chat_only", DATABASE_URL: databaseUrl },
      logger: log.logger,
      scheduler: timers,
      loadDb: async () => db,
    });
    await vi.waitFor(() => expect(db.recover).toHaveBeenCalledTimes(1));
    const firstClose = handle?.close();
    const secondClose = handle?.close();
    expect(firstClose).toBe(secondClose);
    finishRecovery?.(ack(first));
    await firstClose;

    expect(db.recover).toHaveBeenCalledTimes(1);
    expect(db.selectPage).toHaveBeenCalledTimes(1);
    expect(timers.setTimeout).not.toHaveBeenCalled();
    expect(db.close).toHaveBeenCalledTimes(1);
    expect(log.records.map(withoutLevel)).toEqual([{
      component: "gateway_settlement_recovery",
      classification: "stopped",
      selected: 2,
      attempted: 1,
      settled: 1,
      unconfirmed: 0,
      deferred: 1,
      msg: "gateway settlement recovery tick stopped",
    }]);
  });

  it("closes a returned capability when later setup fails", async () => {
    const db = database({ close: vi.fn(async () => { throw new Error(`cleanup failed ${databaseUrl} ${recoverySql}`); }) });
    const input = {
      env: { GATEWAY_SETTLEMENT_RECOVERY_MODE: "stored_chat_v1", GATEWAY_HTTP_EXECUTION_MODE: "stored_chat_only", DATABASE_URL: databaseUrl },
      logger: capturedPino().logger,
      loadDb: vi.fn(async () => db),
      get scheduler(): GatewaySettlementRecoveryScheduler {
        throw new Error(`${databaseUrl} ${recoverySql}`);
      },
    };
    await expect(startGatewaySettlementRecoveryFromEnv(input)).rejects.toBeInstanceOf(GatewaySettlementRecoveryBoundaryError);
    expect(db.close).toHaveBeenCalledTimes(1);
  });

  it("sanitizes startup and close failures through actual Pino serialization", async () => {
    const startupLog = capturedPino();
    let startupError: unknown;
    try {
      await startGatewaySettlementRecoveryFromEnv({
        env: { GATEWAY_SETTLEMENT_RECOVERY_MODE: "stored_chat_v1", GATEWAY_HTTP_EXECUTION_MODE: "stored_chat_only", DATABASE_URL: databaseUrl },
        logger: startupLog.logger,
        loadDb: async () => {
          const error = new Error(`driver failed ${databaseUrl} ${recoverySql}`);
          Object.assign(error, { row: { prompt: "secret-row" }, error: "nested-secret" });
          throw error;
        },
      });
    } catch (error) {
      startupError = error;
    }
    expectFixedBoundary(startupError);
    expect(logGatewaySettlementRecoveryBoundaryFailure(startupLog.logger, startupError)).toBe(true);
    expect(logGatewaySettlementRecoveryBoundaryFailure(startupLog.logger, new Error("unrelated"))).toBe(false);
    expect(startupLog.records.map(withoutLevel)).toEqual([{
      component: "gateway_settlement_recovery",
      classification: "startup_refused",
      msg: "gateway settlement recovery startup refused",
    }]);

    const closeLog = capturedPino();
    const rawCloseFailure = new Error(`close failed ${databaseUrl} ${recoverySql}`);
    Object.assign(rawCloseFailure, { row: { response: "secret-row" }, cause: new Error("nested-secret") });
    const db = database({ close: vi.fn(async () => { throw rawCloseFailure; }) });
    const timers = scheduler();
    const handle = await startGatewaySettlementRecoveryFromEnv({
      env: { GATEWAY_SETTLEMENT_RECOVERY_MODE: "stored_chat_v1", GATEWAY_HTTP_EXECUTION_MODE: "stored_chat_only", DATABASE_URL: databaseUrl },
      logger: closeLog.logger,
      scheduler: timers,
      loadDb: async () => db,
    });
    await vi.waitFor(() => expect(timers.setTimeout).toHaveBeenCalledTimes(1));
    await expect(handle?.close()).resolves.toBeUndefined();
    expect(db.close).toHaveBeenCalledTimes(1);
    expect(closeLog.records.map(withoutLevel)).toEqual([
      {
        component: "gateway_settlement_recovery",
        classification: "complete",
        selected: 0,
        attempted: 0,
        settled: 0,
        unconfirmed: 0,
        deferred: 0,
        msg: "gateway settlement recovery tick complete",
      },
      {
        component: "gateway_settlement_recovery",
        classification: "close_unavailable",
        msg: "gateway settlement recovery close unavailable",
      },
    ]);

    const serialized = JSON.stringify([...startupLog.records, ...closeLog.records]);
    for (const forbidden of [
      "super-secret",
      databaseUrl,
      recoverySql,
      "driver failed",
      "close failed",
      "secret-row",
      "nested-secret",
      "\"err\"",
      "\"error\"",
      "\"cause\"",
      "\"row\"",
      "\"stack\"",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
