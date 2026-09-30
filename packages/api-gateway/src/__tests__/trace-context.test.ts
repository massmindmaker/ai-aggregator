/**
 * AG-6 Task 4 — trace-context unit tests.
 *
 * Pure unit tests against a stub SqlClient: no database, no network, no money.
 * The stub compiles tagged templates into $n placeholders, which lets these
 * tests assert the SQL-safety invariant that matters here — the operator's
 * identifier is always a BOUND parameter and never spliced into SQL text.
 */
import { describe, expect, it, vi } from "vitest";
vi.mock("../lib/db", () => ({ sql: vi.fn() }));
import type { SqlClient } from "../lib/db";
import {
  TraceContextForbiddenError,
  TraceContextInvalidError,
  TraceContextUnavailableError,
  classifyTraceIdentifier,
  readTraceContext,
  reconcileTrace,
  resolveTraceAnchor,
  type TraceAdminContext,
  type TraceAdmission,
  type TraceLedgerEntry,
} from "../billing/trace-context";

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

const IDS = {
  billing: "11111111-1111-4111-8111-111111111111",
  org: "22222222-2222-4222-8222-222222222222",
  key: "33333333-3333-4333-8333-333333333333",
  attempt: "44444444-4444-4444-8444-444444444444",
  job: "55555555-5555-4555-8555-555555555555",
  bucket: "66666666-6666-4666-8666-666666666666",
  version: "77777777-7777-4777-8777-777777777777",
  policy: "88888888-8888-4888-8888-888888888888",
  author: "99999999-9999-4999-8999-999999999999",
  ledger: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  refund: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  resolution: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  ledgerEntry: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  otherOrg: "abababab-abab-4bab-8bab-abababababab",
  admin: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
  task: `task_${"0123456789abcdef".repeat(2)}`,
} as const;

const T0 = "2026-09-30T10:00:00.000000Z";

/** Admin context required by readTraceContext (admin-only, fail closed). */
const ADMIN = Object.freeze({ actorId: IDS.admin });

function anchorRow(over: Record<string, unknown> = {}) {
  return {
    anchor_kind: "billing_request_id",
    billing_request_id: IDS.billing,
    org_id: IDS.org,
    task_id: null,
    attempt_id: null,
    ledger_request_id: null,
    ...over,
  };
}

function admissionRow(over: Record<string, unknown> = {}) {
  return {
    billing_request_id: IDS.billing,
    org_id: IDS.org,
    api_key_id: IDS.key,
    client_request_id: "client-req-1",
    route_kind: "chat",
    billing_mode: "stored",
    model_slug: "author-model",
    authorized_max_credits: "1000",
    held_subscription_credits: "1000",
    held_payg_credits: "0",
    actual_cost_credits: "900",
    attempt_id: IDS.attempt,
    upstream_id: `author:${IDS.version}`,
    outcome_kind: "success",
    state: "settled",
    released_subscription_credits: "100",
    released_payg_credits: "0",
    debt_repaid_credits: "0",
    expired_subscription_credits: "0",
    created_at: T0,
    dispatched_at: T0,
    outcome_recorded_at: T0,
    settled_at: T0,
    cancelled_at: null,
    reconcile_after: null,
    ...over,
  };
}

function ledgerRow(over: Record<string, unknown> = {}) {
  return {
    id: IDS.ledgerEntry,
    request_id: `gw:${IDS.billing}`,
    type: "api_usage",
    source: "subscription",
    delta: "-900",
    created_at: T0,
    ...over,
  };
}

