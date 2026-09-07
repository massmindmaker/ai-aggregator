import { describe, expect, it, vi } from "vitest";
vi.mock("../lib/db", () => ({ sql: vi.fn() }));
import type { SqlClient } from "../lib/db";
import { parseGatewayChargeAdmissionResult } from "../billing/admission-result";
import {
  claimGatewayHttpRequest,
  readGatewayHttpResult,
  recordGatewayHttpOutcome,
  expireGatewayHttpResult,
} from "../billing/http-storage";
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
function claimRow(overrides: Record<string, unknown> = {}) {
  return {
    contract_version: 1,
    org_id: ids.org,
    api_key_id: ids.key,
    billing_request_id: ids.billing,
    route_kind: "chat",
    billing_mode: "stored",
    idempotency_key_digest: identity.idempotencyKeyDigest,
    request_fingerprint: identity.requestFingerprint,
    created_at: instant,
    did_claim: true,
    ...overrides,
  };
}
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
function readRow(overrides: Record<string, unknown> = {}) {
  return {
    contract_version: 1,
    status: "ready",
    billing_request_id: ids.billing,
    http_status: 200,
    content_type: "application/json",
    response_body: response(),
    actual_cost_credits: "9007199254740993",
    stored_at: instant,
    expires_at: "2026-09-14T12:00:00.123456Z",
    ...overrides,
  };
}
describe("HTTP storage transport contract", () => {
  it("confirms fresh claim and original replay UUID with exact projection", async () => {
    const db = createSqlStub();
    db.returnRows([claimRow()]);
    expect(await claimGatewayHttpRequest(claim, db.client)).toMatchObject({
      didClaim: true,
      billingRequestId: ids.billing,
      createdAt: instant,
    });
    db.returnRows([
      claimRow({ did_claim: false, billing_request_id: ids.attempt }),
    ]);
    expect(await claimGatewayHttpRequest(claim, db.client)).toMatchObject({
      didClaim: false,
      billingRequestId: ids.attempt,
    });
  });
  it("returns exact bigint and microseconds with detached frozen response", async () => {
    const db = createSqlStub();
    const row = readRow();
    db.returnRows([row]);
    expect(await readGatewayHttpResult(identity, db.client)).toMatchObject({
      status: "ready",
      actualCostCredits: 9007199254740993n,
      storedAt: instant,
      response: response(),
    });
  });
  it("expires only confirmed boolean", async () => {
    const db = createSqlStub();
    db.returnRows([{ did_expire: true }]);
    expect(
      await expireGatewayHttpResult(
        { orgId: ids.org, billingRequestId: ids.billing },
        db.client,
      ),
    ).toBe(true);
  });
});

