import { beforeEach, describe, expect, it, vi } from "vitest";

const pgMock = vi.hoisted(() => ({
  instances: [] as Array<{
    options: Record<string, unknown>;
    query: ReturnType<typeof vi.fn<[{ text: string; values: readonly unknown[] }], Promise<unknown> | undefined>>;
    connect: ReturnType<typeof vi.fn<[], undefined>>;
    end: ReturnType<typeof vi.fn<[], Promise<void>>>;
  }>,
  queryImplementation: undefined as
    | ((config: { text: string; values: readonly unknown[] }) => Promise<unknown>)
    | undefined,
  endImplementation: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("pg", () => ({
  Pool: class MockPool {
    readonly record: (typeof pgMock.instances)[number];

    constructor(options: Record<string, unknown>) {
      this.record = {
        options,
        query: vi.fn((config) => pgMock.queryImplementation?.(config)),
        connect: vi.fn(),
        end: vi.fn(() => pgMock.endImplementation?.() ?? Promise.resolve()),
      };
      pgMock.instances.push(this.record);
    }

    query(config: { text: string; values: readonly unknown[] }) {
      return this.record.query(config);
    }

    connect() {
      return this.record.connect();
    }

    end() {
      return this.record.end();
    }
  },
}));

import {
  CAPTURE_GATEWAY_SETTLEMENT_RECOVERY_CYCLE_SQL,
  RECOVER_GATEWAY_HTTP_SETTLEMENT_SQL,
  SELECT_GATEWAY_SETTLEMENT_RECOVERY_PAGE_SQL,
  createGatewaySettlementRecoveryDb,
} from "../gateway-settlement-recovery-db.js";

const databaseUrl = "postgresql://worker:secret@db.example.test:5432/recovery?application_name=worker";
const timestamp = "2026-09-13T10:11:12.123456Z";
const cutoff = "2026-09-13T10:11:12.123457Z";
const orgId = "00000000-0000-4000-8000-000000000001";
const apiKeyId = "00000000-0000-4000-8000-000000000002";
const billingRequestId = "00000000-0000-4000-8000-000000000003";

function normalized(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function result(rows: unknown[], rowCount: number | null = rows.length) {
  return Promise.resolve({ rows, rowCount });
}

function pool() {
  return pgMock.instances.at(-1)!;
}

beforeEach(() => {
  pgMock.instances.length = 0;
  pgMock.queryImplementation = async () => ({ rows: [], rowCount: 0 });
  pgMock.endImplementation = async () => undefined;
});

describe("gateway settlement recovery pg construction", () => {
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
  ])("rejects the core URL matrix before Pool construction: %s", (raw) => {
    expect(() => createGatewaySettlementRecoveryDb(raw)).toThrow(
      "invalid gateway settlement recovery database URL",
    );
    expect(pgMock.instances).toHaveLength(0);
  });

  it.each([
    "postgres://user:secret@db.example.test:5432/recovery?application_name=worker",
    databaseUrl,
  ])("passes the accepted opaque URL to the fixed Pool options: %s", async (raw) => {
    const previous = process.env.PGOPTIONS;
    process.env.PGOPTIONS = "-c statement_timeout=1 -c search_path=hostile";
    try {
      const db = createGatewaySettlementRecoveryDb(raw);
      expect(pool().options).toEqual({
        connectionString: raw,
        max: 1,
        connectionTimeoutMillis: 8_000,
        statement_timeout: 8_000,
        query_timeout: 9_000,
        options: "-c statement_timeout=8000",
      });
      expect(pool().options.options).not.toContain("search_path");
      await db.close();
    } finally {
      if (previous === undefined) delete process.env.PGOPTIONS;
      else process.env.PGOPTIONS = previous;
    }
  });
});

describe("gateway settlement recovery SQL contract", () => {
  it("keeps the exact capture selector", () => {
    expect(normalized(CAPTURE_GATEWAY_SETTLEMENT_RECOVERY_CYCLE_SQL)).toBe(normalized(`
      WITH cutoff AS (
        SELECT clock_timestamp() AS cycle_due_before
      )
      SELECT
        to_char(cutoff.cycle_due_before AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cycle_due_before,
        to_char(candidate.reconcile_after AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS upper_reconcile_at,
        candidate.billing_request_id::text AS upper_billing_id
      FROM cutoff
      CROSS JOIN LATERAL (
        SELECT admission.reconcile_after, admission.billing_request_id
        FROM gateway_charge_admissions AS admission
        JOIN gateway_http_requests AS request
          ON request.org_id = admission.org_id
         AND request.api_key_id = admission.api_key_id
         AND request.billing_request_id = admission.billing_request_id
        JOIN gateway_http_results AS http_result
          ON http_result.org_id = admission.org_id
         AND http_result.api_key_id = admission.api_key_id
         AND http_result.billing_request_id = admission.billing_request_id
        JOIN gateway_charge_quota_contexts AS quota
          ON quota.org_id = admission.org_id
         AND quota.api_key_id = admission.api_key_id
         AND quota.billing_request_id = admission.billing_request_id
        WHERE admission.state = 'outcome_recorded'
          AND admission.outcome_kind = 'success'
          AND admission.route_kind = ANY($1::varchar[])
          AND admission.billing_mode = 'stored'
          AND admission.reconcile_after IS NOT NULL
          AND admission.reconcile_after <= cutoff.cycle_due_before
          AND admission.outcome_recorded_at IS NOT NULL
          AND admission.outcome_recorded_at <= cutoff.cycle_due_before
          AND request.contract_version = ANY($2::smallint[])
          AND request.route_kind = admission.route_kind
          AND request.billing_mode = 'stored'
          AND http_result.contract_version = request.contract_version
          AND http_result.http_status = 200
          AND http_result.content_type = CASE WHEN request.contract_version=2 THEN 'text/event-stream' ELSE 'application/json' END
          AND quota.quota_version = 2
          AND NOT EXISTS (
            SELECT 1
            FROM gateway_http_rejections AS rejection
            WHERE rejection.org_id = admission.org_id
              AND rejection.api_key_id = admission.api_key_id
              AND rejection.billing_request_id = admission.billing_request_id
          )
        ORDER BY admission.reconcile_after DESC, admission.billing_request_id DESC
        LIMIT 1
      ) AS candidate;
    `));
  });

  it("keeps the exact bounded page selector", () => {
    expect(normalized(SELECT_GATEWAY_SETTLEMENT_RECOVERY_PAGE_SQL)).toBe(normalized(`
      SELECT
        admission.org_id::text AS org_id,
        admission.api_key_id::text AS api_key_id,
        admission.billing_request_id::text AS billing_request_id,
        to_char(admission.reconcile_after AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS reconcile_at
      FROM gateway_charge_admissions AS admission
      JOIN gateway_http_requests AS request
        ON request.org_id = admission.org_id
       AND request.api_key_id = admission.api_key_id
       AND request.billing_request_id = admission.billing_request_id
      JOIN gateway_http_results AS http_result
        ON http_result.org_id = admission.org_id
       AND http_result.api_key_id = admission.api_key_id
       AND http_result.billing_request_id = admission.billing_request_id
      JOIN gateway_charge_quota_contexts AS quota
        ON quota.org_id = admission.org_id
       AND quota.api_key_id = admission.api_key_id
       AND quota.billing_request_id = admission.billing_request_id
      WHERE admission.state = 'outcome_recorded'
        AND admission.outcome_kind = 'success'
        AND admission.route_kind = ANY($1::varchar[])
        AND admission.billing_mode = 'stored'
        AND admission.reconcile_after IS NOT NULL
        AND admission.reconcile_after <= $3::timestamptz
        AND admission.outcome_recorded_at IS NOT NULL
        AND admission.outcome_recorded_at <= $3::timestamptz
        AND request.contract_version = ANY($2::smallint[])
        AND request.route_kind = admission.route_kind
        AND request.billing_mode = 'stored'
        AND http_result.contract_version = request.contract_version
        AND http_result.http_status = 200
        AND http_result.content_type = CASE WHEN request.contract_version=2 THEN 'text/event-stream' ELSE 'application/json' END
        AND quota.quota_version = 2
        AND NOT EXISTS (
          SELECT 1
          FROM gateway_http_rejections AS rejection
          WHERE rejection.org_id = admission.org_id
            AND rejection.api_key_id = admission.api_key_id
            AND rejection.billing_request_id = admission.billing_request_id
        )
        AND (
          $4::timestamptz IS NULL
          OR (
            $5::uuid IS NOT NULL
            AND (admission.reconcile_after, admission.billing_request_id)
              > ($4::timestamptz, $5::uuid)
          )
        )
        AND (admission.reconcile_after, admission.billing_request_id)
          <= ($6::timestamptz, $7::uuid)
      ORDER BY admission.reconcile_after ASC, admission.billing_request_id ASC
      LIMIT $8::integer;
    `));
  });

  it("keeps recovery as the sole final SQL authority", () => {
    expect(normalized(RECOVER_GATEWAY_HTTP_SETTLEMENT_SQL)).toBe(normalized(`
      SELECT
        recovered.org_id::text AS org_id,
        recovered.api_key_id::text AS api_key_id,
        recovered.billing_request_id::text AS billing_request_id,
        recovered.state::text AS state,
        recovered.route_kind::text AS route_kind,
        recovered.billing_mode::text AS billing_mode,
        recovered.outcome_kind::text AS outcome_kind
      FROM aiag_recover_gateway_http_settlement_v1(
        $1::uuid,
        $2::uuid,
        $3::uuid
      ) AS recovered;
    `));
  });
});

describe("gateway settlement recovery row adapters", () => {
  it("captures zero or one strict row and normalizes UUID case", async () => {
    const db = createGatewaySettlementRecoveryDb(databaseUrl);
    pgMock.queryImplementation = async () => result([]);
    await expect(db.captureCycle()).resolves.toBeNull();
    pgMock.queryImplementation = async () => result([{
      cycle_due_before: cutoff,
      upper_reconcile_at: timestamp,
      upper_billing_id: billingRequestId.toUpperCase(),
    }]);
    await expect(db.captureCycle()).resolves.toEqual({
      cycleDueBefore: cutoff,
      upper: { reconcileAt: timestamp, billingRequestId },
    });
    expect(pool().query).toHaveBeenLastCalledWith({
      text: CAPTURE_GATEWAY_SETTLEMENT_RECOVERY_CYCLE_SQL,
      values: [["chat"], [1]],
    });
    expect(pool().connect).not.toHaveBeenCalled();
    await db.close();
  });

  it.each([
    { rows: [{ cycle_due_before: cutoff, upper_reconcile_at: timestamp, upper_billing_id: billingRequestId }], rowCount: 0 },
    { rows: [{ cycle_due_before: cutoff, upper_reconcile_at: timestamp, upper_billing_id: billingRequestId }, { cycle_due_before: cutoff, upper_reconcile_at: timestamp, upper_billing_id: billingRequestId }], rowCount: 2 },
    { rows: [{ cycle_due_before: timestamp, upper_reconcile_at: cutoff, upper_billing_id: billingRequestId }], rowCount: 1 },
    { rows: [{ cycle_due_before: "2026-09-13T10:11:12.123Z", upper_reconcile_at: timestamp, upper_billing_id: billingRequestId }], rowCount: 1 },
    { rows: [{ cycle_due_before: cutoff, upper_reconcile_at: timestamp, upper_billing_id: "bad" }], rowCount: 1 },
    { rows: [{ cycle_due_before: cutoff, upper_reconcile_at: timestamp, upper_billing_id: billingRequestId, extra: true }], rowCount: 1 },
  ])("rejects malformed capture results %#", async (nativeResult) => {
    const db = createGatewaySettlementRecoveryDb(databaseUrl);
    pgMock.queryImplementation = async () => nativeResult;
    await expect(db.captureCycle()).rejects.toThrow("invalid gateway settlement recovery capture result");
    await db.close();
  });

  it("uses the exact page values and returns strict normalized hints", async () => {
    const db = createGatewaySettlementRecoveryDb(databaseUrl);
    pgMock.queryImplementation = async () => result([{
      org_id: orgId.toUpperCase(),
      api_key_id: apiKeyId.toUpperCase(),
      billing_request_id: billingRequestId.toUpperCase(),
      reconcile_at: timestamp,
    }]);
    await expect(db.selectPage({
      cycleDueBefore: cutoff,
      after: { reconcileAt: timestamp, billingRequestId },
      upper: { reconcileAt: cutoff, billingRequestId },
      limit: 20,
    })).resolves.toEqual({ hints: [{ orgId, apiKeyId, billingRequestId, reconcileAt: timestamp }] });
    expect(pool().query).toHaveBeenLastCalledWith({
      text: SELECT_GATEWAY_SETTLEMENT_RECOVERY_PAGE_SQL,
      values: [["chat"], [1], cutoff, timestamp, billingRequestId, cutoff, billingRequestId, 20],
    });
    await db.close();
  });

  it("uses null cursor parameters and rejects every malformed page before returning it", async () => {
    const db = createGatewaySettlementRecoveryDb(databaseUrl);
    pgMock.queryImplementation = async () => result([]);
    await db.selectPage({
      cycleDueBefore: cutoff,
      after: null,
      upper: { reconcileAt: timestamp, billingRequestId },
      limit: 20,
    });
    expect(pool().query).toHaveBeenLastCalledWith({
      text: SELECT_GATEWAY_SETTLEMENT_RECOVERY_PAGE_SQL,
      values: [["chat"], [1], cutoff, null, null, timestamp, billingRequestId, 20],
    });
    const valid = { org_id: orgId, api_key_id: apiKeyId, billing_request_id: billingRequestId, reconcile_at: timestamp };
    for (const nativeResult of [
      { rows: [valid], rowCount: 0 },
      { rows: Array.from({ length: 21 }, () => valid), rowCount: 21 },
      { rows: [{ ...valid, extra: true }], rowCount: 1 },
      { rows: [{ ...valid, org_id: "bad" }], rowCount: 1 },
      { rows: [{ ...valid, reconcile_at: "bad" }], rowCount: 1 },
      { rows: [Object.assign(Object.create({ inherited: true }), valid)], rowCount: 1 },
    ]) {
      pgMock.queryImplementation = async () => nativeResult;
      await expect(db.selectPage({
        cycleDueBefore: cutoff,
        after: null,
        upper: { reconcileAt: timestamp, billingRequestId },
        limit: 20,
      })).rejects.toThrow("invalid gateway settlement recovery page result");
    }
    await db.close();
  });

  it("uses the exact recovery values and accepts only one strict seven-field ACK", async () => {
    const db = createGatewaySettlementRecoveryDb(databaseUrl);
    const nativeAck = {
      org_id: orgId.toUpperCase(), api_key_id: apiKeyId.toUpperCase(),
      billing_request_id: billingRequestId.toUpperCase(), state: "settled",
      route_kind: "chat", billing_mode: "stored", outcome_kind: "success",
    };
    pgMock.queryImplementation = async () => result([nativeAck]);
    await expect(db.recover({ orgId, apiKeyId, billingRequestId, reconcileAt: timestamp })).resolves.toEqual({
      orgId, apiKeyId, billingRequestId, state: "settled", routeKind: "chat",
      billingMode: "stored", outcomeKind: "success",
    });
    expect(pool().query).toHaveBeenLastCalledWith({
      text: RECOVER_GATEWAY_HTTP_SETTLEMENT_SQL,
      values: [orgId, apiKeyId, billingRequestId],
    });
    for (const nativeResult of [
      { rows: [], rowCount: 0 },
      { rows: [nativeAck], rowCount: null },
      { rows: [{ ...nativeAck, state: "outcome_recorded" }], rowCount: 1 },
      { rows: [{ ...nativeAck, extra: true }], rowCount: 1 },
      { rows: [Object.assign(Object.create({ inherited: true }), nativeAck)], rowCount: 1 },
    ]) {
      pgMock.queryImplementation = async () => nativeResult;
      await expect(db.recover({ orgId, apiKeyId, billingRequestId, reconcileAt: timestamp }))
        .rejects.toThrow("invalid gateway settlement recovery acknowledgement");
    }
    expect(pool().connect).not.toHaveBeenCalled();
    await db.close();
  });

  it("uses explicit combined route filters and accepts an embeddings settlement ACK", async () => {
    const db = createGatewaySettlementRecoveryDb(databaseUrl, {
      allowedRoutes: ["chat", "embeddings"],
    });
    pgMock.queryImplementation = async () => result([]);
    await db.captureCycle();
    expect(pool().query).toHaveBeenLastCalledWith({
      text: CAPTURE_GATEWAY_SETTLEMENT_RECOVERY_CYCLE_SQL,
      values: [["chat", "embeddings"], [1]],
    });
    pgMock.queryImplementation = async () => result([{
      org_id: orgId,
      api_key_id: apiKeyId,
      billing_request_id: billingRequestId,
      state: "settled",
      route_kind: "embeddings",
      billing_mode: "stored",
      outcome_kind: "success",
    }]);
    await expect(
      db.recover({ orgId, apiKeyId, billingRequestId, reconcileAt: timestamp }),
    ).resolves.toMatchObject({ routeKind: "embeddings" });
    await db.close();
  });

  it("uses the strict three-route filter and accepts a completions settlement ACK", async () => {
    const db = createGatewaySettlementRecoveryDb(databaseUrl, {
      allowedRoutes: ["chat", "embeddings", "completions"],
    });
    pgMock.queryImplementation = async () => result([]);
    await db.captureCycle();
    expect(pool().query).toHaveBeenLastCalledWith({
      text: CAPTURE_GATEWAY_SETTLEMENT_RECOVERY_CYCLE_SQL,
      values: [["chat", "embeddings", "completions"], [1]],
    });
    pgMock.queryImplementation = async () => result([{
      org_id: orgId,
      api_key_id: apiKeyId,
      billing_request_id: billingRequestId,
      state: "settled",
      route_kind: "completions",
      billing_mode: "stored",
      outcome_kind: "success",
    }]);
    await expect(
      db.recover({ orgId, apiKeyId, billingRequestId, reconcileAt: timestamp }),
    ).resolves.toMatchObject({ routeKind: "completions" });
    await db.close();
  });

  it("allows contract v2 only when explicitly configured for the stream mode", async () => {
    const db = createGatewaySettlementRecoveryDb(databaseUrl, {
      allowedRoutes: ["chat", "embeddings", "completions"],
      allowedContractVersions: [1, 2],
    });
    pgMock.queryImplementation = async () => result([]);
    await db.captureCycle();
    expect(pool().query).toHaveBeenLastCalledWith({
      text: CAPTURE_GATEWAY_SETTLEMENT_RECOVERY_CYCLE_SQL,
      values: [["chat", "embeddings", "completions"], [1, 2]],
    });
    await db.close();
  });
});

describe("gateway settlement recovery pool lifecycle", () => {
  it("does not reject a timeout until the fake pool has disposed its ambiguous client", async () => {
    const events: string[] = [];
    let rejectQuery: ((error: Error) => void) | undefined;
    pgMock.queryImplementation = () => new Promise((_, reject) => { rejectQuery = reject; });
    const db = createGatewaySettlementRecoveryDb(databaseUrl);
    const pending = db.recover({ orgId, apiKeyId, billingRequestId, reconcileAt: timestamp })
      .catch((error) => { events.push("adapter rejected"); throw error; });
    events.push("query started");
    events.push("pool disposed client");
    rejectQuery?.(new Error("query timeout"));
    await expect(pending).rejects.toThrow("query timeout");
    expect(events).toEqual(["query started", "pool disposed client", "adapter rejected"]);
    await db.close();
  });

  it("starts the second candidate only after the first rejection/disposal marker", async () => {
    const events: string[] = [];
    let calls = 0;
    pgMock.queryImplementation = async () => {
      calls += 1;
      events.push(`query ${calls}`);
      if (calls === 1) {
        await Promise.resolve();
        events.push("disposed 1");
        throw new Error("connection lost");
      }
      return { rows: [{
        org_id: orgId, api_key_id: apiKeyId, billing_request_id: billingRequestId,
        state: "settled", route_kind: "chat", billing_mode: "stored", outcome_kind: "success",
      }], rowCount: 1 };
    };
    const db = createGatewaySettlementRecoveryDb(databaseUrl);
    await expect(db.recover({ orgId, apiKeyId, billingRequestId, reconcileAt: timestamp })).rejects.toThrow("connection lost");
    await db.recover({ orgId, apiKeyId, billingRequestId, reconcileAt: timestamp });
    expect(events).toEqual(["query 1", "disposed 1", "query 2"]);
    await db.close();
  });

  it("marks closing synchronously, waits the active adapter, ends once, and memoizes close", async () => {
    const events: string[] = [];
    let resolveQuery: ((value: unknown) => void) | undefined;
    pgMock.queryImplementation = () => new Promise((resolve) => { resolveQuery = resolve; });
    pgMock.endImplementation = async () => { events.push("end"); };
    const db = createGatewaySettlementRecoveryDb(databaseUrl);
    const active = db.captureCycle().then(() => { events.push("query settled"); });
    const first = db.close();
    const second = db.close();
    expect(first).toBe(second);
    await expect(db.captureCycle()).rejects.toThrow("gateway settlement recovery database is closing");
    expect(pool().query).toHaveBeenCalledTimes(1);
    expect(pool().end).not.toHaveBeenCalled();
    resolveQuery?.({ rows: [], rowCount: 0 });
    await active;
    await first;
    expect(events).toEqual(["query settled", "end"]);
    expect(pool().end).toHaveBeenCalledTimes(1);
  });

  it("waits a failed active adapter and still ends the pool exactly once", async () => {
    let rejectQuery: ((error: Error) => void) | undefined;
    pgMock.queryImplementation = () => new Promise((_, reject) => { rejectQuery = reject; });
    const db = createGatewaySettlementRecoveryDb(databaseUrl);
    const active = db.captureCycle();
    const closing = db.close();
    rejectQuery?.(new Error("lost"));
    await expect(active).rejects.toThrow("lost");
    await expect(closing).resolves.toBeUndefined();
    expect(pool().end).toHaveBeenCalledTimes(1);
  });
});
