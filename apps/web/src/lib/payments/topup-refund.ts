import { randomUUID } from "node:crypto";

import { db } from "@/lib/db";
import { sql, type Database } from "@aiag/database";

export type TopupRefundReceiptMode =
  | "full_no_receipt"
  | "trusted_no_receipt_required";

export interface TopupRefundMethodContext {
  paymentId: string;
  orderId: string;
  route: "ACQ";
  source: "cards";
  receiptMode: TopupRefundReceiptMode;
}

export interface TopupRefundProof {
  paymentId: string;
  orderId: string;
  externalRequestId: string;
  status: "PARTIAL_REFUNDED" | "REFUNDED";
  originalAmountKopecks: number;
  newAmountKopecks: number;
}

export interface FullTopupRefundIdentity {
  provider: "tinkoff";
  providerPaymentId: string;
  providerOrderId: string;
}

type RefundDatabase = Database;

interface PaymentHintRow {
  topup_org_id: string | null;
}

interface ClaimedRow {
  id: string;
  tinkoff_payment_id: string;
  tinkoff_order_id: string;
  topup_paid_kopecks: string | number;
  topup_refunded_kopecks: string | number;
  refund_claimed_at: Date | string;
}

interface ActiveClaimRow extends ClaimedRow {
  refund_claim_id: string;
  refund_claim_kopecks: string | number;
  refund_provider_key: string;
  refund_method_route: "ACQ";
  refund_method_source: "cards";
  refund_receipt_mode: TopupRefundReceiptMode;
  refund_dispatched_at: Date | string;
}

interface LockedRefundRow extends ActiveClaimRow {
  topup_org_id: string;
  subscription_id: string | null;
  currency: string;
  status: string;
  metadata: Record<string, unknown> | null;
  topup_grant_credits: string | number;
  topup_clawed_credits: string | number;
}

interface FullRefundRow {
  id: string;
  topup_org_id: string;
  tinkoff_payment_id: string;
  tinkoff_order_id: string;
  status: string;
  subscription_id: string | null;
  currency: string;
  metadata: Record<string, unknown> | null;
  topup_paid_kopecks: string | number;
  topup_grant_credits: string | number;
  topup_refunded_kopecks: string | number;
  topup_clawed_credits: string | number;
  refund_claim_id: string | null;
  refund_claim_kopecks: string | number | null;
  refund_provider_key: string | null;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSupportedContext(value: unknown): value is TopupRefundMethodContext {
  if (typeof value !== "object" || value === null) return false;
  const context = value as Record<string, unknown>;
  return (
    isNonemptyString(context.paymentId) &&
    isNonemptyString(context.orderId) &&
    context.route === "ACQ" &&
    context.source === "cards" &&
    (context.receiptMode === "full_no_receipt" ||
      context.receiptMode === "trusted_no_receipt_required")
  );
}

function rowsOf<Row>(result: unknown): Row[] {
  if (
    typeof result === "object" &&
    result !== null &&
    "rows" in result &&
    Array.isArray((result as { rows: unknown }).rows)
  ) {
    return (result as { rows: Row[] }).rows;
  }
  if (Array.isArray(result)) return result as Row[];
  throw new Error("unsupported database result");
}

function toSafeInteger(value: unknown, field: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`invalid ${field} database value`);
  }
  return parsed;
}

function toDate(value: Date | string, field: string): Date {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`invalid ${field} database value`);
  }
  return parsed;
}

function isRefundProof(value: unknown): value is TopupRefundProof {
  if (typeof value !== "object" || value === null) return false;
  const proof = value as Record<string, unknown>;
  return (
    isNonemptyString(proof.paymentId) &&
    isNonemptyString(proof.orderId) &&
    isNonemptyString(proof.externalRequestId) &&
    (proof.status === "PARTIAL_REFUNDED" || proof.status === "REFUNDED") &&
    Number.isSafeInteger(proof.originalAmountKopecks) &&
    (proof.originalAmountKopecks as number) >= 0 &&
    Number.isSafeInteger(proof.newAmountKopecks) &&
    (proof.newAmountKopecks as number) >= 0
  );
}