/** Queue the full happy-path response set for readTraceContext. */
function queueFullTrace(stub: ReturnType<typeof createSqlStub>, overrides: {
  admission?: Record<string, unknown> | null;
  ledger?: unknown[];
  authorLedger?: unknown[];
  ledgerMetadata?: unknown[];
} = {}) {
  stub.returnRows([anchorRow()]);
  stub.returnRows([
    {
      id: IDS.org,
      slug: "acme",
      name: "Acme",
      status: "active",
      subscription_credits: "500000",
      payg_credits: "0",
      refund_debt_credits: "0",
      subscription_credits_expires_at: null,
    },
  ]);
  if (overrides.admission !== null)
    stub.returnRows(
      overrides.admission === undefined ? [admissionRow()] : [overrides.admission],
    );
  else stub.returnRows([]);
  stub.returnRows([
    {
      event_key: "admission",
      event_kind: "admission",
      held_subscription_credits: "1000",
      held_payg_credits: "0",
      used_subscription_credits: "0",
      used_payg_credits: "0",
      released_subscription_credits: "0",
      released_payg_credits: "0",
      debt_repaid_credits: "0",
      expired_subscription_credits: "0",
      created_at: T0,
    },
    {
      event_key: "settlement",
      event_kind: "settlement",
      held_subscription_credits: "0",
      held_payg_credits: "0",
      used_subscription_credits: "900",
      used_payg_credits: "0",
      released_subscription_credits: "100",
      released_payg_credits: "0",
      debt_repaid_credits: "0",
      expired_subscription_credits: "0",
      created_at: T0,
    },
  ]);
  stub.returnRows([
    {
      billing_request_id: IDS.billing,
      quota_version: 2,
      api_key_id: IDS.key,
      declared_session_id: "sess-1",
      supplier_formula_version: "author-fixed-microcredits-v1",
      supplier_authorized_max_usd_micro: "90",
      supplier_actual_usd_micro: "90",
      admitted_at: T0,
    },
  ]);
  stub.returnRows([
    {
      bucket_id: IDS.bucket,
      kind: "key_session_charged_v2",
      reserved_max: "1000",
      actual_amount: "900",
      state: "settled",
    },
  ]);
  stub.returnRows([
    {
      kind: "key_session_charged_v2",
      event_kind: "reserve",
      bucket_id: IDS.bucket,
      reserved_delta: "1000",
      settled_delta: "0",
      released_amount: "0",
      created_at: T0,
    },
  ]);
  stub.returnRows([
    {
      billing_request_id: IDS.billing,
      api_key_id: IDS.key,
      route_kind: "chat",
      billing_mode: "stored",
      contract_version: 1,
      created_at: T0,
    },
  ]);
  stub.returnRows([
    {
      billing_request_id: IDS.billing,
      contract_version: 1,
      http_status: 200,
      content_type: "application/json",
      response_digest: "sha256:deadbeef",
      stored_at: T0,
      payload_expired_at: null,
    },
  ]);
  stub.returnRows([]);
  stub.returnRows([
    {
      id: IDS.job,
      task_id: IDS.task,
      billing_request_id: IDS.billing,
      route_kind: "audio_transcription",
      status: "completed",
      model_slug: "whisper-large-v3",
      upstream_id: "groq",
      provider_family: "groq_stt",
      provider_task_id: null,
      quoted_retail_microcredits: "500",
      quoted_supplier_microcredits: "45",
      deadline_at: T0,
      settled_at: T0,
      error_message: null,
    },
  ]);
  stub.returnRows([
    {
      billing_request_id: IDS.billing,
      author_user_id: IDS.author,
      version_id: IDS.version,
      policy_id: IDS.policy,
      disputed: false,
      created_at: T0,
    },
  ]);
  stub.returnRows(
    overrides.authorLedger === undefined
      ? [
          {
            id: IDS.refund,
            kind: "accrual",
            amount_microcredits: "450",
            available_at: T0,
            created_at: T0,
          },
        ]
      : overrides.authorLedger,
  );
  stub.returnRows([
    {
      refund_id: IDS.refund,
      total_microcredits: "900",
      subscription_microcredits: "900",
      payg_microcredits: "0",
      expired_subscription_microcredits: "0",
      debt_repaid_microcredits: "0",
      created_at: T0,
    },
  ]);
  stub.returnRows([
    {
      id: IDS.resolution,
      attempt_id: IDS.attempt,
      kind: "verified_no_charge",
      created_at: T0,
    },
  ]);
  // readLedger issues TWO statements now: the indexable request_id half, then
  // the deliberate metadata seq-scan half. Queue both.
  stub.returnRows(overrides.ledger === undefined ? [ledgerRow()] : overrides.ledger);
  stub.returnRows(overrides.ledgerMetadata ?? []);
  stub.returnRows([
    {
      id: "1",
      actor_email: "admin@aiag.local",
      action: "author.request.dispute",
      details: { disputed: true },
      created_at: T0,
    },
  ]);
}

describe("classifyTraceIdentifier", () => {
  it("accepts a v4 uuid", () => {
    expect(classifyTraceIdentifier(IDS.billing)).toEqual({
      kind: "uuid",
      value: IDS.billing,
    });
  });

  it("accepts a media task id", () => {
    expect(classifyTraceIdentifier(IDS.task)).toEqual({
      kind: "task_id",
      value: IDS.task,
    });
  });

  it("trims surrounding whitespace", () => {
    expect(classifyTraceIdentifier(`  ${IDS.billing}\n`).kind).toBe("uuid");
  });

  it.each([
    ["empty", ""],
    ["non-uuid text", "not-an-identifier"],
    ["uuid without dashes", "11111111111141118111111111111111"],
    ["uuid with wrong version nibble", "11111111-1111-6111-8111-111111111111"],
    ["task id with non-hex tail", "task_zzzz456789abcdef0123456789abcdef"],
    ["task id with short tail", "task_0123"],
    ["sql injection attempt", "11111111-1111-4111-8111-111111111111' OR '1'='1"],
  ])("rejects %s", (_label, value) => {
    expect(() => classifyTraceIdentifier(value)).toThrow(TraceContextInvalidError);
  });

  it("rejects a non-string identifier", () => {
    expect(() =>
      classifyTraceIdentifier(undefined as unknown as string),
    ).toThrow(TraceContextInvalidError);
  });
});

