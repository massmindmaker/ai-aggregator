import { describe, expect, it, vi } from "vitest";
vi.mock("../lib/db", () => ({ sql: vi.fn() }));
import type { SqlClient } from "../lib/db";
import { AdmissionUnavailableError } from "../billing/admission";
import { parseGatewayChargeAdmissionResult } from "../billing/admission-result";
import {
  admitGatewayChargeV2,
  admitGatewayByokFeeV2,
  recordGatewayChargeOutcomeV2,
} from "../billing/quota-admission";
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

const supplier = {
  version: 2,
  formulaVersion: "catalog-input-output-cents-per-1k-usd-micro-v2",
  tokenQuote: { version: 1 },
};
const v2Args = {
  ...admitArgs,
  declaredSessionId: "Case.SID_:-",
  supplierQuoteSnapshot: supplier,
};
describe("quota v2 production wrappers", () => {
  it.each([null, "A", "Case.SID_:-", "case.sid_:-", "a".repeat(128)])(
    "binds exact SID %s and twelve parameters",
    async (sid) => {
      const db = createSqlStub();
      db.returnRows([heldRow()]);
      const result = await admitGatewayChargeV2(
        { ...v2Args, declaredSessionId: sid },
        db.client,
      );
      expect(result.authorizedMaxCredits).toBe(9007199254740993n);
      expect(result.preDispatchDeadlineAt).toBe("2026-09-07T12:00:01.123456Z");
      expect(db.queries[0]?.text).toContain("aiag_admit_gateway_charge_v2(");
      expect(db.queries[0]?.text.match(/::text::jsonb/g)).toHaveLength(2);
      expect(db.queries[0]?.text.match(/AS [a-z_]+/g)).toHaveLength(31);
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
        admitArgs.preDispatchDeadlineAt,
        sid,
        JSON.stringify(supplier),
      ]);
      expect(Object.keys(result)).not.toContain("declaredSessionId");
      expect(Object.keys(result)).not.toContain("supplierQuoteSnapshot");
    },
  );
  it.each([
    "",
    "a".repeat(129),
    " A",
    "A ",
    "A\n",
    "A\r",
    "A\t",
    "Ａ",
    "А",
    undefined,
  ])("rejects invalid SID before SQL %s", async (sid) => {
    const db = createSqlStub();
    await expect(
      admitGatewayChargeV2(
        { ...v2Args, declaredSessionId: sid as string },
        db.client,
      ),
    ).rejects.toBeInstanceOf(AdmissionUnavailableError);
    expect(db.queries).toHaveLength(0);
  });

  it("binds BYOK fee admission to quota v2 supplier-zero facts without widening stored wrapper", async () => {
    const db = createSqlStub();
    const quote = {
      version: 2,
      formulaVersion: "byok-fee-microcredits-v2",
      feeMicrocredits: "1000",
    };
    db.returnRows([
      heldRow({
        billing_mode: "byok_fee",
        authorized_max_credits: "1000",
        held_subscription_credits: "0",
        held_payg_credits: "1000",
        quote_snapshot: quote,
      }),
    ]);
    const result = await admitGatewayByokFeeV2(
      {
        ...admitArgs,
        billingMode: "byok_fee",
        authorizedMaxCredits: 1000n,
        quoteSnapshot: quote,
        declaredSessionId: null,
        supplierQuoteSnapshot: { version: 2, formulaVersion: "byok-zero-v2" },
      },
      db.client,
    );
    expect(result).toMatchObject({
      billingMode: "byok_fee",
      authorizedMaxCredits: 1000n,
    });
    expect(db.queries[0]?.values[5]).toBe("byok_fee");
    expect(db.queries[0]?.values[11]).toBe(
      JSON.stringify({ version: 2, formulaVersion: "byok-zero-v2" }),
    );

    const rejected = createSqlStub();
    await expect(
      admitGatewayByokFeeV2(
        {
          ...admitArgs,
          billingMode: "byok_fee",
          authorizedMaxCredits: 1000n,
          quoteSnapshot: quote,
          declaredSessionId: null,
          supplierQuoteSnapshot: { version: 2, formulaVersion: "wrong" },
        },
        rejected.client,
      ),
    ).rejects.toBeInstanceOf(AdmissionUnavailableError);
    expect(rejected.queries).toHaveLength(0);
  });

  it("requires stored mode and an object supplier snapshot", async () => {
    for (const patch of [
      { billingMode: "byok_fee" },
      { supplierQuoteSnapshot: null },
      { supplierQuoteSnapshot: undefined },
    ]) {
      const db = createSqlStub();
      await expect(
        admitGatewayChargeV2(
          { ...v2Args, ...patch } as typeof v2Args,
          db.client,
        ),
      ).rejects.toBeInstanceOf(AdmissionUnavailableError);
      expect(db.queries).toHaveLength(0);
    }
  });
  it("captures mutable input before first await", async () => {
    const db = createSqlStub();
    db.returnRows([heldRow()]);
    const a = structuredClone(v2Args);
    const promise = admitGatewayChargeV2(a, db.client);
    a.declaredSessionId = "changed";
    a.quoteSnapshot.unit = "changed";
    a.supplierQuoteSnapshot.tokenQuote.version = 99;
    a.billingMode = "byok_fee" as "stored";
    const result = await promise;
    expect(db.queries[0]?.values[10]).toBe("Case.SID_:-");
    expect(db.queries[0]?.values[11]).toBe(JSON.stringify(supplier));
    expect(result.quoteSnapshot).toEqual(admitArgs.quoteSnapshot);
  });
  it.each(
    [
      [],
      [heldRow(), heldRow()],
      [null],
      [heldRow({ extra: 1 })],
      [heldRow({ created_at: undefined })],
      [heldRow({ authorized_max_credits: 9007199254740993 })],
    ].map((rows) => ({ rows })),
  )("rejects malformed result rows", async ({ rows }) => {
    const db = createSqlStub();
    db.returnRows(rows);
    await expect(
      admitGatewayChargeV2(v2Args, db.client),
    ).rejects.toBeInstanceOf(AdmissionUnavailableError);
  });
  it.each([
    { org_id: ids.key },
    { billing_request_id: ids.org },
    { api_key_id: ids.org },
    { client_request_id: "other" },
    { route_kind: "other" },
    { billing_mode: "byok_fee" },
    { model_slug: "other" },
    { quote_snapshot: { other: true } },
    { pre_dispatch_deadline_at: "2026-09-07T12:00:01.123457Z" },
  ])("rejects changed base identity %j", async (patch) => {
    const db = createSqlStub();
    db.returnRows([heldRow(patch)]);
    await expect(
      admitGatewayChargeV2(v2Args, db.client),
    ).rejects.toBeInstanceOf(AdmissionUnavailableError);
  });
  it("allows settled exact replay but not a fresh advanced state", async () => {
    const db = createSqlStub();
    db.returnRows([settledRow({ did_transition: false })]);
    expect(await admitGatewayChargeV2(v2Args, db.client)).toMatchObject({
      state: "settled",
      didTransition: false,
    });
    db.returnRows([dispatchedRow()]);
    await expect(
      admitGatewayChargeV2(v2Args, db.client),
    ).rejects.toBeInstanceOf(AdmissionUnavailableError);
  });
  it("binds outcome v2 exact bigint and detached usage, then validates replay", async () => {
    const db = createSqlStub();
    const actual = 9007199254740993n;
    db.returnRows([outcomeRow({ actual_cost_credits: actual.toString() })]);
    const a = {
      admission: parseGatewayChargeAdmissionResult(dispatchedRow()),
      actualCostCredits: actual,
      usageSnapshot: { prompt_tokens: 10, completion_tokens: 2 },
      outcomeKind: "success",
    };
    const promise = recordGatewayChargeOutcomeV2(a, db.client);
    a.usageSnapshot.prompt_tokens = 999;
    const result = await promise;
    expect(db.queries[0]?.text).toContain(
      "aiag_record_gateway_charge_outcome_v2(",
    );
    expect(db.queries[0]?.text).toContain("::text::jsonb");
    expect(db.queries[0]?.values).toEqual([
      ids.org,
      ids.billing,
      actual.toString(),
      JSON.stringify({ prompt_tokens: 10, completion_tokens: 2 }),
      "success",
    ]);
    db.returnRows([
      outcomeRow({
        actual_cost_credits: actual.toString(),
        did_transition: false,
      }),
    ]);
    expect(
      await recordGatewayChargeOutcomeV2(
        { ...a, admission: result, usageSnapshot: result.usageSnapshot! },
        db.client,
      ),
    ).toMatchObject({ didTransition: false });
  });
  it.each([
    { created_at: "2026-09-07T12:00:00.123457Z" },
    { dispatched_at: "2026-09-07T12:00:00.223457Z" },
    { upstream_id: "other" },
    { pricing_snapshot: { wrong: true } },
    { usage_snapshot: { wrong: true } },
    { actual_cost_credits: "42" },
    { outcome_kind: "other" },
    {
      state: "dispatched",
      actual_cost_credits: null,
      usage_snapshot: null,
      outcome_kind: null,
      outcome_recorded_at: null,
    },
  ])("checks base and prior outcome facts %j", async (patch) => {
    const db = createSqlStub();
    db.returnRows([outcomeRow(patch)]);
    await expect(
      recordGatewayChargeOutcomeV2(
        {
          admission: parseGatewayChargeAdmissionResult(dispatchedRow()),
          actualCostCredits: 41n,
          usageSnapshot: { prompt_tokens: 10, completion_tokens: 2 },
          outcomeKind: "success",
        },
        db.client,
      ),
    ).rejects.toBeInstanceOf(AdmissionUnavailableError);
  });
});
