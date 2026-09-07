import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/db", () => ({ sql: vi.fn() }));

import {
  AdmissionConflictError,
  AdmissionDeadlineExpiredError,
  AdmissionUnavailableError,
  admitGatewayCharge,
  cancelUndispatchedGatewayCharge,
  markGatewayChargeDispatched,
  recordGatewayChargeOutcome,
  settleAdmittedGatewayCharge,
} from "../billing/admission";
import { AiagError } from "../lib/errors";
import type { SqlClient } from "../lib/db";

type Fragment = {
  strings: readonly string[];
  values: readonly unknown[];
  then: <TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) => Promise<TResult1 | TResult2>;
};

type CapturedQuery = { text: string; values: unknown[] };

function createSqlStub() {
  const results: Array<unknown[] | Error> = [];
  const queries: CapturedQuery[] = [];

  function compile(fragment: Fragment, params: unknown[]): string {
    let text = fragment.strings[0] ?? "";
    fragment.values.forEach((value, index) => {
      if (
        value &&
        typeof value === "object" &&
        "strings" in value &&
        "values" in value
      ) {
        text += compile(value as Fragment, params);
      } else {
        params.push(value);
        text += `$${params.length}`;
      }
      text += fragment.strings[index + 1] ?? "";
    });
    return text;
  }

  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const fragment: Fragment = {
      strings: [...strings],
      values,
      then(onfulfilled, onrejected) {
        const params: unknown[] = [];
        const text = compile(fragment, params).replace(/\s+/g, " ").trim();
        queries.push({ text, values: params });
        const next = results.shift();
        const promise =
          next instanceof Error
            ? Promise.reject(next)
            : Promise.resolve(next ?? []);
        return promise.then(onfulfilled ?? undefined, onrejected ?? undefined);
      },
    };
    return fragment;
  }) as unknown as SqlClient;

  return {
    client: tag,
    queries,
    returnRows(rows: unknown[]) {
      results.push(rows);
    },
    throwError(error: Error) {
      results.push(error);
    },
  };
}

const ids = {
  billing: "11111111-1111-4111-8111-111111111111",
  org: "22222222-2222-4222-8222-222222222222",
  key: "33333333-3333-4333-8333-333333333333",
  attempt: "44444444-4444-4444-8444-444444444444",
} as const;

function heldRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    billing_request_id: ids.billing,
    org_id: ids.org,
    api_key_id: ids.key,
    client_request_id: "trace-1",
    route_kind: "chat",
    billing_mode: "stored",
    model_slug: "openai/gpt-test",
    authorized_max_credits: "9007199254740993",
    held_subscription_credits: "9007199254740000",
    held_payg_credits: "993",
    captured_subscription_expires_at: null,
    quote_snapshot: { maximum: "9007199254740993", unit: "micro-credit" },
    attempt_id: null,
    upstream_id: null,
    pricing_snapshot: null,
    actual_cost_credits: null,
    usage_snapshot: null,
    outcome_kind: null,
    state: "held",
    pre_dispatch_deadline_at: "2026-09-07T12:00:01.123456Z",
    created_at: "2026-09-07T12:00:00.123456Z",
    dispatched_at: null,
    outcome_recorded_at: null,
    settled_at: null,
    cancelled_at: null,
    reconcile_after: null,
    released_subscription_credits: "0",
    released_payg_credits: "0",
    debt_repaid_credits: "0",
    expired_subscription_credits: "0",
    did_transition: true,
    ...overrides,
  };
}

function dispatchedRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return heldRow({
    attempt_id: ids.attempt,
    upstream_id: "openrouter",
    pricing_snapshot: { input: "1", output: "2" },
    state: "dispatched",
    dispatched_at: "2026-09-07T12:00:00.223456Z",
    reconcile_after: "2026-09-07T12:15:00.223456Z",
    ...overrides,
  });
}

function outcomeRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return dispatchedRow({
    actual_cost_credits: "41",
    usage_snapshot: { prompt_tokens: 10, completion_tokens: 2 },
    outcome_kind: "success",
    state: "outcome_recorded",
    outcome_recorded_at: "2026-09-07T12:00:00.323456Z",
    reconcile_after: "2026-09-07T12:00:00.323456Z",
    ...overrides,
  });
}

function settledRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return outcomeRow({
    state: "settled",
    settled_at: "2026-09-07T12:00:00.423456Z",
    reconcile_after: null,
    released_subscription_credits: "9007199254739959",
    released_payg_credits: "993",
    ...overrides,
  });
}

function cancelledRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return heldRow({
    state: "cancelled",
    cancelled_at: "2026-09-07T12:00:00.423456Z",
    released_subscription_credits: "9007199254740000",
    released_payg_credits: "993",
    ...overrides,
  });
}

const admitArgs = {
  orgId: ids.org,
  billingRequestId: ids.billing,
  apiKeyId: ids.key,
  clientRequestId: "trace-1",
  routeKind: "chat",
  billingMode: "stored" as const,
  modelSlug: "openai/gpt-test",
  authorizedMaxCredits: 9007199254740993n,
  quoteSnapshot: { unit: "micro-credit", maximum: "9007199254740993" },
  preDispatchDeadlineAt: "2026-09-07T12:00:01.123456Z",
};

const projectionFields = [
  "billing_request_id",
  "org_id",
  "api_key_id",
  "client_request_id",
  "route_kind",
  "billing_mode",
  "model_slug",
  "authorized_max_credits",
  "held_subscription_credits",
  "held_payg_credits",
  "captured_subscription_expires_at",
  "quote_snapshot",
  "attempt_id",
  "upstream_id",
  "pricing_snapshot",
  "actual_cost_credits",
  "usage_snapshot",
  "outcome_kind",
  "state",
  "pre_dispatch_deadline_at",
  "created_at",
  "dispatched_at",
  "outcome_recorded_at",
  "settled_at",
  "cancelled_at",
  "reconcile_after",
  "released_subscription_credits",
  "released_payg_credits",
  "debt_repaid_credits",
  "expired_subscription_credits",
  "did_transition",
] as const;