describe("resolveTraceAnchor", () => {
  it("returns null when nothing matches the identifier", async () => {
    const stub = createSqlStub();
    stub.returnRows([]);
    await expect(resolveTraceAnchor(IDS.billing, stub.client)).resolves.toBeNull();
  });

  it("passes the identifier as a bound parameter, never as SQL text", async () => {
    const stub = createSqlStub();
    stub.returnRows([anchorRow()]);
    await resolveTraceAnchor(IDS.billing, stub.client);
    const [query] = stub.queries;
    expect(query.text).toContain("$1::uuid");
    expect(query.text).not.toContain(IDS.billing);
    expect(query.values).toEqual([IDS.billing, IDS.billing, IDS.billing, IDS.billing, IDS.billing, IDS.billing, IDS.billing, IDS.billing]);
  });

  it("queries only prediction_jobs for a media task id", async () => {
    const stub = createSqlStub();
    stub.returnRows([
      {
        anchor_kind: "media_task_id",
        billing_request_id: IDS.billing,
        org_id: IDS.org,
        task_id: IDS.task,
        attempt_id: null,
        ledger_request_id: null,
      },
    ]);
    const anchor = await resolveTraceAnchor(IDS.task, stub.client);
    expect(anchor).toEqual({
      kind: "media_task_id",
      matchedId: IDS.task,
      billingRequestId: IDS.billing,
      orgId: IDS.org,
      taskId: IDS.task,
      attemptId: null,
      ledgerRequestId: null,
    });
    expect(stub.queries).toHaveLength(1);
    expect(stub.queries[0].text).toContain("FROM prediction_jobs");
    expect(stub.queries[0].text).toContain("$1::varchar");
    expect(stub.queries[0].values).toEqual([IDS.task]);
  });

  it("recovers the billing id from a settlement receipt anchor", async () => {
    const stub = createSqlStub();
    stub.returnRows([
      {
        anchor_kind: "ledger_receipt",
        billing_request_id: null,
        org_id: IDS.org,
        task_id: null,
        attempt_id: null,
        ledger_request_id: `gw:${IDS.billing}`,
      },
    ]);
    const anchor = await resolveTraceAnchor(IDS.ledger, stub.client);
    expect(anchor?.kind).toBe("ledger_receipt");
    expect(anchor?.billingRequestId).toBe(IDS.billing);
    expect(anchor?.ledgerRequestId).toBe(`gw:${IDS.billing}`);
  });

  it("resolves an org anchor with no billing id", async () => {
    const stub = createSqlStub();
    stub.returnRows([
      {
        anchor_kind: "organization",
        billing_request_id: null,
        org_id: IDS.org,
        task_id: null,
        attempt_id: null,
        ledger_request_id: null,
      },
    ]);
    const anchor = await resolveTraceAnchor(IDS.org, stub.client);
    expect(anchor?.kind).toBe("organization");
    expect(anchor?.billingRequestId).toBeNull();
    expect(anchor?.orgId).toBe(IDS.org);
  });

  it("rejects an anchor row whose kind is not part of the contract", async () => {
    const stub = createSqlStub();
    stub.returnRows([anchorRow({ anchor_kind: "sql_injection" })]);
    await expect(resolveTraceAnchor(IDS.billing, stub.client)).rejects.toThrow(
      TraceContextUnavailableError,
    );
  });

  it("fails closed when the anchor row carries a non-uuid org id", async () => {
    const stub = createSqlStub();
    stub.returnRows([anchorRow({ org_id: "acme" })]);
    await expect(resolveTraceAnchor(IDS.billing, stub.client)).rejects.toThrow(
      TraceContextUnavailableError,
    );
  });

  it("wraps a driver error instead of leaking it", async () => {
    const stub = createSqlStub();
    stub.throwError(new Error("connection terminated unexpectedly"));
    await expect(resolveTraceAnchor(IDS.billing, stub.client)).rejects.toThrow(
      TraceContextUnavailableError,
    );
  });

  it("propagates an invalid identifier without touching the database", async () => {
    const stub = createSqlStub();
    await expect(resolveTraceAnchor("nope", stub.client)).rejects.toThrow(
      TraceContextInvalidError,
    );
    expect(stub.queries).toHaveLength(0);
  });
});