const unavailable = { code: "HTTP_STORAGE_UNAVAILABLE" };
describe("HTTP fails closed before and after transport", () => {
  it.each([
    { orgId: null },
    { apiKeyId: "bad" },
    { billingRequestId: undefined },
    { contractVersion: "1" },
    { routeKind: "embeddings" },
    { billingMode: "byok_fee" },
    { idempotencyKeyDigest: "A".repeat(64) },
    { requestFingerprint: "b".repeat(63) },
    { requestFingerprint: "b".repeat(64) + "\n" },
  ])("rejects invalid claim input %j before transport", async (patch) => {
    const db = createSqlStub();
    await expect(
      claimGatewayHttpRequest(
        { ...claim, ...patch } as typeof claim,
        db.client,
      ),
    ).rejects.toMatchObject(unavailable);
    expect(db.queries).toHaveLength(0);
  });
  it("rejects accessor/prototype inputs without reading accessors", async () => {
    const db = createSqlStub(),
      getter = vi.fn(() => ids.org);
    const input = { ...claim };
    Object.defineProperty(input, "orgId", { get: getter });
    await expect(
      claimGatewayHttpRequest(input, db.client),
    ).rejects.toMatchObject(unavailable);
    expect(getter).not.toHaveBeenCalled();
    await expect(
      claimGatewayHttpRequest(Object.create(claim), db.client),
    ).rejects.toMatchObject(unavailable);
    expect(db.queries).toHaveLength(0);
  });
  it.each([
    [],
    [claimRow(), claimRow()],
    [null],
    [claimRow({ extra: true })],
    [claimRow({ did_claim: "false" })],
    [claimRow({ billing_request_id: ids.attempt })],
    [claimRow({ org_id: ids.attempt })],
    [claimRow({ api_key_id: ids.attempt })],
    [claimRow({ contract_version: "1" })],
    [claimRow({ route_kind: "audio" })],
    [claimRow({ billing_mode: "byok_fee" })],
    [claimRow({ idempotency_key_digest: "c".repeat(64) })],
    [claimRow({ request_fingerprint: "c".repeat(64) })],
    [claimRow({ created_at: "2026-09-07T12:00:00.123Z" })],
  ])("rejects unknown claim ACK %#", async (...rows: unknown[]) => {
    const db = createSqlStub();
    db.returnRows(rows);
    await expect(
      claimGatewayHttpRequest(claim, db.client),
    ).rejects.toMatchObject(unavailable);
  });
  it.each([
    ["P0005", "HTTP_ACCESS_DENIED", "HTTP_STORAGE_ACCESS_DENIED"],
    ["P0005", "HTTP_IDENTITY_CONFLICT", "HTTP_STORAGE_CONFLICT"],
    ["P0001", "private body and secret", "HTTP_STORAGE_UNAVAILABLE"],
    ["08006", "private connection", "HTTP_STORAGE_UNAVAILABLE"],
  ])("sanitizes SQL %s %s", async (code, message, expected) => {
    const db = createSqlStub();
    db.throwError(Object.assign(new Error(message), { code }));
    const error = await readGatewayHttpResult(identity, db.client).catch(
      (e) => e,
    );
    expect(error.code).toBe(expected);
    expect(error.message).not.toContain(message);
  });
  it.each(["not_found", "pending", "unavailable", "expired"] as const)(
    "enforces %s nullability and minimal public result",
    async (status) => {
      const db = createSqlStub();
      const r = readRow({
        status,
        billing_request_id: status === "not_found" ? null : ids.billing,
        http_status: null,
        content_type: null,
        response_body: null,
        actual_cost_credits: null,
        stored_at: status === "expired" ? instant : null,
        expires_at: status === "expired" ? "2026-09-14T12:00:00.123456Z" : null,
      });
      db.returnRows([r]);
      const value = await readGatewayHttpResult(identity, db.client);
      expect(value).toEqual({
        contractVersion: 1,
        status,
        ...(status === "not_found" ? {} : { billingRequestId: ids.billing }),
        ...(status === "expired"
          ? { storedAt: instant, expiresAt: r.expires_at }
          : {}),
      });
      db.returnRows([{ ...r, response_body: response() }]);
      await expect(
        readGatewayHttpResult(identity, db.client),
      ).rejects.toMatchObject(unavailable);
    },
  );
  it.each([
    { actual_cost_credits: 9007199254740992 },
    { actual_cost_credits: 41n },
    { actual_cost_credits: "-1" },
    { actual_cost_credits: "9223372036854775808" },
    { actual_cost_credits: "01" },
    { http_status: "200" },
    { content_type: "application/json; charset=utf8" },
    { response_body: null },
    { billing_request_id: null },
    { status: "fresh" },
    { contract_version: 2 },
    { expires_at: instant },
    { stored_at: new Date() },
    { extra: true },
  ])("rejects malformed ready result %#", async (patch) => {
    const db = createSqlStub();
    db.returnRows([readRow(patch)]);
    await expect(
      readGatewayHttpResult(identity, db.client),
    ).rejects.toMatchObject(unavailable);
  });
  it("preserves maximum bigint and freezes nested read data", async () => {
    const db = createSqlStub(),
      r = readRow({ actual_cost_credits: "9223372036854775807" });
    db.returnRows([r]);
    const v = await readGatewayHttpResult(identity, db.client);
    if (v.status !== "ready") throw Error(v.status);
    expect(v.actualCostCredits).toBe(9223372036854775807n);
    expect(Object.isFrozen(v.response.choices[0]!.message)).toBe(true);
    expect(v.response).not.toBe(r.response_body);
    r.response_body.choices[0]!.message.content = "mutated";
    expect(v.response.choices[0]!.message.content).not.toBe("mutated");
  });
  it.each([
    null,
    { ...response(), provider: "private" },
    { ...response(), created: "1" },
    { ...response(), choices: [] },
    {
      ...response(),
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 13 },
    },
    {
      ...response(),
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        cached_input_tokens: 11,
      },
    },
    {
      ...response(),
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: null, tool_calls: [] },
          finish_reason: "stop",
        },
      ],
    },
  ])("rejects unsupported DTO %#", async (body) => {
    const db = createSqlStub();
    db.returnRows([readRow({ response_body: body })]);
    await expect(
      readGatewayHttpResult(identity, db.client),
    ).rejects.toMatchObject(unavailable);
  });
  it.each([
    [],
    [{ did_expire: "false" }],
    [{ did_expire: null }],
    [{ did_expire: false, extra: 1 }],
    [{ did_expire: false }, { did_expire: true }],
  ])("rejects unknown expiry ACK %#", async (...rows: unknown[]) => {
    const db = createSqlStub();
    db.returnRows(rows);
    await expect(
      expireGatewayHttpResult(
        { orgId: ids.org, billingRequestId: ids.billing },
        db.client,
      ),
    ).rejects.toMatchObject(unavailable);
  });
});
function outcomeArgs() {
  return {
    admission: parseGatewayChargeAdmissionResult(dispatchedRow()),
    actualCostCredits: 41n,
    usageSnapshot: { prompt_tokens: 10, completion_tokens: 2 },
    outcomeKind: "success" as const,
    response: response(),
    idempotencyKeyDigest: identity.idempotencyKeyDigest,
    requestFingerprint: identity.requestFingerprint,
  };
}
describe("atomic HTTP outcome", () => {
  it("uses shared 31-field financial checks and binds detached JSON exactly once before await", async () => {
    const db = createSqlStub(),
      a = outcomeArgs();
    db.returnRows([outcomeRow()]);
    const pending = recordGatewayHttpOutcome(a, db.client);
    a.response.choices[0]!.message.content = "mutated";
    a.usageSnapshot.prompt_tokens = 999;
    const result = await pending;
    expect(result.actualCostCredits).toBe(41n);
    const q = db.queries[0]!;
    expect(q.text).toContain("aiag_record_gateway_http_outcome_v1");
    expect(q.text.match(/::text::jsonb/g)).toHaveLength(2);
    expect(q.values).toContain(JSON.stringify(response()));
    expect(q.values).toContain(
      JSON.stringify({ prompt_tokens: 10, completion_tokens: 2 }),
    );
    expect(q.text).toContain("actual_cost_credits::text");
    expect(Object.keys(result)).toHaveLength(31);
  });
  it.each([
    { actualCostCredits: 41 },
    { actualCostCredits: "41" },
    { actualCostCredits: -1n },
    { actualCostCredits: 9223372036854775808n },
    { outcomeKind: "verified_no_charge" },
    { requestFingerprint: null },
    { response: { ...response(), secret: true } },
  ])("rejects invalid outcome before transport %#", async (patch) => {
    const db = createSqlStub();
    await expect(
      recordGatewayHttpOutcome(
        { ...outcomeArgs(), ...patch } as ReturnType<typeof outcomeArgs>,
        db.client,
      ),
    ).rejects.toMatchObject(unavailable);
    expect(db.queries).toHaveLength(0);
  });
  it.each([
    { state: "held" },
    { route_kind: "embeddings" },
    { billing_mode: "byok_fee" },
  ])("rejects invalid anchor %#", async (patch) => {
    const db = createSqlStub();
    const admission = patch.state
      ? parseGatewayChargeAdmissionResult(heldRow())
      : parseGatewayChargeAdmissionResult(dispatchedRow(patch));
    await expect(
      recordGatewayHttpOutcome({ ...outcomeArgs(), admission }, db.client),
    ).rejects.toMatchObject(unavailable);
    expect(db.queries).toHaveLength(0);
  });
  it("rejects snapshot accessor without invocation", async () => {
    const db = createSqlStub(),
      a = outcomeArgs(),
      getter = vi.fn(() => 10);
    Object.defineProperty(a.usageSnapshot, "prompt_tokens", { get: getter });
    await expect(recordGatewayHttpOutcome(a, db.client)).rejects.toMatchObject(
      unavailable,
    );
    expect(getter).not.toHaveBeenCalled();
    expect(db.queries).toHaveLength(0);
  });
  it.each([
    [],
    [outcomeRow(), outcomeRow()],
    [outcomeRow({ actual_cost_credits: "42" })],
    [outcomeRow({ billing_request_id: ids.attempt })],
    [outcomeRow({ usage_snapshot: {} })],
    [outcomeRow({ extra: true })],
    [dispatchedRow()],
    [outcomeRow({ actual_cost_credits: 41 })],
  ])(
    "rejects ambiguous or foreign financial ACK %#",
    async (...rows: unknown[]) => {
      const db = createSqlStub();
      db.returnRows(rows);
      await expect(
        recordGatewayHttpOutcome(outcomeArgs(), db.client),
      ).rejects.toMatchObject(unavailable);
    },
  );
  it("allows exact outcome replay and rejects changed prior facts before transport", async () => {
    const db = createSqlStub();
    const admission = parseGatewayChargeAdmissionResult(outcomeRow());
    db.returnRows([outcomeRow({ did_transition: false })]);
    expect(
      await recordGatewayHttpOutcome(
        { ...outcomeArgs(), admission },
        db.client,
      ),
    ).toMatchObject({ state: "outcome_recorded", didTransition: false });
    await expect(
      recordGatewayHttpOutcome(
        { ...outcomeArgs(), admission, actualCostCredits: 42n },
        db.client,
      ),
    ).rejects.toMatchObject(unavailable);
    expect(db.queries).toHaveLength(1);
  });
});
