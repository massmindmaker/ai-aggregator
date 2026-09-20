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

type RefundModule =
  typeof import("../../../../apps/web/src/lib/payments/topup-refund");
type ConfirmationModule =
  typeof import("../../../../apps/web/src/lib/payments/topup-confirmation");

interface Fixture {
  userId: string;
  orgId: string;
  paymentId: string;
  providerPaymentId: string;
  providerOrderId: string;
}

describe.skipIf(!RUN_INTEGRATION)("native top-up refund primitives", () => {
  let client: TestDatabaseClient;
  let closeClient: () => Promise<void>;
  let refunds: RefundModule;
  let confirmation: ConfirmationModule;
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
    paidKopecks?: number;
    grantCredits?: number;
    paygCredits?: number;
    subscriptionCredits?: number;
    refundedKopecks?: number;
    clawedCredits?: number;
  }): Promise<Fixture> {
    const paidKopecks = options?.paidKopecks ?? 99_000;
    const grantCredits = options?.grantCredits ?? 1_200_000;
    const fixture: Fixture = {
      userId: randomUUID(),
      orgId: randomUUID(),
      paymentId: randomUUID(),
      providerPaymentId: `provider-${randomUUID()}`,
      providerOrderId: `order-${randomUUID()}`,
    };
    fixtures.push(fixture);

    await client.query({
      text: `
        INSERT INTO users (id, email)
        VALUES ($1, $2)
      `,
      values: [fixture.userId, `refund-${fixture.userId}@example.test`],
    });
    await client.query({
      text: `
        INSERT INTO organizations (
          id, slug, name, owner_id, subscription_credits, payg_credits,
          refund_debt_credits
        ) VALUES ($1, $2, $3, $4, $5, $6, 0)
      `,
      values: [
        fixture.orgId,
        `refund-${fixture.orgId}`,
        "Refund fixture",
        fixture.userId,
        options?.subscriptionCredits ?? 0,
        options?.paygCredits ?? grantCredits,
      ],
    });
    await client.query({
      text: `
        INSERT INTO payments (
          id, user_id, amount, status, tinkoff_payment_id, tinkoff_order_id,
          metadata, topup_org_id, topup_paid_kopecks, topup_grant_credits,
          topup_refunded_kopecks, topup_clawed_credits
        ) VALUES (
          $1, $2, $3, 'confirmed', $4, $5,
          $6::jsonb, $7, $8, $9, $10, $11
        )
      `,
      values: [
        fixture.paymentId,
        fixture.userId,
        (paidKopecks / 100).toFixed(2),
        fixture.providerPaymentId,
        fixture.providerOrderId,
        JSON.stringify({ kind: "topup", provider: "tinkoff" }),
        fixture.orgId,
        paidKopecks,
        grantCredits,
        options?.refundedKopecks ?? 0,
        options?.clawedCredits ?? 0,
      ],
    });
    return fixture;
  }

  async function createPendingConfirmationFixture(options?: {
    paygCredits?: number;
    refundDebtCredits?: number;
  }): Promise<Fixture> {
    const fixture: Fixture = {
      userId: randomUUID(),
      orgId: randomUUID(),
      paymentId: randomUUID(),
      providerPaymentId: `provider-${randomUUID()}`,
      providerOrderId: `order-${randomUUID()}`,
    };
    fixtures.push(fixture);
    await client.query({
      text: "INSERT INTO users (id, email) VALUES ($1, $2)",
      values: [fixture.userId, `confirm-${fixture.userId}@example.test`],
    });
    await client.query({
      text: `
        INSERT INTO organizations (
          id, slug, name, owner_id, payg_credits, refund_debt_credits
        ) VALUES ($1, $2, 'Confirmation fixture', $3, $4, $5)
      `,
      values: [
        fixture.orgId,
        `confirm-${fixture.orgId}`,
        fixture.userId,
        options?.paygCredits ?? 0,
        options?.refundDebtCredits ?? 0,
      ],
    });
    await client.query({
      text: `
        INSERT INTO payments (
          id, user_id, amount, status, tinkoff_payment_id, tinkoff_order_id,
          currency, metadata
        ) VALUES ($1, $2, '990.00', 'pending', $3, $4, 'RUB', $5::jsonb)
      `,
      values: [
        fixture.paymentId,
        fixture.userId,
        fixture.providerPaymentId,
        fixture.providerOrderId,
        JSON.stringify({ kind: "topup", provider: "tinkoff" }),
      ],
    });
    return fixture;
  }

  function contextFor(
    fixture: Fixture,
    receiptMode: "full_no_receipt" | "trusted_no_receipt_required",
  ) {
    return {
      paymentId: fixture.providerPaymentId,
      orderId: fixture.providerOrderId,
      route: "ACQ" as const,
      source: "cards" as const,
      receiptMode,
    };
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
          WHERE wait_event_type = 'Lock'
            AND query LIKE $1
        `,
        values: [`%${marker}%`],
      });
      if (Number(result.rows[0]?.blocked_count ?? 0) >= 1) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`query did not reach lock wait: ${marker}`);
  }

  beforeAll(async () => {
    const opened = await openGuardedClient();
    client = opened.client;
    closeClient = opened.close;

    // Production DB modules are loaded only after this exact connection has
    // passed environment, identity and marker/readback guards.
    refunds =
      await import("../../../../apps/web/src/lib/payments/topup-refund");
    confirmation =
      await import("../../../../apps/web/src/lib/payments/topup-confirmation");
  });

  afterEach(async () => {
    const currentFixtures = fixtures.splice(0);
    const orgIds = currentFixtures.map(({ orgId }) => orgId);
    const paymentIds = currentFixtures.map(({ paymentId }) => paymentId);
    if (orgIds.length === 0) return;
    await client.query({
      text: "DELETE FROM gateway_transactions WHERE org_id = ANY($1::uuid[])",
      values: [orgIds],
    });
    await client.query({
      text: "DELETE FROM balance_transactions WHERE payment_id = ANY($1::uuid[])",
      values: [paymentIds],
    });
    await client.query({
      text: "DELETE FROM payments WHERE id = ANY($1::uuid[]) OR topup_org_id = ANY($2::uuid[])",
      values: [paymentIds, orgIds],
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

  it("atomically snapshots a confirmation, repays debt, grants the remainder and preserves the legacy deposit", async () => {
    const fixture = await createPendingConfirmationFixture({
      paygCredits: 100,
      refundDebtCredits: 200_000,
    });
    const input = {
      paymentId: fixture.paymentId,
      userId: fixture.userId,
      providerPaymentId: fixture.providerPaymentId,
      providerOrderId: fixture.providerOrderId,
      paidKopecks: 99_000,
      grantCredits: 1_200_000,
      tinkoffStatus: "CONFIRMED" as const,
    };

    const outcomes = await Promise.all([
      confirmation.confirmTinkoffTopup(input),
      confirmation.confirmTinkoffTopup(input),
    ]);
    expect(outcomes.map(({ kind }) => kind).sort()).toEqual([
      "confirmed",
      "duplicate",
    ]);

    const state = await client.query<{
      status: string;
      topup_org_id: string;
      topup_paid_kopecks: string;
      topup_grant_credits: string;
      payg_credits: string;
      refund_debt_credits: string;
      balance: string;
      deposits: string;
    }>({
      text: `
        SELECT p.status, p.topup_org_id, p.topup_paid_kopecks,
               p.topup_grant_credits, o.payg_credits,
               o.refund_debt_credits, u.balance,
               COUNT(bt.id)::text AS deposits
        FROM payments p
        JOIN organizations o ON o.id = p.topup_org_id
        JOIN users u ON u.id = p.user_id
        LEFT JOIN balance_transactions bt
          ON bt.payment_id = p.id AND bt.type = 'deposit'
        WHERE p.id = $1
        GROUP BY p.status, p.topup_org_id, p.topup_paid_kopecks,
                 p.topup_grant_credits, o.payg_credits,
                 o.refund_debt_credits, u.balance
      `,
      values: [fixture.paymentId],
    });
    expect(state.rows[0]).toEqual({
      status: "confirmed",
      topup_org_id: fixture.orgId,
      topup_paid_kopecks: "99000",
      topup_grant_credits: "1200000",
      payg_credits: "1000100",
      refund_debt_credits: "0",
      balance: "990.00",
      deposits: "1",
    });
  });

  it("rolls back status, snapshot, legacy balance and org money when the deposit insert fails", async () => {
    const fixture = await createPendingConfirmationFixture({
      paygCredits: 77,
      refundDebtCredits: 5,
    });
    await client.query({
      text: `
        INSERT INTO balance_transactions (
          user_id, payment_id, type, amount, balance_before, balance_after
        ) VALUES ($1, $2, 'deposit', 1, 0, 1)
      `,
      values: [fixture.userId, fixture.paymentId],
    });

    await expect(
      confirmation.confirmTinkoffTopup({
        paymentId: fixture.paymentId,
        userId: fixture.userId,
        providerPaymentId: fixture.providerPaymentId,
        providerOrderId: fixture.providerOrderId,
        paidKopecks: 99_000,
        grantCredits: 1_200_000,
        tinkoffStatus: "CONFIRMED",
      }),
    ).rejects.toMatchObject({ code: "23505" });

    const state = await client.query<{
      status: string;
      topup_org_id: string | null;
      topup_paid_kopecks: string | null;
      topup_grant_credits: string | null;
      payg_credits: string;
      refund_debt_credits: string;
      balance: string;
    }>({
      text: `
        SELECT p.status, p.topup_org_id, p.topup_paid_kopecks,
               p.topup_grant_credits, o.payg_credits,
               o.refund_debt_credits, u.balance
        FROM payments p
        JOIN organizations o ON o.id = $2
        JOIN users u ON u.id = p.user_id
        WHERE p.id = $1
      `,
      values: [fixture.paymentId, fixture.orgId],
    });
    expect(state.rows[0]).toEqual({
      status: "pending",
      topup_org_id: null,
      topup_paid_kopecks: null,
      topup_grant_credits: null,
      payg_credits: "77",
      refund_debt_credits: "5",
      balance: "0",
    });
  });

  it("acknowledges a duplicate from its immutable snapshot after the user's default org changes", async () => {
    const fixture = await createPendingConfirmationFixture();
    const input = {
      paymentId: fixture.paymentId,
      userId: fixture.userId,
      providerPaymentId: fixture.providerPaymentId,
      providerOrderId: fixture.providerOrderId,
      paidKopecks: 99_000,
      grantCredits: 1_200_000,
      tinkoffStatus: "CONFIRMED" as const,
    };
    await expect(
      confirmation.confirmTinkoffTopup(input),
    ).resolves.toMatchObject({
      kind: "confirmed",
      orgId: fixture.orgId,
    });

    const newDefaultOrgId = randomUUID();
    fixtures.push({ ...fixture, orgId: newDefaultOrgId });
    await client.query({
      text: `
        INSERT INTO organizations (id, slug, name, owner_id)
        VALUES ($1, $2, 'Changed default', $3)
      `,
      values: [newDefaultOrgId, `changed-${newDefaultOrgId}`, fixture.userId],
    });
    await client.query({
      text: `
        INSERT INTO organization_members (organization_id, user_id, role)
        VALUES ($1, $2, 'admin')
      `,
      values: [newDefaultOrgId, fixture.userId],
    });

    await expect(
      confirmation.confirmTinkoffTopup({
        ...input,
        // Simulate a later canonical Basic-rate change. Replay authority is
        // the immutable stored snapshot, not this newly derived value.
        grantCredits: 2_400_000,
      }),
    ).resolves.toEqual({ kind: "duplicate" });
    const state = await client.query<{
      topup_org_id: string;
      original_payg: string;
      new_default_payg: string;
      deposits: string;
    }>({
      text: `
        SELECT p.topup_org_id,
               original.payg_credits::text AS original_payg,
               changed.payg_credits::text AS new_default_payg,
               COUNT(bt.id)::text AS deposits
        FROM payments p
        JOIN organizations original ON original.id = p.topup_org_id
        JOIN organizations changed ON changed.id = $2
        LEFT JOIN balance_transactions bt
          ON bt.payment_id = p.id AND bt.type = 'deposit'
        WHERE p.id = $1
        GROUP BY p.topup_org_id, original.payg_credits, changed.payg_credits
      `,
      values: [fixture.paymentId, newDefaultOrgId],
    });
    expect(state.rows[0]).toEqual({
      topup_org_id: fixture.orgId,
      original_payg: "1200000",
      new_default_payg: "0",
      deposits: "1",
    });
  });

  it("persists a refund-before-confirmation marker that makes every later confirmation mint zero", async () => {
    const fixture = await createPendingConfirmationFixture({ paygCredits: 41 });
    await expect(
      confirmation.blockUnconfirmedTopupGrantForRefund({
        paymentId: fixture.paymentId,
        providerPaymentId: fixture.providerPaymentId,
        providerOrderId: fixture.providerOrderId,
      }),
    ).resolves.toEqual({ kind: "blocked" });

    await expect(
      confirmation.confirmTinkoffTopup({
        paymentId: fixture.paymentId,
        userId: fixture.userId,
        providerPaymentId: fixture.providerPaymentId,
        providerOrderId: fixture.providerOrderId,
        paidKopecks: 99_000,
        grantCredits: 1_200_000,
        tinkoffStatus: "CONFIRMED",
      }),
    ).resolves.toMatchObject({
      kind: "reconciliation_required",
      reason: "CAS_REJECTED",
    });

    const state = await client.query<{
      status: string;
      error_code: string;
      topup_org_id: string | null;
      topup_paid_kopecks: string | null;
      topup_grant_credits: string | null;
      balance: string;
      payg_credits: string;
      deposits: string;
    }>({
      text: `
        SELECT p.status, p.error_code, p.topup_org_id,
               p.topup_paid_kopecks, p.topup_grant_credits,
               u.balance, o.payg_credits,
               COUNT(bt.id)::text AS deposits
        FROM payments p
        JOIN users u ON u.id = p.user_id
        JOIN organizations o ON o.id = $2
        LEFT JOIN balance_transactions bt
          ON bt.payment_id = p.id AND bt.type = 'deposit'
        WHERE p.id = $1
        GROUP BY p.status, p.error_code, p.topup_org_id,
                 p.topup_paid_kopecks, p.topup_grant_credits,
                 u.balance, o.payg_credits
      `,
      values: [fixture.paymentId, fixture.orgId],
    });
    expect(state.rows[0]).toEqual({
      status: "pending",
      error_code: "TOPUP_REFUND_BEFORE_CONFIRMATION",
      topup_org_id: null,
      topup_paid_kopecks: null,
      topup_grant_credits: null,
      balance: "0",
      payg_credits: "41",
      deposits: "0",
    });
  });

  it("serializes marker-first race so a queued confirmation cannot grant", async () => {
    const fixture = await createPendingConfirmationFixture();
    const blocker = await openGuardedClient();
    let markerPromise:
      | ReturnType<typeof confirmation.blockUnconfirmedTopupGrantForRefund>
      | undefined;
    let confirmPromise:
      | ReturnType<typeof confirmation.confirmTinkoffTopup>
      | undefined;
    try {
      await blocker.client.query({ text: "BEGIN", values: [] });
      const pid = await blocker.client.query<{ pid: number }>({
        text: "SELECT pg_backend_pid() AS pid",
        values: [],
      });
      await blocker.client.query({
        text: "SELECT id FROM payments WHERE id = $1 FOR UPDATE",
        values: [fixture.paymentId],
      });

      markerPromise = confirmation.blockUnconfirmedTopupGrantForRefund({
        paymentId: fixture.paymentId,
        providerPaymentId: fixture.providerPaymentId,
        providerOrderId: fixture.providerOrderId,
      });
      await waitForBlockedQuery(
        client,
        pid.rows[0].pid,
        "topup_refund_before_confirmation_marker",
      );
      confirmPromise = confirmation.confirmTinkoffTopup({
        paymentId: fixture.paymentId,
        userId: fixture.userId,
        providerPaymentId: fixture.providerPaymentId,
        providerOrderId: fixture.providerOrderId,
        paidKopecks: 99_000,
        grantCredits: 1_200_000,
        tinkoffStatus: "CONFIRMED",
      });
      await waitForLockedQuery(client, "topup_confirmation_payment_gate");
      await blocker.client.query({ text: "COMMIT", values: [] });

      await expect(markerPromise).resolves.toEqual({ kind: "blocked" });
      await expect(confirmPromise).resolves.toMatchObject({
        kind: "reconciliation_required",
      });
      const state = await client.query<{
        status: string;
        error_code: string;
        topup_org_id: string | null;
        payg_credits: string;
      }>({
        text: `
          SELECT p.status, p.error_code, p.topup_org_id, o.payg_credits
          FROM payments p
          JOIN organizations o ON o.id = $2
          WHERE p.id = $1
        `,
        values: [fixture.paymentId, fixture.orgId],
      });
      expect(state.rows[0]).toEqual({
        status: "pending",
        error_code: "TOPUP_REFUND_BEFORE_CONFIRMATION",
        topup_org_id: null,
        payg_credits: "0",
      });
    } finally {
      await blocker.client
        .query({ text: "ROLLBACK", values: [] })
        .catch(() => undefined);
      if (markerPromise || confirmPromise) {
        await Promise.allSettled(
          [markerPromise, confirmPromise].filter(Boolean) as Promise<unknown>[],
        );
      }
      await blocker.close();
    }
  }, 30_000);

  it("serializes confirmation-first race, then reconciles only after releasing the payment lock", async () => {
    const fixture = await createPendingConfirmationFixture();
    const blocker = await openGuardedClient();
    let markerPromise:
      | ReturnType<typeof confirmation.blockUnconfirmedTopupGrantForRefund>
      | undefined;
    let confirmPromise:
      | ReturnType<typeof confirmation.confirmTinkoffTopup>
      | undefined;
    try {
      await blocker.client.query({ text: "BEGIN", values: [] });
      const pid = await blocker.client.query<{ pid: number }>({
        text: "SELECT pg_backend_pid() AS pid",
        values: [],
      });
      await blocker.client.query({
        text: "SELECT id FROM payments WHERE id = $1 FOR UPDATE",
        values: [fixture.paymentId],
      });

      confirmPromise = confirmation.confirmTinkoffTopup({
        paymentId: fixture.paymentId,
        userId: fixture.userId,
        providerPaymentId: fixture.providerPaymentId,
        providerOrderId: fixture.providerOrderId,
        paidKopecks: 99_000,
        grantCredits: 1_200_000,
        tinkoffStatus: "CONFIRMED",
      });
      await waitForBlockedQuery(
        client,
        pid.rows[0].pid,
        "topup_confirmation_payment_gate",
      );
      markerPromise = confirmation.blockUnconfirmedTopupGrantForRefund({
        paymentId: fixture.paymentId,
        providerPaymentId: fixture.providerPaymentId,
        providerOrderId: fixture.providerOrderId,
      });
      await waitForLockedQuery(
        client,
        "topup_refund_before_confirmation_marker",
      );
      await blocker.client.query({ text: "COMMIT", values: [] });

      await expect(confirmPromise).resolves.toMatchObject({
        kind: "confirmed",
      });
      await expect(markerPromise).resolves.toEqual({ kind: "snapshot_exists" });

      await expect(
        refunds.reconcileFullTopupRefund(fixture.paymentId, {
          provider: "tinkoff",
          providerPaymentId: fixture.providerPaymentId,
          providerOrderId: fixture.providerOrderId,
        }),
      ).resolves.toMatchObject({ kind: "settled", clawedCredits: 1_200_000 });
      const state = await client.query<{
        status: string;
        topup_paid_kopecks: string;
        topup_grant_credits: string;
        topup_refunded_kopecks: string;
        topup_clawed_credits: string;
        payg_credits: string;
        refund_debt_credits: string;
      }>({
        text: `
          SELECT p.status, p.topup_paid_kopecks, p.topup_grant_credits,
                 p.topup_refunded_kopecks, p.topup_clawed_credits,
                 o.payg_credits, o.refund_debt_credits
          FROM payments p
          JOIN organizations o ON o.id = p.topup_org_id
          WHERE p.id = $1
        `,
        values: [fixture.paymentId],
      });
      expect(state.rows[0]).toEqual({
        status: "refunded",
        topup_paid_kopecks: "99000",
        topup_grant_credits: "1200000",
        topup_refunded_kopecks: "99000",
        topup_clawed_credits: "1200000",
        payg_credits: "0",
        refund_debt_credits: "0",
      });
    } finally {
      await blocker.client
        .query({ text: "ROLLBACK", values: [] })
        .catch(() => undefined);
      if (markerPromise || confirmPromise) {
        await Promise.allSettled(
          [markerPromise, confirmPromise].filter(Boolean) as Promise<unknown>[],
        );
      }
      await blocker.close();
    }
  }, 30_000);

  it("creates one immutable org-locked claim and rejects a concurrent replacement", async () => {
    const fixture = await createFixture();
    const context = contextFor(fixture, "full_no_receipt");

    const first = await refunds.claimTopupRefund(
      fixture.paymentId,
      99_000,
      context,
    );
    expect(first).toMatchObject({
      kind: "claimed",
      claim: {
        paymentId: fixture.paymentId,
        providerPaymentId: fixture.providerPaymentId,
        providerOrderId: fixture.providerOrderId,
        requestedKopecks: 99_000,
        paidKopecks: 99_000,
        refundedKopecks: 0,
        route: "ACQ",
        source: "cards",
        receiptMode: "full_no_receipt",
      },
    });
    if (first.kind === "claimed") {
      expect(first.claim.claimedAt).toBeInstanceOf(Date);
    }

    const second = await refunds.claimTopupRefund(
      fixture.paymentId,
      99_000,
      context,
    );
    expect(second).toEqual({ kind: "rejected", code: "CLAIM_ACTIVE" });

    const stored = await client.query<{
      refund_claim_id: string;
      refund_provider_key: string;
      refund_claim_kopecks: string;
      refund_dispatched_at: Date | null;
    }>({
      text: `
        SELECT refund_claim_id, refund_provider_key, refund_claim_kopecks,
               refund_dispatched_at
        FROM payments
        WHERE id = $1
      `,
      values: [fixture.paymentId],
    });
    expect(stored.rows[0]).toMatchObject({
      refund_claim_id: first.kind === "claimed" ? first.claim.claimId : "",
      refund_provider_key:
        first.kind === "claimed" ? first.claim.providerKey : "",
      refund_claim_kopecks: "99000",
      refund_dispatched_at: null,
    });
  });

  it("releases only an undispatched claim and dispatches an active claim once", async () => {
    const fixture = await createFixture();
    const context = contextFor(fixture, "trusted_no_receipt_required");
    const first = await refunds.claimTopupRefund(
      fixture.paymentId,
      10_000,
      context,
    );
    expect(first.kind).toBe("claimed");
    if (first.kind !== "claimed") throw new Error("claim setup failed");

    await expect(
      refunds.releaseUndispatchedTopupRefundClaim(first.claim.claimId),
    ).resolves.toEqual({ kind: "released" });

    const second = await refunds.claimTopupRefund(
      fixture.paymentId,
      10_000,
      context,
    );
    expect(second.kind).toBe("claimed");
    if (second.kind !== "claimed") throw new Error("claim setup failed");

    const dispatched = await refunds.markTopupRefundDispatched(
      second.claim.claimId,
    );
    expect(dispatched).toMatchObject({
      kind: "marked",
      claim: {
        claimId: second.claim.claimId,
        providerKey: second.claim.providerKey,
        paymentId: fixture.paymentId,
        providerPaymentId: fixture.providerPaymentId,
        providerOrderId: fixture.providerOrderId,
        requestedKopecks: 10_000,
        route: "ACQ",
        source: "cards",
        receiptMode: "trusted_no_receipt_required",
      },
    });
    if (dispatched.kind === "marked") {
      expect(dispatched.claim.dispatchedAt).toBeInstanceOf(Date);
    }
    await expect(
      refunds.markTopupRefundDispatched(second.claim.claimId),
    ).resolves.toEqual({ kind: "unavailable" });
    await expect(
      refunds.releaseUndispatchedTopupRefundClaim(second.claim.claimId),
    ).resolves.toEqual({ kind: "not_released" });
    await expect(
      refunds.releaseProvenNoEffectTopupRefundClaim(
        second.claim.claimId,
        "Success=false",
      ),
    ).resolves.toEqual({ kind: "proof_not_allowed" });

    const stored = await client.query<{
      refund_claim_id: string;
      refund_dispatched_at: Date | null;
    }>({
      text: `
        SELECT refund_claim_id, refund_dispatched_at
        FROM payments
        WHERE id = $1
      `,
      values: [fixture.paymentId],
    });
    expect(stored.rows[0].refund_claim_id).toBe(second.claim.claimId);
    expect(stored.rows[0].refund_dispatched_at).not.toBeNull();
  });

  it("finalizes strict cumulative proof once and turns spent credits into debt", async () => {
    const fixture = await createFixture({
      paidKopecks: 3,
      grantCredits: 10,
      paygCredits: 2,
      subscriptionCredits: 1,
    });
    const claim = await refunds.claimTopupRefund(
      fixture.paymentId,
      1,
      contextFor(fixture, "trusted_no_receipt_required"),
    );
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") throw new Error("claim setup failed");
    await refunds.markTopupRefundDispatched(claim.claim.claimId);

    const proof = {
      paymentId: fixture.providerPaymentId,
      orderId: fixture.providerOrderId,
      externalRequestId: claim.claim.providerKey,
      status: "PARTIAL_REFUNDED" as const,
      originalAmountKopecks: 3,
      newAmountKopecks: 2,
    };
    await expect(
      refunds.finalizeTopupRefundProof(claim.claim.claimId, proof),
    ).resolves.toMatchObject({
      kind: "settled",
      refundedKopecks: 1,
      clawedCredits: 3,
      paygRemovedCredits: 2,
      debtAddedCredits: 1,
    });
    await expect(
      refunds.finalizeTopupRefundProof(claim.claim.claimId, proof),
    ).resolves.toEqual({ kind: "already_settled" });

    const state = await client.query<{
      status: string;
      topup_refunded_kopecks: string;
      topup_clawed_credits: string;
      refund_claim_id: string | null;
      payg_credits: string;
      refund_debt_credits: string;
    }>({
      text: `
        SELECT p.status, p.topup_refunded_kopecks, p.topup_clawed_credits,
               p.refund_claim_id, o.payg_credits, o.refund_debt_credits
        FROM payments p
        JOIN organizations o ON o.id = p.topup_org_id
        WHERE p.id = $1
      `,
      values: [fixture.paymentId],
    });
    expect(state.rows[0]).toMatchObject({
      status: "partial_refunded",
      topup_refunded_kopecks: "1",
      topup_clawed_credits: "3",
      refund_claim_id: null,
      payg_credits: "0",
      refund_debt_credits: "1",
    });

    let debtBlockedError: unknown;
    try {
      await client.query({
        text: "SELECT aiag_assert_refund_admission_allowed($1::uuid)",
        values: [fixture.orgId],
      });
    } catch (error) {
      debtBlockedError = error;
    }
    expect(debtBlockedError).toMatchObject({
      code: "P0005",
      message: "REFUND_BLOCKED",
    });

    const legacySettlement = await client.query<{
      sub_portion: string;
      idempotent: boolean;
    }>({
      text: "SELECT * FROM aiag_settle_charge_credits($1, $2, $3, $4::jsonb)",
      values: [fixture.orgId, `legacy-${randomUUID()}`, 1, "{}"],
    });
    expect(legacySettlement.rows[0]).toMatchObject({
      sub_portion: "1",
      idempotent: false,
    });

    const receipt = await client.query<{
      delta: string;
      request_id: string;
      metadata: Record<string, unknown>;
    }>({
      text: `
        SELECT delta, request_id, metadata
        FROM gateway_transactions
        WHERE request_id = $1 AND type = 'refund' AND source = 'payg'
      `,
      values: [`refund:claim:${claim.claim.claimId}`],
    });
    expect(receipt.rows).toHaveLength(1);
    expect(receipt.rows[0]).toMatchObject({
      delta: "-3",
      request_id: `refund:claim:${claim.claim.claimId}`,
      metadata: {
        payment_id: fixture.paymentId,
        claim_id: claim.claim.claimId,
        provider_key: claim.claim.providerKey,
        requested_kopecks: 1,
        cumulative_refunded_kopecks: 1,
        cumulative_clawed_credits: 3,
        resolved_by: "provider_proof",
      },
    });
  });

  it("lets a full webhook close an undispatched partial claim and makes late proof a no-op", async () => {
    const fixture = await createFixture({
      paidKopecks: 3,
      grantCredits: 10,
      paygCredits: 10,
    });
    const claim = await refunds.claimTopupRefund(
      fixture.paymentId,
      1,
      contextFor(fixture, "trusted_no_receipt_required"),
    );
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") throw new Error("claim setup failed");

    const identity = {
      provider: "tinkoff" as const,
      providerPaymentId: fixture.providerPaymentId,
      providerOrderId: fixture.providerOrderId,
    };
    await expect(
      refunds.reconcileFullTopupRefund(fixture.paymentId, identity),
    ).resolves.toMatchObject({
      kind: "settled",
      refundedKopecks: 3,
      clawedCredits: 10,
      paygRemovedCredits: 10,
      debtAddedCredits: 0,
    });
    await expect(
      refunds.markTopupRefundDispatched(claim.claim.claimId),
    ).resolves.toEqual({ kind: "unavailable" });
    await expect(
      refunds.finalizeTopupRefundProof(claim.claim.claimId, {
        paymentId: fixture.providerPaymentId,
        orderId: fixture.providerOrderId,
        externalRequestId: claim.claim.providerKey,
        status: "PARTIAL_REFUNDED",
        originalAmountKopecks: 3,
        newAmountKopecks: 2,
      }),
    ).resolves.toEqual({ kind: "already_settled" });
    await expect(
      refunds.reconcileFullTopupRefund(fixture.paymentId, identity),
    ).resolves.toEqual({ kind: "already_settled" });

    const receipts = await client.query<{
      delta: string;
      metadata: Record<string, unknown>;
    }>({
      text: `
        SELECT delta, metadata
        FROM gateway_transactions
        WHERE request_id = $1 AND type = 'refund' AND source = 'payg'
      `,
      values: [`refund:claim:${claim.claim.claimId}`],
    });
    expect(receipts.rows).toHaveLength(1);
    expect(receipts.rows[0]).toMatchObject({
      delta: "-10",
      metadata: {
        claim_id: claim.claim.claimId,
        provider_key: claim.claim.providerKey,
        requested_kopecks: 1,
        settled_refund_kopecks: 3,
        cumulative_refunded_kopecks: 3,
        cumulative_clawed_credits: 10,
        resolved_by: "full_webhook",
        webhook_identity: identity,
      },
    });
  });

  it("serializes admission guard before claim and blocks later admission", async () => {
    const fixture = await createFixture({
      paygCredits: 1_000,
      subscriptionCredits: 1_000,
    });
    const blocker = await openGuardedClient();
    try {
      await blocker.client.query({ text: "BEGIN", values: [] });
      const pid = await blocker.client.query<{ pid: number }>({
        text: "SELECT pg_backend_pid() AS pid",
        values: [],
      });
      const admitted = await blocker.client.query<{ allowed: string }>({
        text: "SELECT aiag_assert_refund_admission_allowed($1::uuid) AS allowed",
        values: [fixture.orgId],
      });
      expect(admitted.rows).toHaveLength(1);

      const claimPromise = refunds.claimTopupRefund(
        fixture.paymentId,
        99_000,
        contextFor(fixture, "full_no_receipt"),
      );
      await waitForBlockedQuery(
        client,
        pid.rows[0].pid,
        "topup_refund_claim_org_lock",
      );

      await blocker.client.query({ text: "COMMIT", values: [] });

      await expect(claimPromise).resolves.toMatchObject({ kind: "claimed" });

      let blockedError: unknown;
      try {
        await client.query({
          text: "SELECT aiag_assert_refund_admission_allowed($1::uuid)",
          values: [fixture.orgId],
        });
      } catch (error) {
        blockedError = error;
      }
      expect(blockedError).toMatchObject({
        code: "P0005",
        message: "REFUND_BLOCKED",
      });

      const balance = await client.query<{
        subscription_credits: string;
        payg_credits: string;
      }>({
        text: `
          SELECT subscription_credits, payg_credits
          FROM organizations
          WHERE id = $1
        `,
        values: [fixture.orgId],
      });
      expect(balance.rows[0]).toEqual({
        subscription_credits: "1000",
        payg_credits: "1000",
      });
    } finally {
      await blocker.client
        .query({ text: "ROLLBACK", values: [] })
        .catch(() => undefined);
      await blocker.close();
    }
  });

  it("serializes duplicate finalize calls at an actual org-row lock barrier", async () => {
    const fixture = await createFixture({
      paidKopecks: 100,
      grantCredits: 100,
      paygCredits: 100,
    });
    const claim = await refunds.claimTopupRefund(
      fixture.paymentId,
      100,
      contextFor(fixture, "full_no_receipt"),
    );
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") throw new Error("claim setup failed");
    await refunds.markTopupRefundDispatched(claim.claim.claimId);
    const proof = {
      paymentId: fixture.providerPaymentId,
      orderId: fixture.providerOrderId,
      externalRequestId: claim.claim.providerKey,
      status: "REFUNDED" as const,
      originalAmountKopecks: 100,
      newAmountKopecks: 0,
    };

    const blocker = await openGuardedClient();
    let pending:
      | [
          ReturnType<typeof refunds.finalizeTopupRefundProof>,
          ReturnType<typeof refunds.finalizeTopupRefundProof>,
        ]
      | undefined;
    try {
      await blocker.client.query({ text: "BEGIN", values: [] });
      const pid = await blocker.client.query<{ pid: number }>({
        text: "SELECT pg_backend_pid() AS pid",
        values: [],
      });
      await blocker.client.query({
        text: "SELECT id FROM organizations WHERE id = $1 FOR UPDATE",
        values: [fixture.orgId],
      });

      const first = refunds.finalizeTopupRefundProof(
        claim.claim.claimId,
        proof,
      );
      const second = refunds.finalizeTopupRefundProof(
        claim.claim.claimId,
        proof,
      );
      pending = [first, second];
      await waitForBlockedQuery(
        client,
        pid.rows[0].pid,
        "topup_refund_finalize_org_lock",
      );
      await blocker.client.query({ text: "COMMIT", values: [] });

      const outcomes = await Promise.all([first, second]);
      expect(outcomes.map(({ kind }) => kind).sort()).toEqual([
        "already_settled",
        "settled",
      ]);
      const receipts = await client.query<{ count: string }>({
        text: `
          SELECT COUNT(*)::text AS count
          FROM gateway_transactions
          WHERE request_id = $1 AND type = 'refund' AND source = 'payg'
        `,
        values: [`refund:claim:${claim.claim.claimId}`],
      });
      expect(receipts.rows[0].count).toBe("1");
    } finally {
      await blocker.client
        .query({ text: "ROLLBACK", values: [] })
        .catch(() => undefined);
      if (pending) await Promise.allSettled(pending);
      await blocker.close();
    }
  });

  it("keeps one zero-delta receipt for A without consuming active claim B on replay", async () => {
    const fixture = await createFixture({
      paidKopecks: 1_000_000,
      grantCredits: 1,
      paygCredits: 1,
    });
    const context = contextFor(fixture, "trusted_no_receipt_required");
    const claimA = await refunds.claimTopupRefund(
      fixture.paymentId,
      1,
      context,
    );
    expect(claimA.kind).toBe("claimed");
    if (claimA.kind !== "claimed") throw new Error("claim A setup failed");
    await refunds.markTopupRefundDispatched(claimA.claim.claimId);
    const proofA = {
      paymentId: fixture.providerPaymentId,
      orderId: fixture.providerOrderId,
      externalRequestId: claimA.claim.providerKey,
      status: "PARTIAL_REFUNDED" as const,
      originalAmountKopecks: 1_000_000,
      newAmountKopecks: 999_999,
    };
    await expect(
      refunds.finalizeTopupRefundProof(claimA.claim.claimId, proofA),
    ).resolves.toMatchObject({
      kind: "settled",
      refundedKopecks: 1,
      clawedCredits: 0,
      paygRemovedCredits: 0,
      debtAddedCredits: 0,
    });

    const claimB = await refunds.claimTopupRefund(
      fixture.paymentId,
      1,
      context,
    );
    expect(claimB.kind).toBe("claimed");
    if (claimB.kind !== "claimed") throw new Error("claim B setup failed");
    await expect(
      refunds.finalizeTopupRefundProof(claimA.claim.claimId, proofA),
    ).resolves.toEqual({ kind: "already_settled" });

    const state = await client.query<{
      refund_claim_id: string;
      refund_provider_key: string;
      receipt_count: string;
      receipt_delta: string;
    }>({
      text: `
        SELECT p.refund_claim_id, p.refund_provider_key,
               COUNT(gt.id)::text AS receipt_count,
               MIN(gt.delta)::text AS receipt_delta
        FROM payments p
        JOIN gateway_transactions gt
          ON gt.org_id = p.topup_org_id
         AND gt.request_id = $2
         AND gt.type = 'refund'
         AND gt.source = 'payg'
        WHERE p.id = $1
        GROUP BY p.refund_claim_id, p.refund_provider_key
      `,
      values: [fixture.paymentId, `refund:claim:${claimA.claim.claimId}`],
    });
    expect(state.rows[0]).toEqual({
      refund_claim_id: claimB.claim.claimId,
      refund_provider_key: claimB.claim.providerKey,
      receipt_count: "1",
      receipt_delta: "0",
    });
  });

  it("reconciles the exact remaining rounded grant after a partial and ignores late B proof", async () => {
    const fixture = await createFixture({
      paidKopecks: 3,
      grantCredits: 10,
      paygCredits: 4,
    });
    const context = contextFor(fixture, "trusted_no_receipt_required");
    const claimA = await refunds.claimTopupRefund(
      fixture.paymentId,
      1,
      context,
    );
    expect(claimA.kind).toBe("claimed");
    if (claimA.kind !== "claimed") throw new Error("claim A setup failed");
    await refunds.markTopupRefundDispatched(claimA.claim.claimId);
    await refunds.finalizeTopupRefundProof(claimA.claim.claimId, {
      paymentId: fixture.providerPaymentId,
      orderId: fixture.providerOrderId,
      externalRequestId: claimA.claim.providerKey,
      status: "PARTIAL_REFUNDED",
      originalAmountKopecks: 3,
      newAmountKopecks: 2,
    });

    const claimB = await refunds.claimTopupRefund(
      fixture.paymentId,
      1,
      context,
    );
    expect(claimB.kind).toBe("claimed");
    if (claimB.kind !== "claimed") throw new Error("claim B setup failed");
    await refunds.reconcileFullTopupRefund(fixture.paymentId, {
      provider: "tinkoff",
      providerPaymentId: fixture.providerPaymentId,
      providerOrderId: fixture.providerOrderId,
    });
    await expect(
      refunds.finalizeTopupRefundProof(claimB.claim.claimId, {
        paymentId: fixture.providerPaymentId,
        orderId: fixture.providerOrderId,
        externalRequestId: claimB.claim.providerKey,
        status: "PARTIAL_REFUNDED",
        originalAmountKopecks: 2,
        newAmountKopecks: 1,
      }),
    ).resolves.toEqual({ kind: "already_settled" });

    const state = await client.query<{
      status: string;
      topup_refunded_kopecks: string;
      topup_clawed_credits: string;
      payg_credits: string;
      refund_debt_credits: string;
      refund_rows: string;
      refund_delta: string;
    }>({
      text: `
        SELECT p.status, p.topup_refunded_kopecks, p.topup_clawed_credits,
               o.payg_credits, o.refund_debt_credits,
               COUNT(gt.id)::text AS refund_rows,
               SUM(gt.delta)::text AS refund_delta
        FROM payments p
        JOIN organizations o ON o.id = p.topup_org_id
        JOIN gateway_transactions gt
          ON gt.org_id = p.topup_org_id AND gt.type = 'refund'
        WHERE p.id = $1
        GROUP BY p.status, p.topup_refunded_kopecks, p.topup_clawed_credits,
                 o.payg_credits, o.refund_debt_credits
      `,
      values: [fixture.paymentId],
    });
    expect(state.rows[0]).toEqual({
      status: "refunded",
      topup_refunded_kopecks: "3",
      topup_clawed_credits: "10",
      payg_credits: "0",
      refund_debt_credits: "6",
      refund_rows: "2",
      refund_delta: "-10",
    });
  });

  it("rolls back payment and debt mutations when the audit receipt insert fails", async () => {
    const fixture = await createFixture({
      paidKopecks: 100,
      grantCredits: 100,
      paygCredits: 40,
    });
    const claim = await refunds.claimTopupRefund(
      fixture.paymentId,
      100,
      contextFor(fixture, "full_no_receipt"),
    );
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") throw new Error("claim setup failed");
    await refunds.markTopupRefundDispatched(claim.claim.claimId);
    const requestId = `refund:claim:${claim.claim.claimId}`;
    const conflictFixture = await createFixture();

    const blocker = await openGuardedClient();
    let finalizePromise:
      | ReturnType<typeof refunds.finalizeTopupRefundProof>
      | undefined;
    try {
      await blocker.client.query({ text: "BEGIN", values: [] });
      const pid = await blocker.client.query<{ pid: number }>({
        text: "SELECT pg_backend_pid() AS pid",
        values: [],
      });
      await blocker.client.query({
        text: `
          INSERT INTO gateway_transactions (
            org_id, request_id, type, source, delta, metadata
          ) VALUES ($1, $2, 'refund', 'payg', 0, $3::jsonb)
        `,
        values: [
          conflictFixture.orgId,
          requestId,
          JSON.stringify({ injected_conflict: true }),
        ],
      });

      finalizePromise = refunds.finalizeTopupRefundProof(claim.claim.claimId, {
        paymentId: fixture.providerPaymentId,
        orderId: fixture.providerOrderId,
        externalRequestId: claim.claim.providerKey,
        status: "REFUNDED",
        originalAmountKopecks: 100,
        newAmountKopecks: 0,
      });
      await waitForBlockedQuery(
        client,
        pid.rows[0].pid,
        "INSERT INTO gateway_transactions",
      );
      await blocker.client.query({ text: "COMMIT", values: [] });
      await expect(finalizePromise).rejects.toThrow(
        "refund receipt insert failed",
      );

      const state = await client.query<{
        topup_refunded_kopecks: string;
        topup_clawed_credits: string;
        refund_claim_id: string;
        payg_credits: string;
        refund_debt_credits: string;
      }>({
        text: `
          SELECT p.topup_refunded_kopecks, p.topup_clawed_credits,
                 p.refund_claim_id, o.payg_credits, o.refund_debt_credits
          FROM payments p
          JOIN organizations o ON o.id = p.topup_org_id
          WHERE p.id = $1
        `,
        values: [fixture.paymentId],
      });
      expect(state.rows[0]).toEqual({
        topup_refunded_kopecks: "0",
        topup_clawed_credits: "0",
        refund_claim_id: claim.claim.claimId,
        payg_credits: "40",
        refund_debt_credits: "0",
      });
    } finally {
      await blocker.client
        .query({ text: "ROLLBACK", values: [] })
        .catch(() => undefined);
      if (finalizePromise) await Promise.allSettled([finalizePromise]);
      await blocker.close();
    }
  });

  it("rejects every mismatched provider proof without clearing the claim", async () => {
    const fixture = await createFixture({
      paidKopecks: 100,
      grantCredits: 100,
      paygCredits: 100,
    });
    const claim = await refunds.claimTopupRefund(
      fixture.paymentId,
      100,
      contextFor(fixture, "full_no_receipt"),
    );
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") throw new Error("claim setup failed");
    await refunds.markTopupRefundDispatched(claim.claim.claimId);
    const valid = {
      paymentId: fixture.providerPaymentId,
      orderId: fixture.providerOrderId,
      externalRequestId: claim.claim.providerKey,
      status: "REFUNDED" as const,
      originalAmountKopecks: 100,
      newAmountKopecks: 0,
    };
    const invalid = [
      { ...valid, paymentId: "wrong-payment" },
      { ...valid, orderId: "wrong-order" },
      { ...valid, externalRequestId: randomUUID() },
      { ...valid, originalAmountKopecks: 99 },
      { ...valid, newAmountKopecks: 1 },
      { ...valid, status: "PARTIAL_REFUNDED" as const },
    ];

    for (const proof of invalid) {
      await expect(
        refunds.finalizeTopupRefundProof(claim.claim.claimId, proof),
      ).resolves.toEqual({ kind: "proof_invalid" });
    }

    const state = await client.query<{
      refund_claim_id: string;
      topup_refunded_kopecks: string;
      topup_clawed_credits: string;
      payg_credits: string;
    }>({
      text: `
        SELECT p.refund_claim_id, p.topup_refunded_kopecks,
               p.topup_clawed_credits, o.payg_credits
        FROM payments p
        JOIN organizations o ON o.id = p.topup_org_id
        WHERE p.id = $1
      `,
      values: [fixture.paymentId],
    });
    expect(state.rows[0]).toEqual({
      refund_claim_id: claim.claim.claimId,
      topup_refunded_kopecks: "0",
      topup_clawed_credits: "0",
      payg_credits: "100",
    });
  });

  it("rejects a non-RUB snapshot before claim or full reconciliation money effects", async () => {
    const fixture = await createFixture();
    await client.query({
      text: "UPDATE payments SET currency = $1 WHERE id = $2",
      values: ["USD", fixture.paymentId],
    });

    await expect(
      refunds.claimTopupRefund(
        fixture.paymentId,
        99_000,
        contextFor(fixture, "full_no_receipt"),
      ),
    ).resolves.toEqual({ kind: "rejected", code: "PAYMENT_NOT_REFUNDABLE" });
    await expect(
      refunds.reconcileFullTopupRefund(fixture.paymentId, {
        provider: "tinkoff",
        providerPaymentId: fixture.providerPaymentId,
        providerOrderId: fixture.providerOrderId,
      }),
    ).resolves.toEqual({ kind: "identity_mismatch" });

    const state = await client.query<{
      refund_claim_id: string | null;
      topup_refunded_kopecks: string;
      topup_clawed_credits: string;
      payg_credits: string;
    }>({
      text: `
        SELECT p.refund_claim_id, p.topup_refunded_kopecks,
               p.topup_clawed_credits, o.payg_credits
        FROM payments p
        JOIN organizations o ON o.id = p.topup_org_id
        WHERE p.id = $1
      `,
      values: [fixture.paymentId],
    });
    expect(state.rows[0]).toEqual({
      refund_claim_id: null,
      topup_refunded_kopecks: "0",
      topup_clawed_credits: "0",
      payg_credits: "1200000",
    });
  });

  it("uses the independent payment event key for a full refund without an active claim", async () => {
    const fixture = await createFixture({
      paidKopecks: 2,
      grantCredits: 1,
      paygCredits: 1,
    });
    const identity = {
      provider: "tinkoff" as const,
      providerPaymentId: fixture.providerPaymentId,
      providerOrderId: fixture.providerOrderId,
    };

    await expect(
      refunds.reconcileFullTopupRefund(fixture.paymentId, identity),
    ).resolves.toMatchObject({
      kind: "settled",
      refundedKopecks: 2,
      clawedCredits: 1,
    });
    await expect(
      refunds.reconcileFullTopupRefund(fixture.paymentId, identity),
    ).resolves.toEqual({ kind: "already_settled" });

    const receipt = await client.query<{
      request_id: string;
      delta: string;
      metadata: Record<string, unknown>;
    }>({
      text: `
        SELECT request_id, delta, metadata
        FROM gateway_transactions
        WHERE request_id = $1 AND type = 'refund' AND source = 'payg'
      `,
      values: [`refund:full:${fixture.paymentId}`],
    });
    expect(receipt.rows).toHaveLength(1);
    expect(receipt.rows[0]).toMatchObject({
      request_id: `refund:full:${fixture.paymentId}`,
      delta: "-1",
      metadata: {
        payment_id: fixture.paymentId,
        claim_id: null,
        provider_key: null,
        requested_kopecks: 2,
        settled_refund_kopecks: 2,
        resolved_by: "full_webhook",
      },
    });
  });

  it("allows partial claims only with explicit trusted no-receipt context", async () => {
    const fixture = await createFixture({
      paidKopecks: 100,
      grantCredits: 100,
    });

    await expect(
      refunds.claimTopupRefund(
        fixture.paymentId,
        50,
        contextFor(fixture, "full_no_receipt"),
      ),
    ).resolves.toEqual({ kind: "rejected", code: "PAYMENT_NOT_REFUNDABLE" });
    await expect(
      refunds.claimTopupRefund(
        fixture.paymentId,
        50,
        contextFor(fixture, "trusted_no_receipt_required"),
      ),
    ).resolves.toMatchObject({
      kind: "claimed",
      claim: {
        requestedKopecks: 50,
        receiptMode: "trusted_no_receipt_required",
      },
    });
  });
});