describe("readTraceContext", () => {
  it("assembles the tenant → run → request → charge chain from one id", async () => {
    const stub = createSqlStub();
    queueFullTrace(stub);
    const trace = await readTraceContext(IDS.billing, ADMIN, stub.client);

    expect(trace).not.toBeNull();
    expect(trace?.anchor.kind).toBe("billing_request_id");
    expect(trace?.organization?.slug).toBe("acme");
    expect(trace?.organization?.subscriptionCredits).toBe(500000n);
    expect(trace?.admission?.state).toBe("settled");
    expect(trace?.admission?.actualCostCredits).toBe(900n);
    expect(trace?.admission?.attemptId).toBe(IDS.attempt);
    expect(trace?.admissionEvents).toHaveLength(2);
    expect(trace?.quotaContext?.quotaVersion).toBe(2);
    expect(trace?.quotaReservations[0]?.actualAmount).toBe(900n);
    expect(trace?.quotaEvents[0]?.reservedDelta).toBe(1000n);
    expect(trace?.httpRequest?.routeKind).toBe("chat");
    expect(trace?.httpResult?.httpStatus).toBe(200);
    expect(trace?.httpRejection).toBeNull();
    expect(trace?.mediaJob?.taskId).toBe(IDS.task);
    expect(trace?.authorBinding?.authorUserId).toBe(IDS.author);
    expect(trace?.authorLedger[0]?.amountMicrocredits).toBe(450n);
    expect(trace?.authorRefund?.totalMicrocredits).toBe(900n);
    expect(trace?.authorResolution?.kind).toBe("verified_no_charge");
    expect(trace?.ledger[0]?.delta).toBe(-900n);
    expect(trace?.auditLog[0]?.action).toBe("author.request.dispute");
  });

  it("issues only SELECTs — the helper must never move money", async () => {
    const stub = createSqlStub();
    queueFullTrace(stub);
    await readTraceContext(IDS.billing, ADMIN, stub.client);
    for (const query of stub.queries) {
      expect(query.text).toMatch(/^SELECT /);
      expect(query.text).not.toMatch(
        /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/,
      );
    }
  });

  it("binds the billing id in every statement that reads the request chain", async () => {
    const stub = createSqlStub();
    queueFullTrace(stub);
    await readTraceContext(IDS.billing, ADMIN, stub.client);
    // The org statement is keyed on the org id alone; every other statement in
    // the trace must carry the billing id as a bound value, never as SQL text.
    const chainQueries = stub.queries.filter(
      (query) => !query.text.includes("FROM organizations"),
    );
    expect(chainQueries.length).toBeGreaterThan(0);
    for (const query of chainQueries) {
      expect(query.text).not.toContain(IDS.billing);
      // The money ledger keys on the receipt form 'gw:'||billing (0067:588) and
      // 'author-refund:'||billing (0089:219), so its bound values are the
      // prefixed ids; every other chain statement binds the bare uuid.
      const bindsBillingId = query.values.some(
        (value) =>
          value === IDS.billing ||
          value === `gw:${IDS.billing}` ||
          value === `author-refund:${IDS.billing}`,
      );
      expect(bindsBillingId).toBe(true);
    }
  });

  it("returns null for an unknown but well-formed identifier", async () => {
    const stub = createSqlStub();
    stub.returnRows([]);
    await expect(readTraceContext(IDS.billing, ADMIN, stub.client)).resolves.toBeNull();
  });

  it("returns only the organization for an org-scoped identifier", async () => {
    const stub = createSqlStub();
    stub.returnRows([
      {
        anchor_kind: "organization",
        billing_request_id: null,
        org_id: IDS.org,
        task_id: null,
        attempt_id: null,
        ledger_request_id: null,
      },
    ]);
    stub.returnRows([
      {
        id: IDS.org,
        slug: "acme",
        name: "Acme",
        status: "active",
        subscription_credits: "10",
        payg_credits: "5",
        refund_debt_credits: "0",
        subscription_credits_expires_at: T0,
      },
    ]);
    const trace = await readTraceContext(IDS.org, ADMIN, stub.client);
    expect(trace?.organization?.paygCredits).toBe(5n);
    expect(trace?.organization?.subscriptionCreditsExpiresAt).toBe(T0);
    expect(trace?.admission).toBeNull();
    expect(trace?.ledger).toEqual([]);
    expect(trace?.reconciliation.balanced).toBeNull();
    // 2 statements: anchor + org. No request chain is invented.
    expect(stub.queries).toHaveLength(2);
  });

  it("finds the media job by task id when the anchor carries one", async () => {
    const stub = createSqlStub();
    stub.returnRows([
      {
        anchor_kind: "media_task_id",
        billing_request_id: IDS.billing,
        org_id: IDS.org,
        task_id: IDS.task,
        attempt_id: null,
        ledger_request_id: null,
      },
    ]);
    // Statement order: anchor, org, admission, events, quota ctx, quota
    // reservations, quota events, http request, http result, http rejection,
    // media job, ... Only the media row is non-empty; the point of this test is
    // that the task id reaches prediction_jobs as a bound parameter.
    for (let i = 0; i < 9; i += 1) stub.returnRows([]);
    stub.returnRows([
      {
        id: IDS.job,
        task_id: IDS.task,
        billing_request_id: IDS.billing,
        route_kind: "audio_transcription",
        status: "completed",
        model_slug: "whisper-large-v3",
        upstream_id: "groq",
        provider_family: "groq_stt",
        provider_task_id: null,
        quoted_retail_microcredits: "500",
        quoted_supplier_microcredits: "45",
        deadline_at: T0,
        settled_at: T0,
        error_message: null,
      },
    ]);
    for (let i = 0; i < 6; i += 1) stub.returnRows([]);

    const trace = await readTraceContext(IDS.task, ADMIN, stub.client);
    const mediaQuery = stub.queries.find((q) =>
      q.text.includes("FROM prediction_jobs"),
    );
    expect(mediaQuery?.values).toContain(IDS.task);
    expect(trace?.mediaJob?.taskId).toBe(IDS.task);
    expect(trace?.anchor.taskId).toBe(IDS.task);
  });

  it("reports an unbalanced ledger when credits were written beyond the charge", async () => {
    const stub = createSqlStub();
    queueFullTrace(stub, {
      ledger: [
        ledgerRow(),
        ledgerRow({
          id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          source: "payg",
          delta: "-50",
        }),
      ],
    });
    const trace = await readTraceContext(IDS.billing, ADMIN, stub.client);
    expect(trace?.reconciliation).toEqual({
      actualCostCredits: 900n,
      ledgerDeltaCredits: -950n,
      ledgerUsageEntries: 2,
      status: "unbalanced",
      balanced: false,
    });
  });

  it("reports balance for a settled admission whose ledger matches", async () => {
    const stub = createSqlStub();
    queueFullTrace(stub);
    const trace = await readTraceContext(IDS.billing, ADMIN, stub.client);
    expect(trace?.reconciliation.balanced).toBe(true);
  });

  it("does not claim balance for a held admission with no ledger write yet", async () => {
    const stub = createSqlStub();
    queueFullTrace(stub, {
      admission: admissionRow({
        state: "held",
        outcome_kind: null,
        actual_cost_credits: null,
        settled_at: null,
        outcome_recorded_at: null,
      }),
      ledger: [],
    });
    const trace = await readTraceContext(IDS.billing, ADMIN, stub.client);
    expect(trace?.reconciliation).toEqual({
      actualCostCredits: null,
      ledgerDeltaCredits: 0n,
      ledgerUsageEntries: 0,
      status: "unknown",
      balanced: null,
    });
  });

  it("fails closed rather than half-answering when a row is malformed", async () => {
    const stub = createSqlStub();
    queueFullTrace(stub, { admission: admissionRow({ state: null }) });
    await expect(readTraceContext(IDS.billing, ADMIN, stub.client)).rejects.toThrow(
      TraceContextUnavailableError,
    );
  });

  it("fails closed on a non-numeric credit column", async () => {
    const stub = createSqlStub();
    queueFullTrace(stub, { admission: admissionRow({ actual_cost_credits: "900.5" }) });
    await expect(readTraceContext(IDS.billing, ADMIN, stub.client)).rejects.toThrow(
      TraceContextUnavailableError,
    );
  });

  it("fails closed on a tampered uuid column", async () => {
    const stub = createSqlStub();
    queueFullTrace(stub, { admission: admissionRow({ attempt_id: "not-a-uuid" }) });
    await expect(readTraceContext(IDS.billing, ADMIN, stub.client)).rejects.toThrow(
      TraceContextUnavailableError,
    );
  });

  it("wraps a mid-chain database failure into an unavailable error", async () => {
    const stub = createSqlStub();
    // Anchor and org resolve fine; the admission statement — the third in the
    // chain — dies mid-flight. The caller must see only the typed error, never
    // a half-assembled trace and never the raw driver error.
    stub.returnRows([anchorRow()]);
    stub.returnRows([
      {
        id: IDS.org,
        slug: "acme",
        name: "Acme",
        status: "active",
        subscription_credits: "0",
        payg_credits: "0",
        refund_debt_credits: "0",
        subscription_credits_expires_at: null,
      },
    ]);
    stub.throwError(new Error("deadlock detected"));
    await expect(readTraceContext(IDS.billing, ADMIN, stub.client)).rejects.toThrow(
      TraceContextUnavailableError,
    );
  });
});

