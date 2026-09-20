import { NextRequest, NextResponse } from "next/server";
import { db, sql } from "@/lib/db";
import { requireAdmin, audit, AdminAuthError } from "@/lib/admin/guard";
import { firstRow } from "@/lib/admin/rows";
import {
  getPaymentProvider,
  type ProviderId,
  type RefundResult,
} from "@/lib/payments/providers";
import { tinkoff } from "@/lib/tinkoff";
import {
  claimTopupRefund,
  finalizeTopupRefundProof,
  markTopupRefundDispatched,
} from "@/lib/payments/topup-refund";
import { rublesToKopecks } from "@/lib/payments/topup-confirmation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface AdminRefundBody {
  paymentId?: string;
  provider?: ProviderId;
  providerPaymentId?: string;
  amount?: number;
  reason?: string;
}

interface PaymentIdentityRow {
  id: string;
  subscription_id: string | null;
  amount: string;
  currency: string;
  status: string;
  payment_method: string | null;
  metadata: Record<string, unknown> | null;
  tinkoff_payment_id: string | null;
  tinkoff_order_id: string | null;
  topup_paid_kopecks: string | number | null;
  topup_refunded_kopecks: string | number;
  refund_claim_id: string | null;
}

function error(code: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: { code }, ...extra }, { status });
}

function providerFromPayment(payment: PaymentIdentityRow): ProviderId | null {
  const candidate = payment.metadata?.provider ?? payment.payment_method;
  return candidate === "tinkoff" ||
    candidate === "yookassa" ||
    candidate === "sbp"
    ? candidate
    : null;
}

