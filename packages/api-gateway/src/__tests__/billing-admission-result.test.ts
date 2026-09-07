import { describe, expect, it } from "vitest";
import {
  parseGatewayChargeAdmissionResult,
  type GatewayChargeAdmissionResult,
} from "../billing/admission-result";

const MAX = "9007199254740993";

function heldRow(): Record<string, unknown> {
  return {
    billing_request_id: "11111111-1111-4111-8111-111111111111",
    org_id: "22222222-2222-4222-8222-222222222222",
    api_key_id: "33333333-3333-4333-8333-333333333333",
    client_request_id: "client-request-1",
    route_kind: "chat",
    billing_mode: "stored",
    model_slug: "openai/gpt-test",
    authorized_max_credits: MAX,
    held_subscription_credits: "9007199254740000",
    held_payg_credits: "993",
    captured_subscription_expires_at: "2026-09-08T03:04:05.123456+03:00",
    quote_snapshot: { z: [true, null, "x"], a: { amount: MAX } },
    attempt_id: null,
    upstream_id: null,
    pricing_snapshot: null,
    actual_cost_credits: null,
    usage_snapshot: null,
    outcome_kind: null,
    state: "held",
    pre_dispatch_deadline_at: "2026-09-07T12:00:01.000001Z",
    created_at: "2026-09-07T12:00:00Z",
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
  };
}

function dispatchedRow(): Record<string, unknown> {
  return {
    ...heldRow(),
    attempt_id: "44444444-4444-4444-8444-444444444444",
    upstream_id: "openrouter",
    pricing_snapshot: { output: "2", input: "1" },
    state: "dispatched",
    dispatched_at: "2026-09-07T12:00:00.500001Z",
    reconcile_after: "2026-09-07T12:15:00.500001Z",
  };
}

function outcomeRow(): Record<string, unknown> {
  return {
    ...dispatchedRow(),
    actual_cost_credits: "9007199254740001",
    usage_snapshot: { completion_tokens: 2, prompt_tokens: 1 },
    outcome_kind: "success",
    state: "outcome_recorded",
    outcome_recorded_at: "2026-09-07T12:00:00.500002Z",
    reconcile_after: "2026-09-07T12:00:00.500002Z",
  };
}

function settledRow(): Record<string, unknown> {
  return {
    ...outcomeRow(),
    state: "settled",
    settled_at: "2026-09-07T12:00:00.500003Z",
    reconcile_after: null,
    released_subscription_credits: "7",
    released_payg_credits: "2",
    debt_repaid_credits: "1",
    expired_subscription_credits: "0",
  };
}

function cancelledRow(): Record<string, unknown> {
  return {
    ...heldRow(),
    state: "cancelled",
    cancelled_at: "2026-09-07T12:00:00.500004Z",
    released_subscription_credits: "9007199254740000",
    released_payg_credits: "992",
    debt_repaid_credits: "1",
  };
}