describe("reconcileTrace", () => {
  const admission = (over: Partial<TraceAdmission> = {}) =>
    ({
      billingRequestId: IDS.billing,
      orgId: IDS.org,
      apiKeyId: IDS.key,
      clientRequestId: null,
      routeKind: "chat",
      billingMode: "stored",
      modelSlug: "m",
      authorizedMaxCredits: 1000n,
      heldSubscriptionCredits: 1000n,
      heldPaygCredits: 0n,
      actualCostCredits: 900n,
      attemptId: null,
      upstreamId: null,
      outcomeKind: "success",
      state: "settled",
      releasedSubscriptionCredits: 0n,
      releasedPaygCredits: 0n,
      debtRepaidCredits: 0n,
      expiredSubscriptionCredits: 0n,
      createdAt: T0,
      dispatchedAt: T0,
      outcomeRecordedAt: T0,
      settledAt: T0,
      cancelledAt: null,
      reconcileAfter: null,
      ...over,
    }) as TraceAdmission;

  const entry = (over: Partial<TraceLedgerEntry> = {}) =>
    ({
      id: IDS.ledgerEntry,
      requestId: `gw:${IDS.billing}`,
      type: "api_usage",
      source: "subscription",
      delta: -900n,
      createdAt: T0,
      ...over,
    }) as TraceLedgerEntry;

  it("is unknown without an admission", () => {
    expect(reconcileTrace(null, [entry()])).toEqual({
      actualCostCredits: null,
      ledgerDeltaCredits: -900n,
      ledgerUsageEntries: 1,
      status: "unknown",
      balanced: null,
    });
  });

  it("ignores non-usage ledger types", () => {
    const result = reconcileTrace(admission(), [
      entry(),
      entry({ type: "topup", source: "ton", delta: 5000n }),
    ]);
    expect(result.ledgerDeltaCredits).toBe(-900n);
    expect(result.ledgerUsageEntries).toBe(1);
    expect(result.balanced).toBe(true);
  });

  it("reports a zero-credit verified_no_charge as not_charged, with no usage row", () => {
    // 0067:589 writes an api_usage receipt only when _used_* > 0, so a
    // verified_no_charge trace has NO usage entry at all. That is a verified
    // fact ("nothing was taken"), not missing information.
    const result = reconcileTrace(
      admission({ actualCostCredits: 0n, outcomeKind: "verified_no_charge" }),
      [],
    );
    expect(result.status).toBe("not_charged");
    expect(result.balanced).toBeNull();
    expect(result.ledgerUsageEntries).toBe(0);
    expect(result.ledgerDeltaCredits).toBe(0n);
  });

  it("still calls out usage written against a zero-cost admission", () => {
    const result = reconcileTrace(
      admission({ actualCostCredits: 0n, outcomeKind: "verified_no_charge" }),
      [entry({ delta: -50n })],
    );
    expect(result.status).toBe("unbalanced");
    expect(result.balanced).toBe(false);
  });

  it("keeps a zero-credit admission with a zero-delta usage row balanced", () => {
    const result = reconcileTrace(
      admission({ actualCostCredits: 0n, outcomeKind: "verified_no_charge" }),
      [entry({ delta: 0n })],
    );
    expect(result.status).toBe("balanced");
    expect(result.balanced).toBe(true);
  });

  it("detects a ledger with no usage row as unknown, not as balanced", () => {
    const result = reconcileTrace(admission(), []);
    expect(result.status).toBe("unknown");
    expect(result.balanced).toBeNull();
  });

  it("detects a mismatch", () => {
    expect(reconcileTrace(admission(), [entry({ delta: -100n })]).balanced).toBe(
      false,
    );
  });

  it("does not treat a non-usage-only ledger as balanced", () => {
    const result = reconcileTrace(admission(), [
      entry({ type: "refund", delta: 900n }),
    ]);
    expect(result.ledgerUsageEntries).toBe(0);
    expect(result.status).toBe("unknown");
    expect(result.balanced).toBeNull();
  });
});