function toNonnegativeSafeInteger(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function rublesToExactKopecks(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return null;
  const kopecks = rublesToKopecks(String(value));
  return kopecks !== null && kopecks > 0 ? kopecks : null;
}

function isTopup(payment: PaymentIdentityRow): boolean {
  // A payment with no subscription binding may have issued org credits. Treat
  // every such row as top-up-capable and fail closed inside the top-up branch.
  return payment.subscription_id === null;
}

async function refundTopup(
  payment: PaymentIdentityRow,
  requestedKopecks: number,
  adminEmail: string,
  reason: string,
) {
  const provider = providerFromPayment(payment);
  if (provider !== "tinkoff") {
    return error("TOPUP_REFUND_PROVIDER_UNSUPPORTED", 409);
  }
  if (payment.currency !== "RUB") {
    return error("TOPUP_REFUND_NOT_AVAILABLE", 409);
  }
  if (!payment.tinkoff_payment_id || !payment.tinkoff_order_id) {
    return error("TOPUP_REFUND_IDENTITY_MISSING", 409);
  }

  const paidKopecks = toNonnegativeSafeInteger(payment.topup_paid_kopecks);
  const refundedKopecks = toNonnegativeSafeInteger(
    payment.topup_refunded_kopecks,
  );
  if (paidKopecks === null || paidKopecks <= 0 || refundedKopecks === null) {
    return error("TOPUP_REFUND_SNAPSHOT_MISSING", 409);
  }
  const remainingKopecks = paidKopecks - refundedKopecks;
  if (remainingKopecks <= 0 || requestedKopecks > remainingKopecks) {
    return error("AMOUNT_EXCEEDS", 400);
  }
  if (payment.refund_claim_id) {
    return error("TOPUP_REFUND_RECONCILIATION_REQUIRED", 409, {
      state: "reconciliation_required",
    });
  }

  const method = await tinkoff.getRefundMethodContext({
    paymentId: payment.tinkoff_payment_id,
    orderId: payment.tinkoff_order_id,
  });
  if (method.kind === "indeterminate") {
    return error("TOPUP_REFUND_METHOD_INDETERMINATE", 502);
  }
  if (method.kind !== "supported") {
    return error("TOPUP_REFUND_METHOD_UNSUPPORTED", 409);
  }

  // No trusted receipt reconstruction exists for an arbitrary partial amount.
  // Refuse before persisting a claim or sending Cancel.
  if (requestedKopecks !== remainingKopecks) {
    return error("TOPUP_PARTIAL_REFUND_UNSUPPORTED", 409);
  }

  const claimResult = await claimTopupRefund(payment.id, requestedKopecks, {
    paymentId: payment.tinkoff_payment_id,
    orderId: payment.tinkoff_order_id,
    route: "ACQ",
    source: "cards",
    receiptMode: "full_no_receipt",
  });
  if (claimResult.kind !== "claimed") {
    if (claimResult.code === "CLAIM_ACTIVE") {
      return error("TOPUP_REFUND_RECONCILIATION_REQUIRED", 409, {
        state: "reconciliation_required",
      });
    }
    return error(
      claimResult.code === "UNSUPPORTED_METHOD" ||
        claimResult.code === "RECEIPT_CONTEXT_UNSUPPORTED"
        ? "TOPUP_REFUND_METHOD_UNSUPPORTED"
        : "TOPUP_REFUND_NOT_AVAILABLE",
      409,
    );
  }

  const dispatched = await markTopupRefundDispatched(claimResult.claim.claimId);
  if (dispatched.kind !== "marked") {
    // A full webhook may have settled between claim and dispatch. The CAS loss
    // is authoritative: never send Cancel after losing it.
    return error("TOPUP_REFUND_RECONCILIATION_REQUIRED", 409, {
      state: "reconciliation_required",
    });
  }

  const providerResult = await tinkoff.cancelClaimBoundRefund({
    providerKey: dispatched.claim.providerKey,
    paymentId: dispatched.claim.providerPaymentId,
    orderId: dispatched.claim.providerOrderId,
    paidKopecks: dispatched.claim.paidKopecks,
    refundedKopecks: dispatched.claim.refundedKopecks,
    requestedKopecks: dispatched.claim.requestedKopecks,
    methodContext: method.context,
  });
  if (providerResult.kind !== "settled") {
    return error("TOPUP_REFUND_RECONCILIATION_REQUIRED", 502, {
      state: "reconciliation_required",
    });
  }

  const finalized = await finalizeTopupRefundProof(
    dispatched.claim.claimId,
    providerResult.proof,
  );
  if (finalized.kind !== "settled" && finalized.kind !== "already_settled") {
    return error("TOPUP_REFUND_RECONCILIATION_REQUIRED", 502, {
      state: "reconciliation_required",
    });
  }

  await audit(adminEmail, "payment.refund", "payment", payment.id, {
    amountRub: requestedKopecks / 100,
    providerRefundId: dispatched.claim.providerKey,
    reason,
    full: true,
  });
  return NextResponse.json({
    success: true,
    refundId: dispatched.claim.providerKey,
    paymentId: payment.id,
  });
}

async function refundSubscription(
  payment: PaymentIdentityRow,
  amountRub: number,
  adminEmail: string,
  reason: string,
) {
  const providerId = providerFromPayment(payment);
  if (!providerId) return error("BAD_PROVIDER", 400);

  const providerPaymentId = payment.tinkoff_payment_id;
  if (!providerPaymentId) return error("PAYMENT_PROVIDER_ID_MISSING", 409);
  if (amountRub > Number(payment.amount)) return error("AMOUNT_EXCEEDS", 400);

  let provider;
  try {
    provider = getPaymentProvider(providerId);
  } catch {
    return error("BAD_PROVIDER", 400);
  }

  const claimed = firstRow<{ id: string; amount: string }>(
    await db.execute(sql`
      UPDATE payments
        SET refunded_at = NOW(), refund_reason = ${reason}
      WHERE id = ${payment.id} AND status = 'confirmed' AND refunded_at IS NULL
      RETURNING id, amount
    `),
  );
  if (!claimed) {
    return NextResponse.json({ error: "IDEMPOTENT_NOOP" }, { status: 409 });
  }

  let result: RefundResult;
  try {
    result = await provider.refund(providerPaymentId, amountRub, reason);
  } catch (caught) {
    console.error(
      "[admin/refund] provider threw after subscription claim; claim retained for manual reconcile",
      caught,
    );
    return NextResponse.json(
      { success: false, error: "REFUND_INDETERMINATE" },
      { status: 502 },
    );
  }

  if (!result.success) {
    await db.execute(sql`
      UPDATE payments
        SET refunded_at = NULL, refund_reason = NULL
      WHERE id = ${payment.id} AND status = 'confirmed'
    `);
    return NextResponse.json(
      { success: false, error: result.errorMessage },
      { status: 502 },
    );
  }

  const isFull = amountRub >= Number(claimed.amount);
  await db.execute(sql`
    UPDATE payments
      SET status = ${isFull ? "refunded" : "partial_refunded"}, refunded_amount = ${amountRub}
    WHERE id = ${payment.id}
  `);
  await audit(adminEmail, "payment.refund", "payment", payment.id, {
    amountRub,
    providerRefundId: result.providerRefundId,
    reason,
    full: isFull,
  });
  return NextResponse.json({
    success: true,
    refundId: result.providerRefundId,
    paymentId: payment.id,
  });
}

/** Admin-only refund. Payment/provider identity is always read from the DB. */
export async function POST(req: NextRequest) {
  let adminEmail: string;
  try {
    const { user } = await requireAdmin();
    adminEmail = user.email;
  } catch (caught) {
    if (caught instanceof AdminAuthError) {
      return NextResponse.json(
        { error: caught.code },
        { status: caught.code === "UNAUTHORIZED" ? 401 : 403 },
      );
    }
    throw caught;
  }

  const body = (await req.json().catch(() => ({}))) as AdminRefundBody;
  if (!body.paymentId) return error("BAD_REQUEST", 400);
  const requestedKopecks = rublesToExactKopecks(body.amount);
  if (requestedKopecks === null) return error("BAD_AMOUNT", 400);

  const payment = firstRow<PaymentIdentityRow>(
    await db.execute(sql`
      SELECT amount, id, subscription_id, currency, status, payment_method,
             metadata, tinkoff_payment_id, tinkoff_order_id,
             topup_paid_kopecks, topup_refunded_kopecks, refund_claim_id
      FROM payments
      WHERE id = ${body.paymentId}
    `),
  );
  if (!payment) return error("NOT_FOUND", 404);

  const dbProvider = providerFromPayment(payment);
  if (body.provider !== undefined && body.provider !== dbProvider) {
    return error("PAYMENT_IDENTITY_MISMATCH", 409);
  }
  if (
    body.providerPaymentId !== undefined &&
    body.providerPaymentId !== payment.tinkoff_payment_id
  ) {
    return error("PAYMENT_IDENTITY_MISMATCH", 409);
  }

  const reason = body.reason || "admin_manual_refund";
  if (isTopup(payment)) {
    return refundTopup(payment, requestedKopecks, adminEmail, reason);
  }
  return refundSubscription(payment, body.amount!, adminEmail, reason);
}
