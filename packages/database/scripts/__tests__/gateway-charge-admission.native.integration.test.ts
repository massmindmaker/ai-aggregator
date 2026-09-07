import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createPgTestClient } from "../pg-test-client";
import {
  assertTestDatabaseEnvironment,
  withGuardedTestDatabase,
  type TestDatabaseClient,
} from "../test-db-guard";

const RUN_INTEGRATION = process.env.RUN_NATIVE_DB_INTEGRATION === "1";

if (RUN_INTEGRATION) {
  assertTestDatabaseEnvironment(process.env);
}

interface Fixture {
  userId: string;
  orgId: string;
  apiKeyId: string;
}

interface AdmissionRow {
  billing_request_id: string;
  org_id: string;
  api_key_id: string;
  client_request_id: string | null;
  route_kind: string;
  billing_mode: string;
  model_slug: string;
  authorized_max_credits: string;
  held_subscription_credits: string;
  held_payg_credits: string;
  actual_cost_credits: string | null;
  state: string;
  pre_dispatch_deadline_at: Date | string;
  dispatched_at: Date | string | null;
  did_transition: boolean;
  released_subscription_credits: string;
  released_payg_credits: string;
  debt_repaid_credits: string;
  expired_subscription_credits: string;
}

type RefundModule =
  typeof import("../../../../apps/web/src/lib/payments/topup-refund");