describe("readTraceContext authorization", () => {
  it("refuses without an admin context and reads nothing at all", async () => {
    const stub = createSqlStub();
    await expect(
      readTraceContext(
        IDS.billing,
        undefined as unknown as TraceAdminContext,
        stub.client,
      ),
    ).rejects.toThrow(TraceContextForbiddenError);
    // The refusal happens BEFORE the first statement: an unauthorized caller
    // cannot even learn whether the identifier exists.
    expect(stub.queries).toHaveLength(0);
  });

  it("refuses a null admin context", async () => {
    const stub = createSqlStub();
    await expect(
      readTraceContext(
        IDS.billing,
        null as unknown as TraceAdminContext,
        stub.client,
      ),
    ).rejects.toThrow(TraceContextForbiddenError);
    expect(stub.queries).toHaveLength(0);
  });

  it("refuses a non-uuid actor id", async () => {
    const stub = createSqlStub();
    await expect(
      readTraceContext(
        IDS.billing,
        { actorId: "root" } as unknown as TraceAdminContext,
        stub.client,
      ),
    ).rejects.toThrow(TraceContextForbiddenError);
    expect(stub.queries).toHaveLength(0);
  });

  it("refuses a malformed org scope", async () => {
    const stub = createSqlStub();
    await expect(
      readTraceContext(
        IDS.billing,
        { actorId: IDS.admin, orgId: "acme" } as unknown as TraceAdminContext,
        stub.client,
      ),
    ).rejects.toThrow(TraceContextForbiddenError);
    expect(stub.queries).toHaveLength(0);
  });

  it("refuses a trace belonging to another org, and stops before the org read", async () => {
    const stub = createSqlStub();
    stub.returnRows([anchorRow()]);
    await expect(
      readTraceContext(
        IDS.billing,
        { actorId: IDS.admin, orgId: IDS.otherOrg },
        stub.client,
      ),
    ).rejects.toThrow(TraceContextForbiddenError);
    // Only the anchor lookup ran; no balance, no chain, for a foreign tenant.
    expect(stub.queries).toHaveLength(1);
    expect(stub.queries[0].text).toContain("anchor_kind");
  });

  it("allows an admin scoped to the trace's own org", async () => {
    const stub = createSqlStub();
    queueFullTrace(stub);
    const trace = await readTraceContext(
      IDS.billing,
      { actorId: IDS.admin, orgId: IDS.org },
      stub.client,
    );
    expect(trace?.organization?.slug).toBe("acme");
  });

  it("refuses even a syntactically invalid identifier without an admin context", async () => {
    const stub = createSqlStub();
    await expect(
      readTraceContext(
        "nope",
        undefined as unknown as TraceAdminContext,
        stub.client,
      ),
    ).rejects.toThrow(TraceContextForbiddenError);
    expect(stub.queries).toHaveLength(0);
  });
});