describe("gateway admission result parser", () => {
  it("parses all 31 fields exactly and preserves bigint precision", () => {
    const parsed = parseGatewayChargeAdmissionResult(heldRow());

    expect(Object.keys(heldRow())).toHaveLength(31);
    expect(Object.keys(parsed)).toHaveLength(31);
    expect(parsed).toEqual({
      billingRequestId: "11111111-1111-4111-8111-111111111111",
      orgId: "22222222-2222-4222-8222-222222222222",
      apiKeyId: "33333333-3333-4333-8333-333333333333",
      clientRequestId: "client-request-1",
      routeKind: "chat",
      billingMode: "stored",
      modelSlug: "openai/gpt-test",
      authorizedMaxCredits: 9007199254740993n,
      heldSubscriptionCredits: 9007199254740000n,
      heldPaygCredits: 993n,
      capturedSubscriptionExpiresAt: "2026-09-08T00:04:05.123456Z",
      quoteSnapshot: { z: [true, null, "x"], a: { amount: MAX } },
      attemptId: null,
      upstreamId: null,
      pricingSnapshot: null,
      actualCostCredits: null,
      usageSnapshot: null,
      outcomeKind: null,
      state: "held",
      preDispatchDeadlineAt: "2026-09-07T12:00:01.000001Z",
      createdAt: "2026-09-07T12:00:00.000000Z",
      dispatchedAt: null,
      outcomeRecordedAt: null,
      settledAt: null,
      cancelledAt: null,
      reconcileAfter: null,
      releasedSubscriptionCredits: 0n,
      releasedPaygCredits: 0n,
      debtRepaidCredits: 0n,
      expiredSubscriptionCredits: 0n,
      didTransition: true,
    } satisfies GatewayChargeAdmissionResult);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.quoteSnapshot)).toBe(true);
    expect(Object.isFrozen(parsed.quoteSnapshot.z)).toBe(true);
  });

  it.each([dispatchedRow(), outcomeRow(), settledRow(), cancelledRow()])(
    "accepts a constraint-consistent lifecycle row",
    (row) => {
      expect(() => parseGatewayChargeAdmissionResult(row)).not.toThrow();
    },
  );

  it("clones snapshots so later source mutation cannot change the result", () => {
    const row = heldRow();
    const quote = row.quote_snapshot as { a: { amount: string } };
    const parsed = parseGatewayChargeAdmissionResult(row);
    quote.a.amount = "changed";
    expect(parsed.quoteSnapshot).toEqual({
      z: [true, null, "x"],
      a: { amount: MAX },
    });
  });

  it.each([
    ["authorized_max_credits", 10],
    ["authorized_max_credits", "01"],
    ["authorized_max_credits", "+1"],
    ["authorized_max_credits", "-1"],
    ["authorized_max_credits", "9223372036854775808"],
    ["held_payg_credits", "1.0"],
    ["released_payg_credits", null],
  ])("rejects malformed exact bigint field %s=%j", (field, value) => {
    expect(() =>
      parseGatewayChargeAdmissionResult({ ...heldRow(), [field]: value }),
    ).toThrow();
  });

  it("rejects a string masquerading as a boolean", () => {
    expect(() =>
      parseGatewayChargeAdmissionResult({
        ...heldRow(),
        did_transition: "false",
      }),
    ).toThrow();
    expect(
      parseGatewayChargeAdmissionResult({ ...heldRow(), did_transition: false })
        .didTransition,
    ).toBe(false);
  });

  it.each([
    [
      "missing lifecycle field",
      (() => {
        const row = heldRow();
        delete row.cancelled_at;
        return row;
      })(),
    ],
    [
      "non-null held dispatch",
      { ...heldRow(), dispatched_at: "2026-09-07T12:00:00.1Z" },
    ],
    ["partial dispatch facts", { ...dispatchedRow(), pricing_snapshot: null }],
    ["partial outcome facts", { ...outcomeRow(), usage_snapshot: null }],
    ["terminal timestamp missing", { ...settledRow(), settled_at: null }],
    [
      "cancelled row with attempt",
      { ...cancelledRow(), attempt_id: "44444444-4444-4444-8444-444444444444" },
    ],
    [
      "reconciliation on terminal",
      { ...settledRow(), reconcile_after: "2026-09-07T12:30:00Z" },
    ],
  ])("rejects %s", (_label, row) => {
    expect(() => parseGatewayChargeAdmissionResult(row)).toThrow();
  });

  it("rejects inconsistent holds, actuals, release bounds and timestamp order", () => {
    expect(() =>
      parseGatewayChargeAdmissionResult({
        ...heldRow(),
        held_payg_credits: "994",
      }),
    ).toThrow();
    expect(() =>
      parseGatewayChargeAdmissionResult({
        ...outcomeRow(),
        actual_cost_credits: "9007199254740994",
      }),
    ).toThrow();
    expect(() =>
      parseGatewayChargeAdmissionResult({
        ...settledRow(),
        released_subscription_credits: "9007199254740001",
      }),
    ).toThrow();
    expect(() =>
      parseGatewayChargeAdmissionResult({
        ...settledRow(),
        released_payg_credits: "993",
        debt_repaid_credits: "1",
      }),
    ).toThrow();
    expect(() =>
      parseGatewayChargeAdmissionResult({
        ...dispatchedRow(),
        dispatched_at: "2026-09-07T12:00:01.000001Z",
      }),
    ).toThrow();
    expect(() =>
      parseGatewayChargeAdmissionResult({
        ...outcomeRow(),
        outcome_recorded_at: "2026-09-07T12:00:00.500000Z",
      }),
    ).toThrow();
  });

  it("preserves and distinguishes PostgreSQL microseconds while normalizing zones", () => {
    const first = parseGatewayChargeAdmissionResult({
      ...heldRow(),
      created_at: "2026-09-07T15:00:00.123456+03:00",
    });
    const second = parseGatewayChargeAdmissionResult({
      ...heldRow(),
      created_at: "2026-09-07T12:00:00.123457Z",
    });
    expect(first.createdAt).toBe("2026-09-07T12:00:00.123456Z");
    expect(second.createdAt).toBe("2026-09-07T12:00:00.123457Z");
    expect(first.createdAt).not.toBe(second.createdAt);
    expect(() =>
      parseGatewayChargeAdmissionResult({
        ...heldRow(),
        created_at: "2026-09-07 12:00:00",
      }),
    ).toThrow();
  });

  it.each([
    null,
    [],
    { missing: "fields" },
    { ...heldRow(), billing_request_id: "not-a-uuid" },
    { ...heldRow(), route_kind: "" },
    { ...heldRow(), route_kind: "x".repeat(33) },
    { ...heldRow(), billing_mode: "free" },
    { ...heldRow(), model_slug: "x".repeat(129) },
    { ...heldRow(), state: "unknown" },
  ])("rejects malformed row %#", (row) => {
    expect(() => parseGatewayChargeAdmissionResult(row)).toThrow();
  });

  it.each([
    ["array root", []],
    ["undefined property", { x: undefined }],
    ["non-finite number", { x: Number.NaN }],
    ["bigint value", { x: 1n }],
    ["date instance", new Date()],
  ])("rejects non-JSON snapshot: %s", (_label, quoteSnapshot) => {
    expect(() =>
      parseGatewayChargeAdmissionResult({
        ...heldRow(),
        quote_snapshot: quoteSnapshot,
      }),
    ).toThrow();
  });

  it("rejects cyclic snapshot objects", () => {
    const quote: Record<string, unknown> = {};
    quote.self = quote;
    expect(() =>
      parseGatewayChargeAdmissionResult({
        ...heldRow(),
        quote_snapshot: quote,
      }),
    ).toThrow();
  });

  it("clones __proto__ as JSON data without changing object prototypes", () => {
    const quote = JSON.parse('{"__proto__":{"polluted":true}}') as Record<
      string,
      unknown
    >;
    const parsed = parseGatewayChargeAdmissionResult({
      ...heldRow(),
      quote_snapshot: quote,
    });
    expect(
      Object.prototype.hasOwnProperty.call(parsed.quoteSnapshot, "__proto__"),
    ).toBe(true);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("rejects an array index getter without invoking it", () => {
    let getterCalls = 0;
    const accessorArray: unknown[] = [];
    Object.defineProperty(accessorArray, "0", {
      get() {
        getterCalls += 1;
        return "must-not-run";
      },
      enumerable: true,
      configurable: true,
    });
    accessorArray.length = 1;

    expect(() =>
      parseGatewayChargeAdmissionResult({
        ...heldRow(),
        quote_snapshot: { values: accessorArray },
      }),
    ).toThrow();
    expect(getterCalls).toBe(0);
  });
});