function isFullRefundIdentity(
  value: unknown,
): value is FullTopupRefundIdentity {
  if (typeof value !== "object" || value === null) return false;
  const identity = value as Record<string, unknown>;
  return (
    identity.provider === "tinkoff" &&
    isNonemptyString(identity.providerPaymentId) &&
    isNonemptyString(identity.providerOrderId)
  );
}

export async function claimTopupRefund(
  paymentId: string,
  requestedKopecks: number,
  context: TopupRefundMethodContext,
  database: RefundDatabase = db,
) {
  if (
    !UUID_PATTERN.test(paymentId) ||
    !Number.isSafeInteger(requestedKopecks) ||
    requestedKopecks <= 0
  ) {
    return { kind: "rejected", code: "INVALID_REQUEST" } as const;
  }
  if (
    typeof context !== "object" ||
    context === null ||
    (context as { route?: unknown }).route !== "ACQ" ||
    (context as { source?: unknown }).source !== "cards" ||
    !isNonemptyString((context as { paymentId?: unknown }).paymentId) ||
    !isNonemptyString((context as { orderId?: unknown }).orderId)
  ) {
    return { kind: "rejected", code: "UNSUPPORTED_METHOD" } as const;
  }
  if (!isSupportedContext(context)) {
    return { kind: "rejected", code: "RECEIPT_CONTEXT_UNSUPPORTED" } as const;
  }

  const hintResult = await database.execute(sql`
    SELECT topup_org_id
    FROM payments
    WHERE id = ${paymentId}::uuid
  `);
  const hint = rowsOf<PaymentHintRow>(hintResult)[0];
  if (!hint?.topup_org_id) {
    return { kind: "rejected", code: "PAYMENT_NOT_REFUNDABLE" } as const;
  }

  const claimId = randomUUID();
  const providerKey = randomUUID();
  return database.transaction(async (tx) => {
    const orgLock = await tx.execute(sql`
      /* topup_refund_claim_org_lock */
      SELECT id
      FROM organizations
      WHERE id = ${hint.topup_org_id}::uuid
      FOR UPDATE
    `);
    if (rowsOf<{ id: string }>(orgLock).length !== 1) {
      return { kind: "rejected", code: "PAYMENT_NOT_REFUNDABLE" } as const;
    }

    const claimedResult = await tx.execute(sql`
      UPDATE payments
      SET refund_claim_id = ${claimId}::uuid,
          refund_claim_kopecks = ${requestedKopecks}::bigint,
          refund_claimed_at = NOW(),
          refund_provider_key = ${providerKey},
          refund_method_route = ${context.route},
          refund_method_source = ${context.source},
          refund_receipt_mode = ${context.receiptMode},
          refund_dispatched_at = NULL,
          updated_at = NOW()
      WHERE id = ${paymentId}::uuid
        AND topup_org_id = ${hint.topup_org_id}::uuid
        AND subscription_id IS NULL
        AND metadata->>'kind' = 'topup'
        AND metadata->>'provider' = 'tinkoff'
        AND currency = 'RUB'
        AND status IN ('confirmed', 'partial_refunded')
        AND tinkoff_payment_id = ${context.paymentId}
        AND tinkoff_order_id = ${context.orderId}
        AND topup_paid_kopecks IS NOT NULL
        AND topup_grant_credits IS NOT NULL
        AND topup_refunded_kopecks >= 0
        AND topup_refunded_kopecks < topup_paid_kopecks
        AND topup_clawed_credits >= 0
        AND topup_clawed_credits <= topup_grant_credits
        AND refund_claim_id IS NULL
        AND refund_claim_kopecks IS NULL
        AND refund_claimed_at IS NULL
        AND refund_provider_key IS NULL
        AND refund_method_route IS NULL
        AND refund_method_source IS NULL
        AND refund_receipt_mode IS NULL
        AND refund_dispatched_at IS NULL
        AND ${requestedKopecks}::bigint <= topup_paid_kopecks - topup_refunded_kopecks
        AND (
          ${context.receiptMode} = 'trusted_no_receipt_required'
          OR ${requestedKopecks}::bigint = topup_paid_kopecks - topup_refunded_kopecks
        )
      RETURNING id, tinkoff_payment_id, tinkoff_order_id,
                topup_paid_kopecks, topup_refunded_kopecks,
                refund_claimed_at
    `);
    const claimed = rowsOf<ClaimedRow>(claimedResult)[0];
    if (!claimed) {
      const stateResult = await tx.execute(sql`
        SELECT refund_claim_id
        FROM payments
        WHERE id = ${paymentId}::uuid
          AND topup_org_id = ${hint.topup_org_id}::uuid
      `);
      const state = rowsOf<{ refund_claim_id: string | null }>(stateResult)[0];
      return state?.refund_claim_id
        ? ({ kind: "rejected", code: "CLAIM_ACTIVE" } as const)
        : ({ kind: "rejected", code: "PAYMENT_NOT_REFUNDABLE" } as const);
    }

    return {
      kind: "claimed",
      claim: {
        claimId,
        providerKey,
        paymentId: claimed.id,
        providerPaymentId: claimed.tinkoff_payment_id,
        providerOrderId: claimed.tinkoff_order_id,
        requestedKopecks,
        paidKopecks: toSafeInteger(
          claimed.topup_paid_kopecks,
          "topup_paid_kopecks",
        ),
        refundedKopecks: toSafeInteger(
          claimed.topup_refunded_kopecks,
          "topup_refunded_kopecks",
        ),
        route: context.route,
        source: context.source,
        receiptMode: context.receiptMode,
        claimedAt: toDate(claimed.refund_claimed_at, "refund_claimed_at"),
        dispatchedAt: null,
      },
    } as const;
  });
}