describe("readTraceContext anchor row for a null billing id", () => {
  it("returns the operator's own ledger row for a non-gateway receipt", async () => {
    const stub = createSqlStub();
    // (a) operator pastes a gateway_transactions.id for a topup/refund/
    // author-refund row. Its request_id is not 'gw:'-prefixed, so no billing id
    // is recoverable — but the row itself is the answer and must not vanish.
    stub.returnRows([
      {
        anchor_kind: "ledger_receipt",
        billing_request_id: null,
        org_id: IDS.org,
        task_id: null,
        attempt_id: null,
        ledger_request_id: "author-refund:" + IDS.billing,
      },
    ]);
    stub.returnRows([
      {
        id: IDS.org,
        slug: "acme",
        name: "Acme",
        status: "active",
        subscription_credits: "500000",
        payg_credits: "0",
        refund_debt_credits: "0",
        subscription_credits_expires_at: null,
      },
    ]);
    stub.returnRows([
      ledgerRow({
        id: IDS.ledger,
        request_id: "author-refund:" + IDS.billing,
        type: "refund",
        source: "subscription",
        delta: "900",
      }),
    ]);

    const trace = await readTraceContext(IDS.ledger, ADMIN, stub.client);
    expect(trace?.ledger).toHaveLength(1);
    expect(trace?.ledger[0]?.id).toBe(IDS.ledger);
    expect(trace?.ledger[0]?.type).toBe("refund");
    expect(trace?.ledger[0]?.delta).toBe(900n);
    expect(trace?.anchor.matchedId).toBe(IDS.ledger);
    // The own-row read is keyed on the primary key, as a bound parameter.
    const own = stub.queries[stub.queries.length - 1];
    expect(own.text).toContain("$1::uuid");
    expect(own.values).toEqual([IDS.ledger]);
  });

  it("returns the media job for a pre-0081 task id with a null billing id", async () => {
    const stub = createSqlStub();
    // (b) 0081 made prediction_jobs.billing_request_id nullable, so every
    // pre-0081 job has none. The operator typed the task_id; the job is the
    // answer and must not vanish.
    stub.returnRows([
      {
        anchor_kind: "media_task_id",
        billing_request_id: null,
        org_id: IDS.org,
        task_id: IDS.task,
        attempt_id: null,
        ledger_request_id: null,
      },
    ]);
    stub.returnRows([
      {
        id: IDS.org,
        slug: "acme",
        name: "Acme",
        status: "active",
        subscription_credits: "500000",
        payg_credits: "0",
        refund_debt_credits: "0",
        subscription_credits_expires_at: null,
      },
    ]);
    stub.returnRows([
      {
        id: IDS.job,
        task_id: IDS.task,
        billing_request_id: null,
        route_kind: "audio_transcription",
        status: "completed",
        model_slug: "whisper-large-v3",
        upstream_id: "groq",
        provider_family: "groq_stt",
        provider_task_id: null,
        quoted_retail_microcredits: "500",
        quoted_supplier_microcredits: "45",
        deadline_at: T0,
        settled_at: T0,
        error_message: null,
      },
    ]);

    const trace = await readTraceContext(IDS.task, ADMIN, stub.client);
    expect(trace?.mediaJob?.id).toBe(IDS.job);
    expect(trace?.mediaJob?.taskId).toBe(IDS.task);
    expect(trace?.mediaJob?.billingRequestId).toBeNull();
    // Keyed on task_id, an indexed lookup — not on a nullable billing id.
    const media = stub.queries[stub.queries.length - 1];
    expect(media.text).toContain("FROM prediction_jobs");
    expect(media.values).toEqual([IDS.task]);
  });

  it("still invents no request chain for an organization anchor", async () => {
    const stub = createSqlStub();
    stub.returnRows([
      {
        anchor_kind: "organization",
        billing_request_id: null,
        org_id: IDS.org,
        task_id: null,
        attempt_id: null,
        ledger_request_id: null,
      },
    ]);
    stub.returnRows([
      {
        id: IDS.org,
        slug: "acme",
        name: "Acme",
        status: "active",
        subscription_credits: "10",
        payg_credits: "5",
        refund_debt_credits: "0",
        subscription_credits_expires_at: T0,
      },
    ]);
    const trace = await readTraceContext(IDS.org, ADMIN, stub.client);
    expect(trace?.organization?.paygCredits).toBe(5n);
    expect(trace?.admission).toBeNull();
    expect(trace?.ledger).toEqual([]);
    // 2 statements: anchor + org. An org has no own-row of its own to add.
    expect(stub.queries).toHaveLength(2);
  });
});

