import { describe, expect, it, vi } from "vitest";
vi.mock("../lib/db", () => ({ sql: vi.fn() }));
import type { SqlClient } from "../lib/db";
import {
  admitGatewayHttpCharge,
  rejectUnstartedGatewayHttpRequest,
  readGatewayHttpResultV2,
  recoverGatewayHttpSettlement,
} from "../billing/http-terminal-recovery";
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

const identity = {
  orgId: ids.org,
  apiKeyId: ids.key,
  routeKind: "chat" as const,
  billingMode: "stored" as const,
  contractVersion: 1 as const,
  idempotencyKeyDigest: "a".repeat(64),
  requestFingerprint: "b".repeat(64),
};
const claim = { ...identity, billingRequestId: ids.billing };
const instant = "2026-09-07T12:00:00.123456Z";

const admissionArgs = () => ({
  ...identity,
  billingRequestId: ids.billing,
  clientRequestId: "trace-1",
  modelSlug: "openai/gpt-test",
  authorizedMaxCredits: 9007199254740993n,
  quoteSnapshot: { maximum: "9007199254740993", unit: "micro-credit" },
  preDispatchDeadlineAt: "2026-09-07T12:00:01.123456Z",
  declaredSessionId: "SID",
  supplierQuoteSnapshot: { version: 2 },
});
const rejectBody = () => ({
  error: {
    code: "PAYMENT_REQUIRED",
    message: "Payment required",
    type: "billing_error",
  },
});
function terminalRow(
  rejected = false,
  overrides: Record<string, unknown> = {},
) {
  const a = heldRow();
  return {
    ...(rejected
      ? Object.fromEntries(Object.keys(a).map((k) => [k, null]))
      : a),
    terminal_org_id: ids.org,
    terminal_api_key_id: ids.key,
    terminal_billing_request_id: ids.billing,
    terminal_status: rejected ? "rejected" : "admitted",
    terminal_rejection_code: rejected ? "PAYMENT_REQUIRED" : null,
    terminal_http_status: rejected ? 402 : null,
    terminal_response_body: rejected ? rejectBody() : null,
    terminal_at: rejected ? instant : null,
    terminal_did_transition: true,
    ...overrides,
  };
}
function rejectionRead(overrides: Record<string, unknown> = {}) {
  return {
    contract_version: 1,
    status: "rejected",
    billing_request_id: ids.billing,
    http_status: 402,
    content_type: "application/json",
    response_body: rejectBody(),
    actual_cost_credits: null,
    stored_at: instant,
    expires_at: null,
    rejection_code: "PAYMENT_REQUIRED",
    ...overrides,
  };
}
describe("HTTP terminal wrappers", () => {
  it("projects the nested admission once with exact decimal money and text JSON", async () => {
    const db = createSqlStub();
    db.returnRows([terminalRow()]);
    const result = await admitGatewayHttpCharge(admissionArgs(), db.client);
    expect(result).toMatchObject({
      kind: "admitted",
      admission: { authorizedMaxCredits: 9007199254740993n },
    });
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].text).toContain("AS MATERIALIZED");
    expect(db.queries[0].text).toContain("::text::jsonb");
    expect(db.queries[0].values).toContain("9007199254740993");
    expect(db.queries[0].values).toContain(
      JSON.stringify(admissionArgs().quoteSnapshot),
    );
  });
  it("returns a detached immutable durable rejection with exact timestamp", async () => {
    const db = createSqlStub(),
      row = terminalRow(true);
    db.returnRows([row]);
    const result = await admitGatewayHttpCharge(admissionArgs(), db.client);
    expect(result).toMatchObject({
      kind: "rejected",
      billingRequestId: ids.billing,
      code: "PAYMENT_REQUIRED",
      httpStatus: 402,
      terminalAt: instant,
    });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.kind !== "rejected") throw Error("rejected");
    expect(Object.isFrozen(result.response.error)).toBe(true);
    (
      row.terminal_response_body as ReturnType<typeof rejectBody>
    ).error.message = "mutated";
    expect(result.response.error.message).toBe("Payment required");
  });
  it("returns the original code from unstarted replay, never fabricates admission", async () => {
    const db = createSqlStub();
    db.returnRows([terminalRow(true, { terminal_did_transition: false })]);
    expect(
      await rejectUnstartedGatewayHttpRequest(claim, db.client),
    ).toMatchObject({
      kind: "rejected",
      code: "PAYMENT_REQUIRED",
      didTransition: false,
    });
    db.returnRows([terminalRow()]);
    await expect(
      rejectUnstartedGatewayHttpRequest(claim, db.client),
    ).rejects.toMatchObject({ code: "HTTP_STORAGE_UNAVAILABLE" });
  });
  it.each([
    ["unknown code", { terminal_rejection_code: "UNKNOWN" }],
    ["status drift", { terminal_http_status: 429 }],
    [
      "extra body",
      { terminal_response_body: { ...rejectBody(), debug: true } },
    ],
    [
      "changed message",
      {
        terminal_response_body: {
          error: { ...rejectBody().error, message: "secret" },
        },
      },
    ],
    ["timestamp milliseconds", { terminal_at: "2026-09-07T12:00:00.123Z" }],
    ["owner", { terminal_org_id: ids.key }],
    ["billing", { terminal_billing_request_id: ids.key }],
    ["boolean", { terminal_did_transition: "true" }],
    ["partial admission", { actual_cost_credits: "0" }],
  ])("rejects malformed negative %s", async (_name, change) => {
    const db = createSqlStub();
    db.returnRows([terminalRow(true, change as Record<string, unknown>)]);
    await expect(
      admitGatewayHttpCharge(admissionArgs(), db.client),
    ).rejects.toMatchObject({ code: "HTTP_STORAGE_UNAVAILABLE" });
  });
  it.each([
    { authorized_max_credits: 9007199254740993 },
    { org_id: ids.key },
    { did_transition: false },
    { state: "settled" },
    { terminal_at: instant },
    { unexpected: null },
  ])("rejects admitted row drift %j", async (change) => {
    const db = createSqlStub();
    db.returnRows([terminalRow(false, change)]);
    await expect(
      admitGatewayHttpCharge(admissionArgs(), db.client),
    ).rejects.toMatchObject({ code: "HTTP_STORAGE_UNAVAILABLE" });
  });
  it.each([{ rows: [] }, { rows: [terminalRow(), terminalRow()] }])(
    "rejects row cardinality",
    async ({ rows }) => {
      const db = createSqlStub();
      db.returnRows(rows);
      await expect(
        admitGatewayHttpCharge(admissionArgs(), db.client),
      ).rejects.toMatchObject({ code: "HTTP_STORAGE_UNAVAILABLE" });
    },
  );
  it("captures JSON and scalar inputs before the first await and never invokes getters", async () => {
    const db = createSqlStub(),
      args = admissionArgs();
    db.returnRows([terminalRow()]);
    const result = admitGatewayHttpCharge(args, db.client);
    args.quoteSnapshot.maximum = "1";
    args.declaredSessionId = "changed";
    await result;
    expect(db.queries[0].values).toContain("SID");
    expect(db.queries[0].values).toContain(
      JSON.stringify(admissionArgs().quoteSnapshot),
    );
    const getter = vi.fn(() => ids.org),
      bad = admissionArgs();
    Object.defineProperty(bad, "orgId", { get: getter });
    await expect(admitGatewayHttpCharge(bad, db.client)).rejects.toMatchObject({
      code: "HTTP_STORAGE_UNAVAILABLE",
    });
    expect(getter).not.toHaveBeenCalled();
  });
  it.each(["P0003", "P0004", "55P03", "ECONNRESET"])(
    "does not turn SQL/ACK %s into a business rejection",
    async (code) => {
      const db = createSqlStub();
      db.throwError(Object.assign(new Error("private transport"), { code }));
      await expect(
        admitGatewayHttpCharge(admissionArgs(), db.client),
      ).rejects.toMatchObject({
        code: "HTTP_STORAGE_UNAVAILABLE",
        message: "HTTP storage unavailable",
      });
    },
  );
  it("maps explicit access and conflict without leaking transport details", async () => {
    const db = createSqlStub();
    db.throwError(
      Object.assign(new Error("HTTP_ACCESS_DENIED"), { code: "P0005" }),
    );
    await expect(
      readGatewayHttpResultV2(identity, db.client),
    ).rejects.toMatchObject({ code: "HTTP_STORAGE_ACCESS_DENIED" });
    db.throwError(
      Object.assign(new Error("private mismatch"), { code: "P0005" }),
    );
    await expect(
      admitGatewayHttpCharge(admissionArgs(), db.client),
    ).rejects.toMatchObject({ code: "HTTP_STORAGE_CONFLICT" });
  });
  it('preserves explicit recovery ownership denial as an access classification',async()=>{
    const db=createSqlStub();db.throwError(Object.assign(new Error('HTTP_ACCESS_DENIED'),{code:'P0005'}));
    await expect(recoverGatewayHttpSettlement(claim,db.client)).rejects.toMatchObject({code:'HTTP_STORAGE_ACCESS_DENIED'});
  });
  it("reads v2 negative and old states with strict branch nullability", async () => {
    const db = createSqlStub();
    db.returnRows([rejectionRead()]);
    expect(await readGatewayHttpResultV2(identity, db.client)).toMatchObject({
      status: "rejected",
      code: "PAYMENT_REQUIRED",
      storedAt: instant,
    });
    for (const status of ["pending", "unavailable"]) {
      db.returnRows([
        rejectionRead({
          status,
          http_status: null,
          content_type: null,
          response_body: null,
          stored_at: null,
          rejection_code: null,
        }),
      ]);
      expect(await readGatewayHttpResultV2(identity, db.client)).toEqual({
        contractVersion: 1,
        status,
        billingRequestId: ids.billing,
      });
    }
    db.returnRows([
      rejectionRead({
        status: "not_found",
        billing_request_id: null,
        http_status: null,
        content_type: null,
        response_body: null,
        stored_at: null,
        rejection_code: null,
      }),
    ]);
    expect(await readGatewayHttpResultV2(identity, db.client)).toEqual({
      contractVersion: 1,
      status: "not_found",
    });
    db.returnRows([
      rejectionRead({
        status: "expired",
        http_status: null,
        content_type: null,
        response_body: null,
        expires_at: "2026-09-14T12:00:00.123456Z",
        rejection_code: null,
      }),
    ]);
    expect(await readGatewayHttpResultV2(identity, db.client)).toMatchObject({
      status: "expired",
    });
    db.returnRows([
      rejectionRead({
        status: "ready",
        http_status: 200,
        response_body: response(),
        actual_cost_credits: "10014900000000000",
        expires_at: "2026-09-14T12:00:00.123456Z",
        rejection_code: null,
      }),
    ]);
    expect(await readGatewayHttpResultV2(identity, db.client)).toMatchObject({
      status: "ready",
      actualCostCredits: 10014900000000000n,
    });
  });
  it.each([
    { actual_cost_credits: "0" },
    { expires_at: instant },
    { content_type: "text/plain" },
    { rejection_code: null },
    { unknown: null },
  ])("rejects invalid v2 negative row %j", async (change) => {
    const db = createSqlStub();
    db.returnRows([rejectionRead(change)]);
    await expect(
      readGatewayHttpResultV2(identity, db.client),
    ).rejects.toMatchObject({ code: "HTTP_STORAGE_UNAVAILABLE" });
  });
  it("accepts only settled recovery with matching trusted owner and exact existing receipt", async () => {
    const db = createSqlStub(),
      settled = outcomeRow({
        state: "settled",
        settled_at: "2026-09-07T12:00:00.423456Z",
        reconcile_after: null,
        released_subscription_credits: "9007199254739959",
        released_payg_credits: "993",
      });
    db.returnRows([settled]);
    expect(await recoverGatewayHttpSettlement(claim, db.client)).toMatchObject({
      state: "settled",
      actualCostCredits: 41n,
    });
    for (const change of [
      { state: "outcome_recorded" },
      { org_id: ids.key },
      { outcome_kind: "verified_no_charge" },
      { unexpected: 0 },
    ]) {
      db.returnRows([{ ...settled, ...change }]);
      await expect(
        recoverGatewayHttpSettlement(claim, db.client),
      ).rejects.toMatchObject({ code: "HTTP_STORAGE_UNAVAILABLE" });
    }
    expect(db.queries[0].text).toContain(
      "aiag_recover_gateway_http_settlement_v1",
    );
    expect(db.queries[0].text).not.toContain("aiag_admit");
  });
});
function response() {
  return {
    id: "cmpl-1",
    object: "chat.completion" as const,
    created: 1,
    model: "openai/gpt-test",
    choices: [
      {
        index: 0,
        message: { role: "assistant" as const, content: 'exact " reply\\' },
        finish_reason: "stop" as const,
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  };
}