export async function releaseProvenNoEffectTopupRefundClaim(
  claimId: string,
  proofCode: string,
  database: RefundDatabase = db,
) {
  void claimId;
  void proofCode;
  void database;
  return { kind: "proof_not_allowed" } as const;
}

function activeClaimFromRow(row: ActiveClaimRow) {
  return {
    claimId: row.refund_claim_id,
    providerKey: row.refund_provider_key,
    paymentId: row.id,
    providerPaymentId: row.tinkoff_payment_id,
    providerOrderId: row.tinkoff_order_id,
    requestedKopecks: toSafeInteger(
      row.refund_claim_kopecks,
      "refund_claim_kopecks",
    ),
    paidKopecks: toSafeInteger(row.topup_paid_kopecks, "topup_paid_kopecks"),
    refundedKopecks: toSafeInteger(
      row.topup_refunded_kopecks,
      "topup_refunded_kopecks",
    ),
    route: row.refund_method_route,
    source: row.refund_method_source,
    receiptMode: row.refund_receipt_mode,
    claimedAt: toDate(row.refund_claimed_at, "refund_claimed_at"),
    dispatchedAt: toDate(
      row.refund_dispatched_at,
      "refund_dispatched_at",
    ),
  } as const;
}

export async function markTopupRefundDispatched(
  claimId: string,
  database: RefundDatabase = db,
) {
  if (!UUID_PATTERN.test(claimId)) return { kind: "unavailable" } as const;

  const result = await database.execute(sql`
    UPDATE payments
    SET refund_dispatched_at = GREATEST(clock_timestamp(), refund_claimed_at),
        updated_at = NOW()
    WHERE refund_claim_id = ${claimId}::uuid
      AND subscription_id IS NULL
      AND currency = 'RUB'
      AND metadata->>'kind' = 'topup'
      AND metadata->>'provider' = 'tinkoff'
      AND refund_claim_kopecks IS NOT NULL
      AND refund_claimed_at IS NOT NULL
      AND refund_provider_key IS NOT NULL
      AND refund_method_route = 'ACQ'
      AND refund_method_source = 'cards'
      AND refund_receipt_mode IN ('full_no_receipt', 'trusted_no_receipt_required')
      AND refund_dispatched_at IS NULL
      AND status IN ('confirmed', 'partial_refunded')
    RETURNING id, tinkoff_payment_id, tinkoff_order_id,
              topup_paid_kopecks, topup_refunded_kopecks,
              refund_claim_id, refund_claim_kopecks, refund_claimed_at,
              refund_provider_key, refund_method_route, refund_method_source,
              refund_receipt_mode, refund_dispatched_at
  `);
  const row = rowsOf<ActiveClaimRow>(result)[0];
  return row
    ? ({ kind: "marked", claim: activeClaimFromRow(row) } as const)
    : ({ kind: "unavailable" } as const);
}