describe("readTraceContext partial media row", () => {
  it("reads a job whose 0081 nullable columns are NULL without failing the chain", async () => {
    const stub = createSqlStub();
    stub.returnRows([
      {
        anchor_kind: "media_task_id",
        billing_request_id: null,
        org_id: IDS.org,
        task_id: IDS.task,
        attempt_id: null,
        ledger_request_id: null,
      },
    ]);
    stub.returnRows([
      {
        id: IDS.org,
        slug: "acme",
        name: "Acme",
        status: "active",
        subscription_credits: "500000",
        payg_credits: "0",
        refund_debt_credits: "0",
        subscription_credits_expires_at: null,
      },
    ]);
    stub.returnRows([
      {
        id: IDS.job,
        task_id: IDS.task,
        billing_request_id: null,
        route_kind: null,
        status: "queued",
        model_slug: "whisper-large-v3",
        upstream_id: "groq",
        provider_family: null,
        provider_task_id: null,
        // Never quoted: all three 0081 columns are NULL.
        quoted_retail_microcredits: null,
        quoted_supplier_microcredits: null,
        deadline_at: null,
        settled_at: null,
        error_message: null,
      },
    ]);

    const trace = await readTraceContext(IDS.task, ADMIN, stub.client);
    expect(trace?.mediaJob?.quotedRetailMicrocredits).toBeNull();
    expect(trace?.mediaJob?.quotedSupplierMicrocredits).toBeNull();
    expect(trace?.mediaJob?.deadlineAt).toBeNull();
  });
});

describe("readTraceContext indexed predicates", () => {
  it("splits the ledger read so the indexable half is not OR-ed with the metadata scan", async () => {
    const stub = createSqlStub();
    queueFullTrace(stub);
    await readTraceContext(IDS.billing, ADMIN, stub.client);
    // Exclude the anchor UNION, which also touches gateway_transactions.
    const ledgerQueries = stub.queries.filter(
      (q) =>
        q.text.includes("FROM gateway_transactions") &&
        !q.text.includes("anchor_kind"),
    );
    expect(ledgerQueries).toHaveLength(2);
    const [byRequestId, byMetadata] = ledgerQueries;
    expect(byRequestId?.text).toContain("$1::varchar");
    expect(byRequestId?.text).not.toContain("metadata->>");
    expect(byRequestId?.values).toEqual([
      `gw:${IDS.billing}`,
      `author-refund:${IDS.billing}`,
    ]);
    // The scan stays isolated in its own statement and says so.
    expect(byMetadata?.text).toContain("metadata->>'billingRequestId'");
    expect(byMetadata?.text).not.toContain("gw:");
  });

  it("filters the audit log by resource_type so the composite index applies", async () => {
    const stub = createSqlStub();
    queueFullTrace(stub);
    await readTraceContext(IDS.billing, ADMIN, stub.client);
    const audit = stub.queries.find((q) => q.text.includes("FROM audit_log"));
    expect(audit?.text).toContain("resource_type = 'gateway_request'");
    expect(audit?.text).toContain("resource_id = $1::varchar");
  });

  it("merges a ledger row matched by both the request_id and metadata halves", async () => {
    const stub = createSqlStub();
    queueFullTrace(stub, {
      ledger: [ledgerRow()],
      ledgerMetadata: [ledgerRow()],
    });
    const trace = await readTraceContext(IDS.billing, ADMIN, stub.client);
    // One row in the money ledger, not two.
    expect(trace?.ledger).toHaveLength(1);
    expect(trace?.ledger[0]?.id).toBe(IDS.ledgerEntry);
    expect(trace?.reconciliation.status).toBe("balanced");
  });

  it("keeps a row found only by metadata", async () => {
    const stub = createSqlStub();
    queueFullTrace(stub, {
      ledger: [],
      ledgerMetadata: [ledgerRow({ request_id: null, delta: "-900" })],
    });
    const trace = await readTraceContext(IDS.billing, ADMIN, stub.client);
    expect(trace?.ledger).toHaveLength(1);
    expect(trace?.reconciliation.status).toBe("balanced");
  });
});