describe.skipIf(!RUN_INTEGRATION)("native gateway charge admission", () => {
  let client: TestDatabaseClient;
  let closeClient: () => Promise<void>;
  let refunds: RefundModule;
  const fixtures: Fixture[] = [];

  async function openGuardedClient() {
    let guarded!: TestDatabaseClient;
    let close!: () => Promise<void>;
    await withGuardedTestDatabase(
      process.env,
      { clientFactory: createPgTestClient },
      async (connected) => {
        guarded = connected;
        const originalEnd = connected.end.bind(connected);
        connected.end = async () => undefined;
        close = originalEnd;
      },
    );
    return { client: guarded, close };
  }

  async function createFixture(options?: {
    subscriptionCredits?: bigint;
    paygCredits?: bigint;
    refundDebtCredits?: bigint;
    subscriptionExpiresAt?: Date | null;
  }): Promise<Fixture> {
    const fixture = {
      userId: randomUUID(),
      orgId: randomUUID(),
      apiKeyId: randomUUID(),
    };
    fixtures.push(fixture);
    await client.query({
      text: "INSERT INTO users (id, email) VALUES ($1, $2)",
      values: [fixture.userId, `admission-${fixture.userId}@example.test`],
    });
    await client.query({
      text: `
        INSERT INTO organizations (
          id, slug, name, owner_id, subscription_credits, payg_credits,
          refund_debt_credits, subscription_credits_expires_at
        ) VALUES ($1, $2, 'Admission fixture', $3, $4, $5, $6, $7)
      `,
      values: [
        fixture.orgId,
        `admission-${fixture.orgId}`,
        fixture.userId,
        (options?.subscriptionCredits ?? 0n).toString(),
        (options?.paygCredits ?? 0n).toString(),
        (options?.refundDebtCredits ?? 0n).toString(),
        options?.subscriptionExpiresAt ?? null,
      ],
    });
    await client.query({
      text: `
        INSERT INTO gateway_api_keys (id, org_id, name, key_hash, key_prefix)
        VALUES ($1, $2, 'Admission key', $3, $4)
      `,
      values: [
        fixture.apiKeyId,
        fixture.orgId,
        randomUUID().replaceAll("-", ""),
        `ak-${randomUUID().slice(0, 12)}`,
      ],
    });
    return fixture;
  }

  async function createRefundableTopup(
    fixture: Fixture,
    options: { paidKopecks: number; grantCredits: number },
  ) {
    const paymentId = randomUUID();
    const providerPaymentId = `provider-${randomUUID()}`;
    const providerOrderId = `order-${randomUUID()}`;
    await client.query({
      text: `
        INSERT INTO payments (
          id, user_id, amount, status, tinkoff_payment_id, tinkoff_order_id,
          metadata, topup_org_id, topup_paid_kopecks, topup_grant_credits
        ) VALUES (
          $1, $2, $3, 'confirmed', $4, $5,
          $6::jsonb, $7, $8, $9
        )
      `,
      values: [
        paymentId,
        fixture.userId,
        (options.paidKopecks / 100).toFixed(2),
        providerPaymentId,
        providerOrderId,
        JSON.stringify({ kind: "topup", provider: "tinkoff" }),
        fixture.orgId,
        options.paidKopecks,
        options.grantCredits,
      ],
    });
    return { paymentId, providerPaymentId, providerOrderId };
  }

  function admit(
    fixture: Fixture,
    options?: {
      billingRequestId?: string;
      apiKeyId?: string;
      clientRequestId?: string | null;
      billingMode?: "stored" | "byok_fee";
      max?: bigint;
      quote?: unknown;
      deadline?: Date;
    },
    queryClient: TestDatabaseClient = client,
  ) {
    const billingRequestId = options?.billingRequestId ?? randomUUID();
    return queryClient.query<AdmissionRow>({
      text: `
        SELECT * FROM aiag_admit_gateway_charge(
          $1::uuid, $2::uuid, $3::uuid, $4::varchar, $5::varchar,
          $6::varchar, $7::varchar, $8::bigint, $9::jsonb, $10::timestamptz
        )
      `,
      values: [
        fixture.orgId,
        billingRequestId,
        options?.apiKeyId ?? fixture.apiKeyId,
        options?.clientRequestId ?? "client-trace",
        "chat",
        options?.billingMode ?? "stored",
        "openai/gpt-test",
        (options?.max ?? 30n).toString(),
        JSON.stringify(
          options && "quote" in options
            ? options.quote
            : { maximum: "30", unit: "micro-credit" },
        ),
        options?.deadline ?? new Date(Date.now() + 60_000),
      ],
    });
  }

  function dispatch(
    fixture: Fixture,
    billingRequestId: string,
    options?: { attemptId?: string; upstreamId?: string; pricing?: unknown },
  ) {
    return client.query<AdmissionRow>({
      text: `
        SELECT * FROM aiag_mark_gateway_charge_dispatched(
          $1::uuid, $2::uuid, $3::uuid, $4::varchar, $5::jsonb
        )
      `,
      values: [
        fixture.orgId,
        billingRequestId,
        options?.attemptId ?? randomUUID(),
        options?.upstreamId ?? "test-upstream",
        JSON.stringify(
          options && "pricing" in options
            ? options.pricing
            : { input: "1", output: "2" },
        ),
      ],
    });
  }

  function recordOutcome(
    fixture: Fixture,
    billingRequestId: string,
    actual: bigint,
    usage: unknown = { input_tokens: 1, output_tokens: 1 },
    kind = "success",
  ) {
    return client.query<AdmissionRow>({
      text: `
        SELECT * FROM aiag_record_gateway_charge_outcome(
          $1::uuid, $2::uuid, $3::bigint, $4::jsonb, $5::varchar
        )
      `,
      values: [
        fixture.orgId,
        billingRequestId,
        actual.toString(),
        JSON.stringify(usage),
        kind,
      ],
    });
  }

  function settle(fixture: Fixture, billingRequestId: string) {
    return client.query<AdmissionRow>({
      text: `SELECT * FROM aiag_settle_admitted_gateway_charge($1::uuid, $2::uuid)`,
      values: [fixture.orgId, billingRequestId],
    });
  }

  function cancel(fixture: Fixture, billingRequestId: string) {
    return client.query<AdmissionRow>({
      text: `SELECT * FROM aiag_cancel_undispatched_gateway_charge($1::uuid, $2::uuid)`,
      values: [fixture.orgId, billingRequestId],
    });
  }

  async function balances(fixture: Fixture) {
    const result = await client.query<{
      subscription_credits: string;
      payg_credits: string;
      refund_debt_credits: string;
    }>({
      text: `
        SELECT subscription_credits, payg_credits, refund_debt_credits
        FROM organizations WHERE id = $1
      `,
      values: [fixture.orgId],
    });
    return result.rows[0];
  }

  async function expectSqlState(operation: Promise<unknown>, sqlState: string) {
    await expect(operation).rejects.toMatchObject({ code: sqlState });
  }

  async function finalizeFullRefund(
    payment: Awaited<ReturnType<typeof createRefundableTopup>>,
  ) {
    const claim = await refunds.claimTopupRefund(payment.paymentId, 1, {
      paymentId: payment.providerPaymentId,
      orderId: payment.providerOrderId,
      route: "ACQ",
      source: "cards",
      receiptMode: "trusted_no_receipt_required",
    });
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") throw new Error("refund claim setup failed");
    const dispatched = await refunds.markTopupRefundDispatched(
      claim.claim.claimId,
    );
    expect(dispatched.kind).toBe("marked");
    return refunds.finalizeTopupRefundProof(claim.claim.claimId, {
      paymentId: payment.providerPaymentId,
      orderId: payment.providerOrderId,
      externalRequestId: claim.claim.providerKey,
      status: "REFUNDED",
      originalAmountKopecks: 1,
      newAmountKopecks: 0,
    });
  }

  async function waitForBlockedQuery(
    observer: TestDatabaseClient,
    blockerPid: number,
    marker: string,
    expectedCount = 1,
  ) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await observer.query<{ blocked_count: string }>({
        text: `
          SELECT COUNT(*)::text AS blocked_count
          FROM pg_stat_activity
          WHERE wait_event_type = 'Lock'
            AND $1::int = ANY(pg_blocking_pids(pid))
            AND query LIKE $2
        `,
        values: [blockerPid, `%${marker}%`],
      });
      if (Number(result.rows[0]?.blocked_count ?? 0) >= expectedCount) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`query did not reach database lock barrier: ${marker}`);
  }

  async function waitForLockedQuery(
    observer: TestDatabaseClient,
    marker: string,
  ) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await observer.query<{ blocked_count: string }>({
        text: `
          SELECT COUNT(*)::text AS blocked_count
          FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query LIKE $1
        `,
        values: [`%${marker}%`],
      });
      if (Number(result.rows[0]?.blocked_count ?? 0) >= 1) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`query did not reach database lock barrier: ${marker}`);
  }

  beforeAll(async () => {
    const opened = await openGuardedClient();
    client = opened.client;
    closeClient = opened.close;

    // Production DB code is imported only after the exact connection passed
    // dual-URL, loopback, connected-database and marker/readback guards.
    refunds =
      await import("../../../../apps/web/src/lib/payments/topup-refund");
  });

  afterEach(async () => {
    const orgIds = fixtures.splice(0).map(({ orgId }) => orgId);
    if (orgIds.length === 0) return;
    await client.query({
      text: "DELETE FROM gateway_transactions WHERE org_id = ANY($1::uuid[])",
      values: [orgIds],
    });
    await client.query({
      text: "DELETE FROM payments WHERE topup_org_id = ANY($1::uuid[])",
      values: [orgIds],
    });
    await client.query({
      text: "DELETE FROM gateway_charge_admissions WHERE org_id = ANY($1::uuid[])",
      values: [orgIds],
    });
    const users = await client.query<{ owner_id: string }>({
      text: "DELETE FROM organizations WHERE id = ANY($1::uuid[]) RETURNING owner_id",
      values: [orgIds],
    });
    await client.query({
      text: "DELETE FROM users WHERE id = ANY($1::uuid[])",
      values: [users.rows.map(({ owner_id }) => owner_id)],
    });
  });

  afterAll(async () => {
    await closeClient?.();
  });

  it("holds real buckets atomically and caps concurrent admissions", async () => {
    const fixture = await createFixture({ paygCredits: 100n });
    const firstId = randomUUID();
    const secondId = randomUUID();
    const [first, second] = await Promise.allSettled([
      admit(fixture, { billingRequestId: firstId, max: 70n }),
      admit(fixture, { billingRequestId: secondId, max: 70n }),
    ]);
    expect([first.status, second.status].sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const held = await client.query<{ open_hold_total: string }>({
      text: `
        SELECT COALESCE(SUM(held_subscription_credits + held_payg_credits), 0)::text
          AS open_hold_total
        FROM gateway_charge_admissions
        WHERE org_id = $1 AND state = 'held'
      `,
      values: [fixture.orgId],
    });
    expect(BigInt(held.rows[0].open_hold_total)).toBeLessThanOrEqual(100n);
    expect(await balances(fixture)).toMatchObject({ payg_credits: "30" });
  });

  it("returns exact replay identity and rejects conflicting identity without mutation", async () => {
    const fixture = await createFixture({
      subscriptionCredits: 20n,
      paygCredits: 20n,
    });
    const other = await createFixture({ paygCredits: 100n });
    const billingRequestId = randomUUID();
    const deadline = new Date(Date.now() + 60_000);
    const first = await admit(fixture, { billingRequestId, deadline });
    const replay = await admit(fixture, { billingRequestId, deadline });
    expect(replay.rows[0]).toEqual({ ...first.rows[0], did_transition: false });

    await expectSqlState(
      admit(fixture, { billingRequestId, max: 31n, deadline }),
      "P0005",
    );
    await expectSqlState(
      admit(fixture, { billingRequestId, apiKeyId: other.apiKeyId, deadline }),
      "P0005",
    );
    await expectSqlState(
      admit(fixture, { billingRequestId, billingMode: "byok_fee", deadline }),
      "P0005",
    );
    await expectSqlState(
      admit(fixture, {
        billingRequestId,
        quote: { maximum: "different" },
        deadline,
      }),
      "P0005",
    );
    await expectSqlState(
      admit(other, { billingRequestId, apiKeyId: other.apiKeyId, deadline }),
      "P0005",
    );
    expect(await balances(fixture)).toMatchObject({
      subscription_credits: "0",
      payg_credits: "10",
    });
  });

  it("rejects wrong key ownership, invalid amounts, modes and JSON snapshots", async () => {
    const fixture = await createFixture({ paygCredits: 100n });
    const other = await createFixture({ paygCredits: 100n });
    await expectSqlState(admit(fixture, { apiKeyId: other.apiKeyId }), "P0005");
    await expectSqlState(admit(fixture, { max: 0n }), "P0001");
    await expectSqlState(
      client.query({
        text: `
          SELECT * FROM aiag_admit_gateway_charge(
            $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10
          )
        `,
        values: [
          fixture.orgId,
          randomUUID(),
          fixture.apiKeyId,
          "trace",
          "chat",
          "invalid",
          "model",
          "10",
          JSON.stringify([]),
          new Date(Date.now() + 60_000),
        ],
      }),
      "P0001",
    );
    await expectSqlState(admit(fixture, { quote: null }), "P0001");
    const billingRequestId = randomUUID();
    await admit(fixture, { billingRequestId, max: 10n });
    await expectSqlState(
      dispatch(fixture, billingRequestId, { pricing: null }),
      "P0001",
    );
    await expectSqlState(
      dispatch(fixture, billingRequestId, { pricing: [] }),
      "P0001",
    );
    await dispatch(fixture, billingRequestId);
    await expectSqlState(
      recordOutcome(fixture, billingRequestId, 1n, null),
      "P0001",
    );
    await expectSqlState(
      recordOutcome(fixture, billingRequestId, 1n, []),
      "P0001",
    );
    expect(await balances(fixture)).toMatchObject({ payg_credits: "90" });
  });

  it("blocks stored admission behind refund state but permits funded BYOK fee", async () => {
    const fixture = await createFixture({
      paygCredits: 100n,
      refundDebtCredits: 1n,
    });
    await expectSqlState(admit(fixture), "P0005");
    const byok = await admit(fixture, { billingMode: "byok_fee", max: 10n });
    expect(byok.rows[0]).toMatchObject({
      billing_mode: "byok_fee",
      held_payg_credits: "10",
    });
    expect(await balances(fixture)).toMatchObject({ payg_credits: "90" });
  });

  it("serializes a real refund claim before admission on the organization lock", async () => {
    const fixture = await createFixture({ paygCredits: 100n });
    const payment = await createRefundableTopup(fixture, {
      paidKopecks: 1,
      grantCredits: 100,
    });
    const blocker = await openGuardedClient();
    const observer = await openGuardedClient();
    await blocker.client.query({ text: "BEGIN", values: [] });
    try {
      const pid = await blocker.client.query<{ pid: number }>({
        text: "SELECT pg_backend_pid() AS pid",
        values: [],
      });
      await blocker.client.query({
        text: "SELECT id FROM organizations WHERE id = $1 FOR UPDATE",
        values: [fixture.orgId],
      });
      const claimPromise = refunds.claimTopupRefund(payment.paymentId, 1, {
        paymentId: payment.providerPaymentId,
        orderId: payment.providerOrderId,
        route: "ACQ",
        source: "cards",
        receiptMode: "trusted_no_receipt_required",
      });
      await waitForBlockedQuery(
        observer.client,
        pid.rows[0].pid,
        "topup_refund_claim_org_lock",
      );
      const admitPromise = admit(fixture, { max: 30n });
      await waitForLockedQuery(observer.client, "aiag_admit_gateway_charge");
      await blocker.client.query({ text: "COMMIT", values: [] });
      expect((await claimPromise).kind).toBe("claimed");
      await expectSqlState(admitPromise, "P0005");
      expect(await balances(fixture)).toMatchObject({ payg_credits: "100" });
    } finally {
      await blocker.client
        .query({ text: "ROLLBACK", values: [] })
        .catch(() => undefined);
      await blocker.close();
      await observer.close();
    }
  }, 15_000);

  it("serializes admission before a real refund claim and preserves cancellation arithmetic", async () => {
    const fixture = await createFixture({ paygCredits: 100n });
    const payment = await createRefundableTopup(fixture, {
      paidKopecks: 1,
      grantCredits: 100,
    });
    const blocker = await openGuardedClient();
    const observer = await openGuardedClient();
    await blocker.client.query({ text: "BEGIN", values: [] });
    try {
      const pid = await blocker.client.query<{ pid: number }>({
        text: "SELECT pg_backend_pid() AS pid",
        values: [],
      });
      await blocker.client.query({
        text: "SELECT id FROM organizations WHERE id = $1 FOR UPDATE",
        values: [fixture.orgId],
      });
      const billingRequestId = randomUUID();
      const admitPromise = admit(fixture, { billingRequestId, max: 30n });
      await waitForBlockedQuery(
        observer.client,
        pid.rows[0].pid,
        "aiag_admit_gateway_charge",
      );
      const claimPromise = refunds.claimTopupRefund(payment.paymentId, 1, {
        paymentId: payment.providerPaymentId,
        orderId: payment.providerOrderId,
        route: "ACQ",
        source: "cards",
        receiptMode: "trusted_no_receipt_required",
      });
      await waitForLockedQuery(observer.client, "topup_refund_claim_org_lock");
      await blocker.client.query({ text: "COMMIT", values: [] });
      expect((await admitPromise).rows[0]).toMatchObject({ state: "held" });
      const claim = await claimPromise;
      expect(claim.kind).toBe("claimed");
      if (claim.kind !== "claimed")
        throw new Error("refund claim setup failed");
      await refunds.markTopupRefundDispatched(claim.claim.claimId);
      await refunds.finalizeTopupRefundProof(claim.claim.claimId, {
        paymentId: payment.providerPaymentId,
        orderId: payment.providerOrderId,
        externalRequestId: claim.claim.providerKey,
        status: "REFUNDED",
        originalAmountKopecks: 1,
        newAmountKopecks: 0,
      });
      expect(await balances(fixture)).toMatchObject({
        payg_credits: "0",
        refund_debt_credits: "30",
      });
      await cancel(fixture, billingRequestId);
      expect(await balances(fixture)).toMatchObject({
        payg_credits: "0",
        refund_debt_credits: "0",
      });
    } finally {
      await blocker.client
        .query({ text: "ROLLBACK", values: [] })
        .catch(() => undefined);
      await blocker.close();
      await observer.close();
    }
  }, 15_000);

  it("settles held subscription then PAYG exactly once and exposes dispatch CAS", async () => {
    const fixture = await createFixture({
      subscriptionCredits: 20n,
      paygCredits: 20n,
    });
    const billingRequestId = randomUUID();
    await admit(fixture, { billingRequestId, max: 30n });
    const attemptId = randomUUID();
    const firstDispatch = await dispatch(fixture, billingRequestId, {
      attemptId,
    });
    expect(firstDispatch.rows[0]).toMatchObject({
      state: "dispatched",
      did_transition: true,
    });
    const replayDispatch = await dispatch(fixture, billingRequestId, {
      attemptId,
    });
    expect(replayDispatch.rows[0]).toMatchObject({
      state: "dispatched",
      did_transition: false,
    });
    await expectSqlState(
      dispatch(fixture, billingRequestId, { attemptId: randomUUID() }),
      "P0005",
    );

    const outcome = await recordOutcome(fixture, billingRequestId, 25n);
    expect(outcome.rows[0]).toMatchObject({
      state: "outcome_recorded",
      actual_cost_credits: "25",
      did_transition: true,
    });
    const firstSettlement = await settle(fixture, billingRequestId);
    const duplicateSettlement = await settle(fixture, billingRequestId);
    expect(firstSettlement.rows[0]).toMatchObject({
      state: "settled",
      released_payg_credits: "5",
      did_transition: true,
    });
    expect(duplicateSettlement.rows[0]).toEqual({
      ...firstSettlement.rows[0],
      did_transition: false,
    });
    const receipts = await client.query<{ source: string; delta: string }>({
      text: `
        SELECT source, delta FROM gateway_transactions
        WHERE org_id = $1 AND request_id = $2 AND type = 'api_usage'
        ORDER BY source
      `,
      values: [fixture.orgId, `gw:${billingRequestId}`],
    });
    expect(receipts.rows).toEqual([
      { source: "payg", delta: "-5" },
      { source: "subscription", delta: "-20" },
    ]);
    expect(await balances(fixture)).toMatchObject({ payg_credits: "15" });
  });

  it("never records a successful dispatch timestamp at or after its deadline", async () => {
    const fixture = await createFixture({ paygCredits: 10n });
    const billingRequestId = randomUUID();
    const deadline = new Date(Date.now() + 500);
    await admit(fixture, { billingRequestId, max: 10n, deadline });
    await client.query({
      text: `
        CREATE FUNCTION aiag_test_delay_dispatch_statement()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_sleep(1);
          RETURN NULL;
        END;
        $$;
        CREATE TRIGGER aiag_test_delay_dispatch_statement
        BEFORE UPDATE ON gateway_charge_admissions
        FOR EACH STATEMENT EXECUTE FUNCTION aiag_test_delay_dispatch_statement()
      `,
      values: [],
    });
    try {
      const result = await dispatch(fixture, billingRequestId);
      expect(result.rows[0]).toMatchObject({
        state: "dispatched",
        did_transition: true,
      });
      expect(result.rows[0].dispatched_at).not.toBeNull();
      const dispatchedAt =
        result.rows[0].dispatched_at instanceof Date
          ? result.rows[0].dispatched_at
          : new Date(result.rows[0].dispatched_at!);
      const storedDeadline =
        result.rows[0].pre_dispatch_deadline_at instanceof Date
          ? result.rows[0].pre_dispatch_deadline_at
          : new Date(result.rows[0].pre_dispatch_deadline_at);
      expect(dispatchedAt.getTime()).toBeLessThan(storedDeadline.getTime());
      await expectSqlState(
        client.query({
          text: `
            UPDATE gateway_charge_admissions
            SET dispatched_at = pre_dispatch_deadline_at
            WHERE billing_request_id = $1
          `,
          values: [billingRequestId],
        }),
        "23514",
      );
    } finally {
      await client.query({
        text: `
          DROP TRIGGER IF EXISTS aiag_test_delay_dispatch_statement
            ON gateway_charge_admissions;
          DROP FUNCTION IF EXISTS aiag_test_delay_dispatch_statement()
        `,
        values: [],
      });
    }
  });

  it("accepts immutable zero outcome and exact lifecycle replays after terminal state", async () => {
    const fixture = await createFixture({ paygCredits: 10n });
    const billingRequestId = randomUUID();
    const attemptId = randomUUID();
    const deadline = new Date(Date.now() + 60_000);
    await admit(fixture, { billingRequestId, max: 10n, deadline });
    await dispatch(fixture, billingRequestId, { attemptId });
    const firstOutcome = await recordOutcome(fixture, billingRequestId, 0n, {
      verified_zero: true,
    });
    await settle(fixture, billingRequestId);
    const replayOutcome = await recordOutcome(fixture, billingRequestId, 0n, {
      verified_zero: true,
    });
    expect(replayOutcome.rows[0]).toMatchObject({
      state: "settled",
      released_payg_credits: "10",
      did_transition: false,
    });
    await client.query({
      text: "UPDATE organizations SET refund_debt_credits = 1 WHERE id = $1",
      values: [fixture.orgId],
    });
    await client.query({
      text: "DELETE FROM gateway_api_keys WHERE id = $1",
      values: [fixture.apiKeyId],
    });
    const terminalDispatchReplay = await dispatch(fixture, billingRequestId, {
      attemptId,
    });
    expect(terminalDispatchReplay.rows[0]).toMatchObject({
      state: "settled",
      did_transition: false,
    });
    const replayAdmission = await admit(fixture, {
      billingRequestId,
      max: 10n,
      deadline,
    });
    expect(replayAdmission.rows[0]).toMatchObject({
      state: "settled",
      did_transition: false,
    });
    const usage = await client.query<{ count: string }>({
      text: `
        SELECT COUNT(*)::text AS count FROM gateway_transactions
        WHERE request_id = $1 AND type = 'api_usage'
      `,
      values: [`gw:${billingRequestId}`],
    });
    expect(usage.rows[0].count).toBe("0");
  });

  it("rejects a zero-cost network error because it is not verified no-charge evidence", async () => {
    const fixture = await createFixture({ paygCredits: 10n });
    const billingRequestId = randomUUID();
    await admit(fixture, { billingRequestId, max: 10n });
    await dispatch(fixture, billingRequestId);
    await expectSqlState(
      recordOutcome(
        fixture,
        billingRequestId,
        0n,
        { error: "timeout" },
        "network_error",
      ),
      "P0001",
    );
    const state = await client.query<{
      state: string;
      actual_cost_credits: string | null;
    }>({
      text: `
        SELECT state, actual_cost_credits FROM gateway_charge_admissions
        WHERE billing_request_id = $1
      `,
      values: [billingRequestId],
    });
    expect(state.rows[0]).toEqual({
      state: "dispatched",
      actual_cost_credits: null,
    });
  });

  it("rolls back over-max outcomes and refuses deadline expiry or post-dispatch cancellation", async () => {
    const fixture = await createFixture({ paygCredits: 30n });
    const billingRequestId = randomUUID();
    await admit(fixture, {
      billingRequestId,
      max: 30n,
      deadline: new Date(Date.now() + 100),
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    await expectSqlState(dispatch(fixture, billingRequestId), "P0005");
    const cancelled = await cancel(fixture, billingRequestId);
    expect(cancelled.rows[0]).toMatchObject({ state: "cancelled" });

    const secondId = randomUUID();
    await admit(fixture, { billingRequestId: secondId, max: 30n });
    await dispatch(fixture, secondId);
    await expectSqlState(recordOutcome(fixture, secondId, 31n), "P0001");
    await expectSqlState(cancel(fixture, secondId), "P0005");
    const stored = await client.query<{
      state: string;
      actual_cost_credits: string | null;
    }>({
      text: `
        SELECT state, actual_cost_credits FROM gateway_charge_admissions
        WHERE billing_request_id = $1
      `,
      values: [secondId],
    });
    expect(stored.rows[0]).toEqual({
      state: "dispatched",
      actual_cost_credits: null,
    });
  });

  it("repays refund debt from unused PAYG before restoring spendable PAYG", async () => {
    const fixture = await createFixture({ paygCredits: 100n });
    const billingRequestId = randomUUID();
    await admit(fixture, { billingRequestId, max: 30n });
    await dispatch(fixture, billingRequestId);
    await recordOutcome(fixture, billingRequestId, 20n);
    await client.query({
      text: "UPDATE organizations SET refund_debt_credits = 100 WHERE id = $1",
      values: [fixture.orgId],
    });
    const result = await settle(fixture, billingRequestId);
    expect(result.rows[0]).toMatchObject({
      released_payg_credits: "0",
      debt_repaid_credits: "10",
    });
    expect(await balances(fixture)).toEqual({
      subscription_credits: "0",
      payg_credits: "70",
      refund_debt_credits: "90",
    });
  });

  it("produces the same refund debt whether refund happens before or after settlement", async () => {
    const settleFirst = await createFixture({ paygCredits: 100n });
    const settleFirstPayment = await createRefundableTopup(settleFirst, {
      paidKopecks: 1,
      grantCredits: 100,
    });
    const settleFirstId = randomUUID();
    await admit(settleFirst, { billingRequestId: settleFirstId, max: 30n });
    await dispatch(settleFirst, settleFirstId);
    await recordOutcome(settleFirst, settleFirstId, 20n);
    await settle(settleFirst, settleFirstId);
    await finalizeFullRefund(settleFirstPayment);

    const refundFirst = await createFixture({ paygCredits: 100n });
    const refundFirstPayment = await createRefundableTopup(refundFirst, {
      paidKopecks: 1,
      grantCredits: 100,
    });
    const refundFirstId = randomUUID();
    await admit(refundFirst, { billingRequestId: refundFirstId, max: 30n });
    await dispatch(refundFirst, refundFirstId);
    await recordOutcome(refundFirst, refundFirstId, 20n);
    await finalizeFullRefund(refundFirstPayment);
    await settle(refundFirst, refundFirstId);

    expect(await balances(settleFirst)).toEqual(await balances(refundFirst));
    expect(await balances(settleFirst)).toMatchObject({
      payg_credits: "0",
      refund_debt_credits: "20",
    });
  });

  it("produces the same zero debt whether refund happens before or after cancellation", async () => {
    const cancelFirst = await createFixture({ paygCredits: 100n });
    const cancelFirstPayment = await createRefundableTopup(cancelFirst, {
      paidKopecks: 1,
      grantCredits: 100,
    });
    const cancelFirstId = randomUUID();
    await admit(cancelFirst, { billingRequestId: cancelFirstId, max: 30n });
    const firstCancellation = await cancel(cancelFirst, cancelFirstId);
    const replayCancellation = await cancel(cancelFirst, cancelFirstId);
    expect(replayCancellation.rows[0]).toEqual({
      ...firstCancellation.rows[0],
      did_transition: false,
    });
    await finalizeFullRefund(cancelFirstPayment);

    const refundFirst = await createFixture({ paygCredits: 100n });
    const refundFirstPayment = await createRefundableTopup(refundFirst, {
      paidKopecks: 1,
      grantCredits: 100,
    });
    const refundFirstId = randomUUID();
    await admit(refundFirst, { billingRequestId: refundFirstId, max: 30n });
    await finalizeFullRefund(refundFirstPayment);
    await cancel(refundFirst, refundFirstId);

    expect(await balances(cancelFirst)).toEqual(await balances(refundFirst));
    expect(await balances(cancelFirst)).toMatchObject({
      payg_credits: "0",
      refund_debt_credits: "0",
    });
  });

  it("restores captured subscription only while the exact entitlement remains valid", async () => {
    const expiry = new Date(Date.now() + 60_000);
    const valid = await createFixture({
      subscriptionCredits: 30n,
      subscriptionExpiresAt: expiry,
    });
    const validId = randomUUID();
    await admit(valid, { billingRequestId: validId, max: 30n });
    const validCancellation = await cancel(valid, validId);
    expect(validCancellation.rows[0]).toMatchObject({
      released_subscription_credits: "30",
      expired_subscription_credits: "0",
    });

    const changed = await createFixture({
      subscriptionCredits: 30n,
      subscriptionExpiresAt: expiry,
    });
    const changedId = randomUUID();
    await admit(changed, { billingRequestId: changedId, max: 30n });
    await client.query({
      text: `
        UPDATE organizations
        SET subscription_credits_expires_at = $2
        WHERE id = $1
      `,
      values: [changed.orgId, new Date(expiry.getTime() + 60_000)],
    });
    const changedCancellation = await cancel(changed, changedId);
    expect(changedCancellation.rows[0]).toMatchObject({
      released_subscription_credits: "0",
      expired_subscription_credits: "30",
    });

    const shortExpiry = new Date(Date.now() + 100);
    const expired = await createFixture({
      subscriptionCredits: 30n,
      subscriptionExpiresAt: shortExpiry,
    });
    const expiredId = randomUUID();
    await admit(expired, { billingRequestId: expiredId, max: 30n });
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    const expiredCancellation = await cancel(expired, expiredId);
    expect(expiredCancellation.rows[0]).toMatchObject({
      released_subscription_credits: "0",
      expired_subscription_credits: "30",
    });
  });

  it("rolls back every settlement mutation when append-only audit identity conflicts", async () => {
    const fixture = await createFixture({ paygCredits: 30n });
    const billingRequestId = randomUUID();
    await admit(fixture, { billingRequestId, max: 30n });
    await dispatch(fixture, billingRequestId);
    await recordOutcome(fixture, billingRequestId, 20n);
    await client.query({
      text: `
        INSERT INTO gateway_charge_admission_events (
          admission_id, org_id, event_key, event_kind, metadata
        ) VALUES ($1, $2, 'settlement', 'settlement', '{}'::jsonb)
      `,
      values: [billingRequestId, fixture.orgId],
    });
    await expectSqlState(settle(fixture, billingRequestId), "23505");
    expect(await balances(fixture)).toMatchObject({ payg_credits: "0" });
    const state = await client.query<{ state: string }>({
      text: "SELECT state FROM gateway_charge_admissions WHERE billing_request_id = $1",
      values: [billingRequestId],
    });
    expect(state.rows[0].state).toBe("outcome_recorded");
    const receipts = await client.query<{ count: string }>({
      text: `
        SELECT COUNT(*)::text AS count FROM gateway_transactions
        WHERE request_id = $1 AND type = 'api_usage'
      `,
      values: [`gw:${billingRequestId}`],
    });
    expect(receipts.rows[0].count).toBe("0");
  });

  it("keeps bigint schema values exact beyond Number.MAX_SAFE_INTEGER", async () => {
    const schema = await import("../../src/schema/gateway");
    const exact = 9_007_199_254_740_993n;
    expect(
      schema.gatewayChargeAdmissions.authorizedMaxCredits.mapFromDriverValue(
        exact.toString(),
      ),
    ).toBe(exact);
    expect(
      schema.gatewayChargeAdmissionEvents.heldPaygCredits.mapFromDriverValue(
        exact.toString(),
      ),
    ).toBe(exact);
  });
});