export async function releaseUndispatchedTopupRefundClaim(
  claimId: string,
  database: RefundDatabase = db,
) {
  if (!UUID_PATTERN.test(claimId)) return { kind: "not_released" } as const;

  const result = await database.execute(sql`
    UPDATE payments
    SET refund_claim_id = NULL,
        refund_claim_kopecks = NULL,
        refund_claimed_at = NULL,
        refund_provider_key = NULL,
        refund_method_route = NULL,
        refund_method_source = NULL,
        refund_receipt_mode = NULL,
        refund_dispatched_at = NULL,
        updated_at = NOW()
    WHERE refund_claim_id = ${claimId}::uuid
      AND refund_dispatched_at IS NULL
    RETURNING id
  `);
  return rowsOf<{ id: string }>(result).length === 1
    ? ({ kind: "released" } as const)
    : ({ kind: "not_released" } as const);
}

export async function finalizeTopupRefundProof(
  claimId: string,
  proof: TopupRefundProof,
  database: RefundDatabase = db,
) {
  if (!UUID_PATTERN.test(claimId) || !isRefundProof(proof)) {
    return { kind: "proof_invalid" } as const;
  }
  const requestId = `refund:claim:${claimId}`;
  const hintResult = await database.execute(sql`
    SELECT topup_org_id AS org_id
    FROM payments
    WHERE refund_claim_id = ${claimId}::uuid
    UNION ALL
    SELECT org_id
    FROM gateway_transactions
    WHERE request_id = ${requestId}
      AND type = 'refund'
      AND source = 'payg'
    LIMIT 1
  `);
  const hint = rowsOf<{ org_id: string | null }>(hintResult)[0];
  if (!hint?.org_id) return { kind: "not_found" } as const;

  return database.transaction(async (tx) => {
    const orgResult = await tx.execute(sql`
      /* topup_refund_finalize_org_lock */
      SELECT id, payg_credits, refund_debt_credits
      FROM organizations
      WHERE id = ${hint.org_id}::uuid
      FOR UPDATE
    `);
    const org = rowsOf<{
      id: string;
      payg_credits: string | number;
      refund_debt_credits: string | number;
    }>(orgResult)[0];
    if (!org) return { kind: "not_found" } as const;

    const receiptResult = await tx.execute(sql`
      SELECT 1 AS found
      FROM gateway_transactions
      WHERE request_id = ${requestId}
        AND type = 'refund'
        AND source = 'payg'
      LIMIT 1
    `);
    if (rowsOf<{ found: number }>(receiptResult).length > 0) {
      return { kind: "already_settled" } as const;
    }

    const paymentResult = await tx.execute(sql`
      /* topup_refund_finalize_payment_lock */
      SELECT id, topup_org_id, subscription_id, currency, status, metadata,
             tinkoff_payment_id, tinkoff_order_id,
             topup_paid_kopecks, topup_grant_credits,
             topup_refunded_kopecks, topup_clawed_credits,
             refund_claim_id, refund_claim_kopecks, refund_claimed_at,
             refund_provider_key, refund_method_route, refund_method_source,
             refund_receipt_mode, refund_dispatched_at
      FROM payments
      WHERE refund_claim_id = ${claimId}::uuid
        AND topup_org_id = ${hint.org_id}::uuid
      FOR UPDATE
    `);
    const payment = rowsOf<LockedRefundRow>(paymentResult)[0];
    if (!payment || !payment.refund_dispatched_at) {
      return { kind: "not_found" } as const;
    }
    if (
      payment.subscription_id !== null ||
      payment.currency !== "RUB" ||
      payment.metadata?.kind !== "topup" ||
      payment.metadata?.provider !== "tinkoff" ||
      !["confirmed", "partial_refunded"].includes(payment.status) ||
      payment.refund_method_route !== "ACQ" ||
      payment.refund_method_source !== "cards" ||
      !["full_no_receipt", "trusted_no_receipt_required"].includes(
        payment.refund_receipt_mode,
      )
    ) {
      return { kind: "proof_invalid" } as const;
    }

    const paidKopecks = toSafeInteger(
      payment.topup_paid_kopecks,
      "topup_paid_kopecks",
    );
    const refundedKopecks = toSafeInteger(
      payment.topup_refunded_kopecks,
      "topup_refunded_kopecks",
    );
    const requestedKopecks = toSafeInteger(
      payment.refund_claim_kopecks,
      "refund_claim_kopecks",
    );
    const grantCredits = toSafeInteger(
      payment.topup_grant_credits,
      "topup_grant_credits",
    );
    const clawedCredits = toSafeInteger(
      payment.topup_clawed_credits,
      "topup_clawed_credits",
    );
    const remainingKopecks = paidKopecks - refundedKopecks;
    const newRefundedKopecks = refundedKopecks + requestedKopecks;
    const expectedNewAmount = remainingKopecks - requestedKopecks;
    if (
      proof.paymentId !== payment.tinkoff_payment_id ||
      proof.orderId !== payment.tinkoff_order_id ||
      proof.externalRequestId !== payment.refund_provider_key ||
      proof.originalAmountKopecks !== remainingKopecks ||
      proof.newAmountKopecks !== expectedNewAmount ||
      expectedNewAmount < 0 ||
      (proof.status === "REFUNDED" && expectedNewAmount !== 0) ||
      (proof.status === "PARTIAL_REFUNDED" && expectedNewAmount === 0)
    ) {
      return { kind: "proof_invalid" } as const;
    }

    const targetResult = await tx.execute(sql`
      SELECT CASE
        WHEN ${newRefundedKopecks}::bigint = ${paidKopecks}::bigint
          THEN ${grantCredits}::bigint
        ELSE round(
          ${grantCredits}::numeric * ${newRefundedKopecks}::numeric /
          ${paidKopecks}::numeric
        )::bigint
      END AS target_claw
    `);
    const targetClaw = toSafeInteger(
      rowsOf<{ target_claw: string | number }>(targetResult)[0].target_claw,
      "target_claw",
    );
    const delta = targetClaw - clawedCredits;
    if (delta < 0) throw new Error("refund clawback target moved backwards");

    const orgUpdate = await tx.execute(sql`
      UPDATE organizations
      SET payg_credits = GREATEST(payg_credits - ${delta}::bigint, 0),
          refund_debt_credits = refund_debt_credits +
            GREATEST(${delta}::bigint - payg_credits, 0),
          updated_at = NOW()
      WHERE id = ${hint.org_id}::uuid
        AND payg_credits >= 0
        AND refund_debt_credits >= 0
      RETURNING payg_credits, refund_debt_credits
    `);
    if (rowsOf<{ payg_credits: string }>(orgUpdate).length !== 1) {
      throw new Error("refund organization update failed");
    }

    const paymentUpdate = await tx.execute(sql`
      UPDATE payments
      SET topup_refunded_kopecks = ${newRefundedKopecks}::bigint,
          topup_clawed_credits = ${targetClaw}::bigint,
          refunded_amount = ${newRefundedKopecks}::numeric / 100,
          refunded_at = NOW(),
          status = ${expectedNewAmount === 0 ? "refunded" : "partial_refunded"}::payment_status,
          refund_claim_id = NULL,
          refund_claim_kopecks = NULL,
          refund_claimed_at = NULL,
          refund_provider_key = NULL,
          refund_method_route = NULL,
          refund_method_source = NULL,
          refund_receipt_mode = NULL,
          refund_dispatched_at = NULL,
          updated_at = NOW()
      WHERE id = ${payment.id}::uuid
        AND topup_org_id = ${hint.org_id}::uuid
        AND refund_claim_id = ${claimId}::uuid
        AND topup_refunded_kopecks = ${refundedKopecks}::bigint
        AND topup_clawed_credits = ${clawedCredits}::bigint
      RETURNING id
    `);
    if (rowsOf<{ id: string }>(paymentUpdate).length !== 1) {
      throw new Error("refund payment update failed");
    }

    const paygBefore = toSafeInteger(org.payg_credits, "payg_credits");
    const paygRemovedCredits = Math.min(paygBefore, delta);
    const debtAddedCredits = delta - paygRemovedCredits;
    const receiptInsert = await tx.execute(sql`
      INSERT INTO gateway_transactions (
        org_id, request_id, type, source, delta, metadata, created_at
      ) VALUES (
        ${hint.org_id}::uuid,
        ${requestId},
        'refund',
        'payg',
        ${-delta}::bigint,
        jsonb_build_object(
          'payment_id', ${payment.id}::text,
          'claim_id', ${claimId}::text,
          'provider_key', ${payment.refund_provider_key}::text,
          'requested_kopecks', ${requestedKopecks}::bigint,
          'cumulative_refunded_kopecks', ${newRefundedKopecks}::bigint,
          'cumulative_clawed_credits', ${targetClaw}::bigint,
          'payg_removed_credits', ${paygRemovedCredits}::bigint,
          'debt_added_credits', ${debtAddedCredits}::bigint,
          'resolved_by', 'provider_proof',
          'proof', jsonb_build_object(
            'payment_id', ${proof.paymentId}::text,
            'order_id', ${proof.orderId}::text,
            'external_request_id', ${proof.externalRequestId}::text,
            'status', ${proof.status}::text,
            'original_amount_kopecks', ${proof.originalAmountKopecks}::bigint,
            'new_amount_kopecks', ${proof.newAmountKopecks}::bigint
          )
        ),
        NOW()
      )
      ON CONFLICT (request_id, source) WHERE type = 'refund'
      DO NOTHING
      RETURNING id
    `);
    if (rowsOf<{ id: string }>(receiptInsert).length !== 1) {
      throw new Error("refund receipt insert failed");
    }

    return {
      kind: "settled",
      refundedKopecks: newRefundedKopecks,
      clawedCredits: targetClaw,
      paygRemovedCredits,
      debtAddedCredits,
    } as const;
  });
}