function sqlError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("gateway admission SQL wrappers", () => {
  let db: ReturnType<typeof createSqlStub>;

  beforeEach(() => {
    db = createSqlStub();
  });

  it("admits once with exact bigint/json/timestamp bindings and the explicit 31-field projection", async () => {
    db.returnRows([heldRow()]);
    const frozenArgs = Object.freeze({
      ...admitArgs,
      quoteSnapshot: Object.freeze({ ...admitArgs.quoteSnapshot }),
    });
    const result = await admitGatewayCharge(frozenArgs, db.client);

    expect(result.state).toBe("held");
    expect(result.didTransition).toBe(true);
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0]?.text).toContain("aiag_admit_gateway_charge(");
    expect(db.queries[0]?.values).toEqual([
      ids.org,
      ids.billing,
      ids.key,
      "trace-1",
      "chat",
      "stored",
      "openai/gpt-test",
      "9007199254740993",
      JSON.stringify(admitArgs.quoteSnapshot),
      "2026-09-07T12:00:01.123456Z",
    ]);
    for (const field of projectionFields)
      expect(db.queries[0]?.text).toContain(field);
    for (const field of [
      "authorized_max_credits",
      "held_subscription_credits",
      "held_payg_credits",
      "actual_cost_credits",
      "released_subscription_credits",
      "released_payg_credits",
      "debt_repaid_credits",
      "expired_subscription_credits",
    ]) {
      expect(db.queries[0]?.text).toContain(`${field}::text AS ${field}`);
    }
    expect(db.queries[0]?.text.match(/::bigint/g) ?? []).toHaveLength(1);
    expect(frozenArgs).toEqual(admitArgs);
  });

  it("accepts an exact admit replay in a later durable state but rejects impossible fresh state", async () => {
    db.returnRows([settledRow({ did_transition: false })]);
    expect((await admitGatewayCharge(admitArgs, db.client)).state).toBe(
      "settled",
    );

    const invalid = createSqlStub();
    invalid.returnRows([dispatchedRow({ did_transition: true })]);
    await expect(
      admitGatewayCharge(admitArgs, invalid.client),
    ).rejects.toBeInstanceOf(AdmissionUnavailableError);
  });

  it("grants dispatch exactly once and labels every exact replay without permission", async () => {
    const admittedDb = createSqlStub();
    admittedDb.returnRows([heldRow()]);
    const held = await admitGatewayCharge(admitArgs, admittedDb.client);

    db.returnRows([dispatchedRow()]);
    const fresh = await markGatewayChargeDispatched(
      {
        admission: held,
        attemptId: ids.attempt,
        upstreamId: "openrouter",
        pricingSnapshot: { output: "2", input: "1" },
      },
      db.client,
    );
    expect(fresh.kind).toBe("dispatch_granted");
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0]?.text).toContain(
      "aiag_mark_gateway_charge_dispatched(",
    );
    expect(db.queries[0]?.values).toEqual([
      ids.org,
      ids.billing,
      ids.attempt,
      "openrouter",
      JSON.stringify({ output: "2", input: "1" }),
    ]);

    for (const row of [
      dispatchedRow({ did_transition: false }),
      outcomeRow({ did_transition: false }),
      settledRow({ did_transition: false }),
    ]) {
      const replayDb = createSqlStub();
      replayDb.returnRows([row]);
      const replay = await markGatewayChargeDispatched(
        {
          admission: fresh.admission,
          attemptId: ids.attempt,
          upstreamId: "openrouter",
          pricingSnapshot: { input: "1", output: "2" },
        },
        replayDb.client,
      );
      expect(replay.kind).toBe("replay");
    }
  });

  it("records fresh and replayed outcomes, binding actual bigint exactly", async () => {
    const before = await (async () => {
      const source = createSqlStub();
      source.returnRows([dispatchedRow()]);
      const admitted = createSqlStub();
      admitted.returnRows([heldRow()]);
      const held = await admitGatewayCharge(admitArgs, admitted.client);
      return (
        await markGatewayChargeDispatched(
          {
            admission: held,
            attemptId: ids.attempt,
            upstreamId: "openrouter",
            pricingSnapshot: { input: "1", output: "2" },
          },
          source.client,
        )
      ).admission;
    })();
    db.returnRows([outcomeRow()]);
    const recorded = await recordGatewayChargeOutcome(
      {
        admission: before,
        actualCostCredits: 41n,
        usageSnapshot: { completion_tokens: 2, prompt_tokens: 10 },
        outcomeKind: "success",
      },
      db.client,
    );
    expect(recorded.state).toBe("outcome_recorded");
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0]?.values).toEqual([
      ids.org,
      ids.billing,
      "41",
      JSON.stringify({ completion_tokens: 2, prompt_tokens: 10 }),
      "success",
    ]);
    expect(db.queries[0]?.text.match(/::bigint/g) ?? []).toHaveLength(1);

    const replayDb = createSqlStub();
    replayDb.returnRows([settledRow({ did_transition: false })]);
    expect(
      (
        await recordGatewayChargeOutcome(
          {
            admission: recorded,
            actualCostCredits: 41n,
            usageSnapshot: { prompt_tokens: 10, completion_tokens: 2 },
            outcomeKind: "success",
          },
          replayDb.client,
        )
      ).state,
    ).toBe("settled");
  });

  it("settles and cancels exactly once, including exact terminal replay", async () => {
    const recorded = await outcomeAnchor();
    db.returnRows([settledRow()]);
    const settled = await settleAdmittedGatewayCharge(
      { admission: recorded },
      db.client,
    );
    expect(settled.state).toBe("settled");
    expect(db.queries[0]?.values).toEqual([ids.org, ids.billing]);

    const settleReplay = createSqlStub();
    settleReplay.returnRows([settledRow({ did_transition: false })]);
    expect(
      (
        await settleAdmittedGatewayCharge(
          { admission: settled },
          settleReplay.client,
        )
      ).didTransition,
    ).toBe(false);

    const held = await heldAnchor();
    const cancelDb = createSqlStub();
    cancelDb.returnRows([cancelledRow()]);
    const cancelled = await cancelUndispatchedGatewayCharge(
      { admission: held },
      cancelDb.client,
    );
    expect(cancelled.state).toBe("cancelled");
    expect(cancelDb.queries[0]?.values).toEqual([ids.org, ids.billing]);

    const cancelReplay = createSqlStub();
    cancelReplay.returnRows([cancelledRow({ did_transition: false })]);
    expect(
      (
        await cancelUndispatchedGatewayCharge(
          { admission: cancelled },
          cancelReplay.client,
        )
      ).didTransition,
    ).toBe(false);
  });

  it("uses the identical explicit projection for all five prepared function calls", async () => {
    const captured: CapturedQuery[] = [];

    const admitDb = createSqlStub();
    admitDb.returnRows([heldRow()]);
    await admitGatewayCharge(admitArgs, admitDb.client);
    captured.push(admitDb.queries[0]!);

    const held = await heldAnchor();
    const dispatchDb = createSqlStub();
    dispatchDb.returnRows([dispatchedRow()]);
    await markGatewayChargeDispatched(
      {
        admission: held,
        attemptId: ids.attempt,
        upstreamId: "openrouter",
        pricingSnapshot: { input: "1", output: "2" },
      },
      dispatchDb.client,
    );
    captured.push(dispatchDb.queries[0]!);

    const dispatched = await dispatchedAnchor();
    const outcomeDb = createSqlStub();
    outcomeDb.returnRows([outcomeRow()]);
    await recordGatewayChargeOutcome(
      {
        admission: dispatched,
        actualCostCredits: 41n,
        usageSnapshot: { prompt_tokens: 10, completion_tokens: 2 },
        outcomeKind: "success",
      },
      outcomeDb.client,
    );
    captured.push(outcomeDb.queries[0]!);

    const recorded = await outcomeAnchor();
    const settleDb = createSqlStub();
    settleDb.returnRows([settledRow()]);
    await settleAdmittedGatewayCharge({ admission: recorded }, settleDb.client);
    captured.push(settleDb.queries[0]!);

    const cancelDb = createSqlStub();
    cancelDb.returnRows([cancelledRow()]);
    await cancelUndispatchedGatewayCharge({ admission: held }, cancelDb.client);
    captured.push(cancelDb.queries[0]!);

    expect(captured).toHaveLength(5);
    const projections = captured.map(({ text }) =>
      text.slice(text.indexOf(") SELECT ") + 2),
    );
    expect(new Set(projections)).toHaveLength(1);
    for (const query of captured) {
      for (const field of projectionFields) expect(query.text).toContain(field);
    }
  });

  it("fails closed on empty, multiple or malformed rows", async () => {
    for (const rows of [
      [],
      [heldRow(), heldRow()],
      [{ ...heldRow(), did_transition: "true" }],
    ]) {
      const failing = createSqlStub();
      failing.returnRows(rows);
      await expect(
        admitGatewayCharge(admitArgs, failing.client),
      ).rejects.toMatchObject({
        code: "ADMISSION_UNAVAILABLE",
        status: 503,
        message: "Admission service unavailable",
      });
    }
  });

  it.each([
    ["org", { org_id: "55555555-5555-4555-8555-555555555555" }],
    ["billing", { billing_request_id: "55555555-5555-4555-8555-555555555555" }],
    ["key", { api_key_id: "55555555-5555-4555-8555-555555555555" }],
    ["mode", { billing_mode: "byok_fee" }],
    ["model", { model_slug: "other" }],
    ["quote", { quote_snapshot: { maximum: "different" } }],
    [
      "deadline microsecond",
      { pre_dispatch_deadline_at: "2026-09-07T12:00:01.123457Z" },
    ],
  ])("rejects returned admit %s mismatch", async (_label, overrides) => {
    db.returnRows([heldRow(overrides)]);
    await expect(
      admitGatewayCharge(admitArgs, db.client),
    ).rejects.toBeInstanceOf(AdmissionUnavailableError);
  });

  it("rejects returned dispatch/outcome/actual mismatches", async () => {
    const held = await heldAnchor();
    const badDispatch = createSqlStub();
    badDispatch.returnRows([dispatchedRow({ upstream_id: "other" })]);
    await expect(
      markGatewayChargeDispatched(
        {
          admission: held,
          attemptId: ids.attempt,
          upstreamId: "openrouter",
          pricingSnapshot: { input: "1", output: "2" },
        },
        badDispatch.client,
      ),
    ).rejects.toBeInstanceOf(AdmissionUnavailableError);

    const dispatched = await dispatchedAnchor();
    const badOutcome = createSqlStub();
    badOutcome.returnRows([outcomeRow({ actual_cost_credits: "42" })]);
    await expect(
      recordGatewayChargeOutcome(
        {
          admission: dispatched,
          actualCostCredits: 41n,
          usageSnapshot: { prompt_tokens: 10, completion_tokens: 2 },
          outcomeKind: "success",
        },
        badOutcome.client,
      ),
    ).rejects.toBeInstanceOf(AdmissionUnavailableError);

    const recorded = await outcomeAnchor();
    const badSettle = createSqlStub();
    badSettle.returnRows([settledRow({ actual_cost_credits: "42" })]);
    await expect(
      settleAdmittedGatewayCharge({ admission: recorded }, badSettle.client),
    ).rejects.toBeInstanceOf(AdmissionUnavailableError);
  });

  it("validates local input before the sole SQL call", async () => {
    await expect(
      admitGatewayCharge(null as unknown as typeof admitArgs, db.client),
    ).rejects.toBeInstanceOf(AdmissionUnavailableError);
    await expect(
      admitGatewayCharge(
        { ...admitArgs, authorizedMaxCredits: -1n },
        db.client,
      ),
    ).rejects.toBeInstanceOf(AdmissionUnavailableError);
    expect(db.queries).toHaveLength(0);

    const held = await heldAnchor();
    await expect(
      markGatewayChargeDispatched(
        {
          admission: held,
          attemptId: "bad",
          upstreamId: "openrouter",
          pricingSnapshot: {},
        },
        db.client,
      ),
    ).rejects.toBeInstanceOf(AdmissionUnavailableError);
    await expect(
      recordGatewayChargeOutcome(
        {
          admission: held,
          actualCostCredits: 1n,
          usageSnapshot: {},
          outcomeKind: "success",
        },
        db.client,
      ),
    ).rejects.toBeInstanceOf(AdmissionUnavailableError);
    await expect(
      settleAdmittedGatewayCharge({ admission: held }, db.client),
    ).rejects.toBeInstanceOf(AdmissionUnavailableError);
    expect(db.queries).toHaveLength(0);
  });

  it.each([
    ["P0003", "INSUFFICIENT_FUNDS", "PAYMENT_REQUIRED", 402],
    ["P0004", "CONCURRENT_MODIFICATION", "ADMISSION_UNAVAILABLE", 503],
    ["P0005", "ADMISSION_IDENTITY_CONFLICT", "ADMISSION_CONFLICT", 409],
    [
      "P0001",
      "INVALID_ADMISSION provider-secret",
      "ADMISSION_UNAVAILABLE",
      503,
    ],
    ["P0002", "ORG_NOT_FOUND raw-sql", "ADMISSION_UNAVAILABLE", 503],
    ["XX000", "driver exploded password=secret", "ADMISSION_UNAVAILABLE", 503],
  ])(
    "maps SQLSTATE %s to a neutral typed error",
    async (sqlState, raw, publicCode, status) => {
      db.throwError(sqlError(sqlState, raw));
      let thrown: unknown;
      try {
        await admitGatewayCharge(admitArgs, db.client);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AiagError);
      expect(thrown).toMatchObject({ code: publicCode, status });
      expect(
        JSON.stringify((thrown as AiagError).toResponseBody()),
      ).not.toContain(raw);
    },
  );

  it("classifies the exact deadline code/message pairs only", async () => {
    db.throwError(sqlError("P0001", "ADMISSION_DEADLINE_EXPIRED"));
    await expect(
      admitGatewayCharge(admitArgs, db.client),
    ).rejects.toBeInstanceOf(AdmissionDeadlineExpiredError);

    const held = await heldAnchor();
    const dispatchDb = createSqlStub();
    dispatchDb.throwError(sqlError("P0005", "ADMISSION_DEADLINE_EXPIRED"));
    await expect(
      markGatewayChargeDispatched(
        {
          admission: held,
          attemptId: ids.attempt,
          upstreamId: "openrouter",
          pricingSnapshot: {},
        },
        dispatchDb.client,
      ),
    ).rejects.toBeInstanceOf(AdmissionDeadlineExpiredError);

    const wrongCode = createSqlStub();
    wrongCode.throwError(sqlError("P0005", "ADMISSION_DEADLINE_EXPIRED"));
    await expect(
      admitGatewayCharge(admitArgs, wrongCode.client),
    ).rejects.toBeInstanceOf(AdmissionConflictError);
    const wrongMessage = createSqlStub();
    wrongMessage.throwError(
      sqlError("P0001", "ADMISSION_DEADLINE_EXPIRED detail"),
    );
    await expect(
      admitGatewayCharge(admitArgs, wrongMessage.client),
    ).rejects.toBeInstanceOf(AdmissionUnavailableError);
  });

  async function heldAnchor() {
    const source = createSqlStub();
    source.returnRows([heldRow()]);
    return admitGatewayCharge(admitArgs, source.client);
  }

  async function dispatchedAnchor() {
    const held = await heldAnchor();
    const source = createSqlStub();
    source.returnRows([dispatchedRow()]);
    return (
      await markGatewayChargeDispatched(
        {
          admission: held,
          attemptId: ids.attempt,
          upstreamId: "openrouter",
          pricingSnapshot: { input: "1", output: "2" },
        },
        source.client,
      )
    ).admission;
  }

  async function outcomeAnchor() {
    const dispatched = await dispatchedAnchor();
    const source = createSqlStub();
    source.returnRows([outcomeRow()]);
    return recordGatewayChargeOutcome(
      {
        admission: dispatched,
        actualCostCredits: 41n,
        usageSnapshot: { prompt_tokens: 10, completion_tokens: 2 },
        outcomeKind: "success",
      },
      source.client,
    );
  }
});
