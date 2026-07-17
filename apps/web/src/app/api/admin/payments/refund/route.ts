import { NextRequest, NextResponse } from 'next/server';
import { db, sql } from '@/lib/db';
import { requireAdmin, audit, AdminAuthError } from '@/lib/admin/guard';
import { firstRow } from '@/lib/admin/rows';
import {
  getPaymentProvider,
  type ProviderId,
  type PaymentProvider,
  type RefundResult,
} from '@/lib/payments/providers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface AdminRefundBody {
  paymentId?: string;          // internal payment id (uuid) — REQUIRED, idempotency key
  provider?: ProviderId;
  providerPaymentId?: string;  // provider-side id
  amount?: number;             // rubles (payments.amount is RUB numeric)
  reason?: string;
}

/**
 * POST /api/admin/payments/refund
 *
 * Admin-only manual refund. Auth (role + step-up cookie) is enforced by
 * requireAdmin() — see apps/web/src/lib/admin/guard.ts.
 *
 * MONEY-SAFETY (P0): the provider refund is IRREVERSIBLE and must fire AT MOST
 * ONCE per payment. Previously this route called the provider and persisted
 * NOTHING — so the row stayed status='confirmed' and a second click fired a
 * second real refund. Now it is an atomic claim-then-refund whose idempotency
 * key is `refunded_at IS NULL` (guarded UPDATE, NO row lock held across the
 * network call — SECURITY.md):
 *   1. validate the refund amount ≤ the stored payment amount (before claiming);
 *   2. CLAIM the payment: UPDATE … WHERE status='confirmed' AND refunded_at IS NULL.
 *      0 rows ⇒ not confirmed / already refund-claimed ⇒ 409, provider NOT called
 *      (this WHERE-guard is the lock that stops the double refund);
 *   3. call provider.refund();
 *   4. on success finalise status (refunded|partial_refunded) + refunded_amount;
 *   5. on a definitive provider failure RELEASE the claim so a retry is possible;
 *      on an INDETERMINATE provider throw keep the claim (see the catch below).
 */
export async function POST(req: NextRequest) {
  let adminEmail: string;
  try {
    const { user } = await requireAdmin();
    adminEmail = user.email;
  } catch (e) {
    if (e instanceof AdminAuthError) {
      return NextResponse.json({ error: e.code }, { status: e.code === 'UNAUTHORIZED' ? 401 : 403 });
    }
    throw e;
  }

  const body = (await req.json().catch(() => ({}))) as AdminRefundBody;

  // paymentId (internal uuid) is now REQUIRED — it is the idempotency key.
  if (!body.paymentId || !body.provider || !body.providerPaymentId) {
    return NextResponse.json(
      { error: { message: 'paymentId, provider, providerPaymentId обязательны', code: 'BAD_REQUEST' } },
      { status: 400 }
    );
  }

  // amount must be a positive, finite number (rubles). 0 / negative / NaN /
  // Infinity are all rejected here, BEFORE we touch the DB or the provider.
  const amount = body.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json(
      { error: { message: 'amount должен быть положительным числом', code: 'BAD_AMOUNT' } },
      { status: 400 }
    );
  }

  const paymentId = body.paymentId;
  const reason = body.reason || 'admin_manual_refund';

  // Resolve the provider BEFORE any DB mutation: a bad provider id fails here
  // (400) so it can never leave a claimed-but-unrefunded row behind.
  let provider: PaymentProvider;
  try {
    provider = getPaymentProvider(body.provider);
  } catch {
    return NextResponse.json({ error: { code: 'BAD_PROVIDER' } }, { status: 400 });
  }

  // Ceiling check BEFORE claiming: a refund can never exceed what was charged.
  const existing = firstRow<{ amount: string }>(
    await db.execute(sql`SELECT amount FROM payments WHERE id = ${paymentId}`)
  );
  if (!existing) {
    return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  }
  if (amount > Number(existing.amount)) {
    return NextResponse.json(
      { error: { message: 'amount превышает сумму платежа', code: 'AMOUNT_EXCEEDS' } },
      { status: 400 }
    );
  }

  // ── Atomic CLAIM (idempotency key = refunded_at IS NULL). The guarded UPDATE
  //    is the lock: a concurrent/second request matches 0 rows here and never
  //    reaches the provider, so at most ONE real refund fires per payment. ──
  const claimed = firstRow<{ id: string; amount: string; tinkoff_payment_id: string | null }>(
    await db.execute(sql`
      UPDATE payments
        SET refunded_at = NOW(), refund_reason = ${reason}
      WHERE id = ${paymentId} AND status = 'confirmed' AND refunded_at IS NULL
      RETURNING id, amount, tinkoff_payment_id
    `)
  );
  if (!claimed) {
    // Not confirmed, or already refund-claimed → do NOT touch the provider.
    return NextResponse.json({ error: 'IDEMPOTENT_NOOP' }, { status: 409 });
  }

  let result: RefundResult;
  try {
    result = await provider.refund(body.providerPaymentId, amount, reason);
  } catch (e) {
    // INDETERMINATE: the provider adapter threw (e.g. Tinkoff's client throws on
    // a non-2xx / network error and does not swallow it) — the refund MAY have
    // gone through upstream. We deliberately do NOT release the claim: keeping
    // `refunded_at` set blocks any automatic second refund. A human reconciles
    // against the provider dashboard, then either finalises or clears the claim.
    console.error('[admin/refund] provider threw after claim; claim retained for manual reconcile', e);
    return NextResponse.json({ success: false, error: 'REFUND_INDETERMINATE' }, { status: 502 });
  }

  if (!result.success) {
    // DEFINITIVE failure (provider returned success:false → nothing happened
    // upstream): RELEASE the claim so the refund can be retried.
    await db.execute(sql`
      UPDATE payments
        SET refunded_at = NULL, refund_reason = NULL
      WHERE id = ${paymentId} AND status = 'confirmed'
    `);
    return NextResponse.json({ success: false, error: result.errorMessage }, { status: 502 });
  }

  // Success: full vs partial is decided against the CLAIMED row's amount.
  const claimedAmount = Number(claimed.amount);
  const isFull = amount >= claimedAmount;
  await db.execute(sql`
    UPDATE payments
      SET status = ${isFull ? 'refunded' : 'partial_refunded'}, refunded_amount = ${amount}
    WHERE id = ${paymentId}
  `);

  await audit(adminEmail, 'payment.refund', 'payment', paymentId, {
    amountRub: amount,
    providerRefundId: result.providerRefundId,
    reason,
    full: isFull,
  });

  return NextResponse.json({
    success: true,
    refundId: result.providerRefundId,
    paymentId,
  });
}