export async function reconcileFullTopupRefund(
  paymentId: string,
  identity: FullTopupRefundIdentity,
  database: RefundDatabase = db,
) {
  if (!UUID_PATTERN.test(paymentId) || !isFullRefundIdentity(identity)) {
    return { kind: "identity_invalid" } as const;
  }
  const hintResult = await database.execute(sql`
    SELECT topup_org_id
    FROM payments
    WHERE id = ${paymentId}::uuid
  `);
  const hint = rowsOf<PaymentHintRow>(hintResult)[0];
  if (!hint?.topup_org_id) return { kind: "not_found" } as const;

  return database.transaction(async (tx) => {
    const orgResult = await tx.execute(sql`
      /* topup_refund_full_org_lock */
      SELECT id, payg_credits, refund_debt_credits
      FROM organizations
      WHERE id = ${hint.topup_org_id}::uuid
      FOR UPDATE
    `);
    const org = rowsOf<{
      id: string;
      payg_credits: string | number;
      refund_debt_credits: string | number;
    }>(orgResult)[0];
    if (!org) return { kind: "not_found" } as const;

    const paymentResult = await tx.execute(sql`
      /* topup_refund_full_payment_lock */
      SELECT id, topup_org_id, tinkoff_payment_id, tinkoff_order_id,
             status, subscription_id, currency, metadata,
             topup_paid_kopecks, topup_grant_credits,
             topup_refunded_kopecks, topup_clawed_credits,
             refund_claim_id, refund_claim_kopecks, refund_provider_key
      FROM payments
      WHERE id = ${paymentId}::uuid
        AND topup_org_id = ${hint.topup_org_id}::uuid
      FOR UPDATE
    `);
    const payment = rowsOf<FullRefundRow>(paymentResult)[0];
    if (!payment) return { kind: "not_found" } as const;
    if (
      payment.metadata?.kind !== "topup" ||
      payment.metadata?.provider !== "tinkoff" ||
      payment.subscription_id !== null ||
      payment.currency !== "RUB" ||
      payment.tinkoff_payment_id !== identity.providerPaymentId ||
      payment.tinkoff_order_id !== identity.providerOrderId
    ) {
      return { kind: "identity_mismatch" } as const;
    }

    const paidKopecks = toSafeInteger(
      payment.topup_paid_kopecks,
      "topup_paid_kopecks",
    );
    const grantCredits = toSafeInteger(
      payment.topup_grant_credits,
      "topup_grant_credits",
    );
    const refundedKopecks = toSafeInteger(
      payment.topup_refunded_kopecks,
      "topup_refunded_kopecks",
    );
    const clawedCredits = toSafeInteger(
      payment.topup_clawed_credits,
      "topup_clawed_credits",
    );
    if (refundedKopecks === paidKopecks && clawedCredits === grantCredits) {
      return { kind: "already_settled" } as const;
    }
    if (
      !["confirmed", "partial_refunded"].includes(payment.status) ||
      refundedKopecks >= paidKopecks ||
      clawedCredits > grantCredits
    ) {
      return { kind: "not_found" } as const;
    }

    const settledRefundKopecks = paidKopecks - refundedKopecks;
    const targetClaw = grantCredits;
    const delta = targetClaw - clawedCredits;
    const paygBefore = toSafeInteger(org.payg_credits, "payg_credits");
    const paygRemovedCredits = Math.min(paygBefore, delta);
    const debtAddedCredits = delta - paygRemovedCredits;
    const claimId = payment.refund_claim_id;
    const claimedKopecks =
      payment.refund_claim_kopecks === null
        ? settledRefundKopecks
        : toSafeInteger(payment.refund_claim_kopecks, "refund_claim_kopecks");
    const requestId = claimId
      ? `refund:claim:${claimId}`
      : `refund:full:${payment.id}`;

    const orgUpdate = await tx.execute(sql`
      UPDATE organizations
      SET payg_credits = GREATEST(payg_credits - ${delta}::bigint, 0),
          refund_debt_credits = refund_debt_credits +
            GREATEST(${delta}::bigint - payg_credits, 0),
          updated_at = NOW()
      WHERE id = ${hint.topup_org_id}::uuid
        AND payg_credits >= 0
        AND refund_debt_credits >= 0
      RETURNING id
    `);
    if (rowsOf<{ id: string }>(orgUpdate).length !== 1) {
      throw new Error("full refund organization update failed");
    }

    const paymentUpdate = await tx.execute(sql`
      UPDATE payments
      SET topup_refunded_kopecks = ${paidKopecks}::bigint,
          topup_clawed_credits = ${targetClaw}::bigint,
          refunded_amount = ${paidKopecks}::numeric / 100,
          refunded_at = NOW(),
          status = 'refunded',
          refund_claim_id = NULL,
          refund_claim_kopecks = NULL,
          refund_claimed_at = NULL,
          refund_provider_key = NULL,
          refund_method_route = NULL,
          refund_method_source = NULL,
          refund_receipt_mode = NULL,
          refund_dispatched_at = NULL,
          updated_at = NOW()
      WHERE id = ${payment.id}::uuid
        AND topup_org_id = ${hint.topup_org_id}::uuid
        AND topup_refunded_kopecks = ${refundedKopecks}::bigint
        AND topup_clawed_credits = ${clawedCredits}::bigint
        AND refund_claim_id IS NOT DISTINCT FROM ${claimId}::uuid
      RETURNING id
    `);
    if (rowsOf<{ id: string }>(paymentUpdate).length !== 1) {
      throw new Error("full refund payment update failed");
    }

    const receiptInsert = await tx.execute(sql`
      INSERT INTO gateway_transactions (
        org_id, request_id, type, source, delta, metadata, created_at
      ) VALUES (
        ${hint.topup_org_id}::uuid,
        ${requestId},
        'refund',
        'payg',
        ${-delta}::bigint,
        jsonb_build_object(
          'payment_id', ${payment.id}::text,
          'claim_id', ${claimId}::text,
          'provider_key', ${payment.refund_provider_key}::text,
          'requested_kopecks', ${claimedKopecks}::bigint,
          'settled_refund_kopecks', ${settledRefundKopecks}::bigint,
          'cumulative_refunded_kopecks', ${paidKopecks}::bigint,
          'cumulative_clawed_credits', ${targetClaw}::bigint,
          'payg_removed_credits', ${paygRemovedCredits}::bigint,
          'debt_added_credits', ${debtAddedCredits}::bigint,
          'resolved_by', 'full_webhook',
          'webhook_identity', jsonb_build_object(
            'provider', ${identity.provider}::text,
            'providerPaymentId', ${identity.providerPaymentId}::text,
            'providerOrderId', ${identity.providerOrderId}::text
          )
        ),
        NOW()
      )
      ON CONFLICT (request_id, source) WHERE type = 'refund'
      DO NOTHING
      RETURNING id
    `);
    if (rowsOf<{ id: string }>(receiptInsert).length !== 1) {
      throw new Error("full refund receipt insert failed");
    }

    return {
      kind: "settled",
      refundedKopecks: paidKopecks,
      clawedCredits: targetClaw,
      paygRemovedCredits,
      debtAddedCredits,
    } as const;
  });
}
