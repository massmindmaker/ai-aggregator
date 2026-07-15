import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getPaymentProvider } from '@/lib/payments/providers';
import { db } from '@/lib/db';
import { eq, and, ne } from '@aiag/database';
import { payments, subscriptions } from '@aiag/database/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CancelBody {
  subscriptionId?: string;
  reason?: string;
  refundAmount?: number; // optional: request an immediate refund on top of cancellation (rubles)
}

/**
 * POST /api/subscriptions/cancel
 *
 * Two DISTINCT operations, kept explicitly separate (security review 2026-07):
 *
 *  1. Plain cancellation (no `refundAmount`): deactivate the tier at the end of
 *     the already-paid period. No money moves. The subscription stays 'active'
 *     (the user keeps what they paid for until `currentPeriodEnd`) with
 *     `cancelAtPeriodEnd = true`.
 *
 *  2. Refund (`refundAmount` set): an immediate card refund AND an immediate
 *     hard-cancel (access revoked now, not at period end — money was returned).
 *
 * Ownership + payment identity are ALWAYS derived from our own DB, never from
 * the request body:
 *   - `subscriptionId` must belong to the authenticated session user.
 *   - the payment refunded is looked up as the CONFIRMED `payments` row linked
 *     to that subscription (`payments.subscriptionId`) — the client cannot name
 *     an arbitrary `providerPaymentId`/`provider` to redirect a refund at
 *     someone else's payment or at an unrelated (e.g. balance top-up) payment.
 *   - refund amount is clamped to what is actually still refundable
 *     (`amount - refundedAmount`), so it can never exceed what was paid or be
 *     replayed after a full refund already happened.
 *
 * All money-status writes use a guarded `UPDATE ... WHERE ... RETURNING`
 * (idempotency gate `status <> 'refunded'` / `status <> 'cancelled'`), matching
 * the atomic pattern used by /api/webhooks/tinkoff.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json(
      { error: { message: 'Требуется вход', code: 'UNAUTHORIZED' } },
      { status: 401 }
    );
  }

  const userId = (session.user as { id?: string }).id;
  if (!userId) {
    return NextResponse.json(
      { error: { message: 'Invalid session', code: 'NO_USER_ID' } },
      { status: 401 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as CancelBody;
  if (!body.subscriptionId) {
    return NextResponse.json(
      { error: { message: 'subscriptionId обязателен', code: 'BAD_REQUEST' } },
      { status: 400 }
    );
  }

  // Ownership guard: the subscription must belong to the caller. Looked up by
  // (id AND userId) together, not id alone — a subscription id belonging to
  // another user simply does not match and 404s.
  const subscription = await db.query.subscriptions.findFirst({
    where: and(eq(subscriptions.id, body.subscriptionId), eq(subscriptions.userId, userId)),
  });
  if (!subscription) {
    return NextResponse.json(
      { error: { message: 'Подписка не найдена', code: 'NOT_FOUND' } },
      { status: 404 }
    );
  }
  if (subscription.status === 'cancelled') {
    return NextResponse.json({
      success: true,
      subscriptionId: subscription.id,
      status: subscription.status,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      refund: null,
      message: 'Подписка уже отменена',
    });
  }

  let refundResult: { success: boolean; errorMessage?: string } | null = null;
  let refundSucceeded = false;

  if (body.refundAmount && body.refundAmount > 0) {
    // Locate the payment to refund strictly via OUR db, scoped to this
    // subscription — never trust a client-supplied providerPaymentId/provider.
    const payment = await db.query.payments.findFirst({
      where: and(eq(payments.subscriptionId, subscription.id), eq(payments.status, 'confirmed')),
    });

    if (!payment) {
      return NextResponse.json(
        { error: { message: 'Нет подтверждённого платежа для возврата', code: 'NO_REFUNDABLE_PAYMENT' } },
        { status: 400 }
      );
    }

    // Today only the Tinkoff path persists a CONFIRMED payment with a real
    // provider payment id (see /api/subscriptions/webhook/[provider] — YooKassa
    // persist+settle is a separate, not-yet-built TODO). Refuse rather than
    // guess a provider/id for anything else.
    if (payment.paymentMethod !== 'tinkoff' || !payment.tinkoffPaymentId) {
      return NextResponse.json(
        { error: { message: 'Возврат для этого провайдера не поддержан', code: 'REFUND_UNSUPPORTED_PROVIDER' } },
        { status: 400 }
      );
    }

    const totalPaid = parseFloat(payment.amount);
    const alreadyRefunded = parseFloat(payment.refundedAmount || '0');
    const refundable = totalPaid - alreadyRefunded;

    if (refundable <= 0) {
      return NextResponse.json(
        { error: { message: 'Платёж уже возвращён полностью', code: 'ALREADY_REFUNDED' } },
        { status: 409 }
      );
    }

    // Clamp to what's actually left to refund — the client's number can only
    // ever shrink the request, never grow it past what was paid.
    const requested = Math.min(body.refundAmount, refundable);

    const provider = getPaymentProvider('tinkoff');
    const providerResult = await provider.refund(
      payment.tinkoffPaymentId,
      requested,
      body.reason || 'subscription_cancel'
    );
    refundResult = { success: providerResult.success, errorMessage: providerResult.errorMessage };
    refundSucceeded = providerResult.success;

    if (providerResult.success) {
      const newRefundedAmount = alreadyRefunded + requested;
      const isFullyRefunded = newRefundedAmount >= totalPaid;

      // Guarded: only a payment still not fully 'refunded' can be updated —
      // blocks a concurrent duplicate request from double-crediting the
      // refunded-amount ledger past what the bank actually returned.
      await db
        .update(payments)
        .set({
          status: isFullyRefunded ? 'refunded' : 'partial_refunded',
          refundedAmount: newRefundedAmount.toString(),
          refundedAt: new Date(),
          refundReason: body.reason || 'subscription_cancel',
          updatedAt: new Date(),
        })
        .where(and(eq(payments.id, payment.id), ne(payments.status, 'refunded')));
    }
  }

  // Cancellation write. A plain cancel (no refund) only deactivates at period
  // end — no money moved, so the user keeps the already-paid period. A
  // successful refund additionally claws back what was granted: hard-cancel
  // now (status='cancelled') so the tier's credit grant stops immediately
  // instead of lingering until currentPeriodEnd.
  const [updated] = await db
    .update(subscriptions)
    .set({
      status: refundSucceeded ? 'cancelled' : subscription.status,
      cancelAtPeriodEnd: true,
      cancelledAt: new Date(),
      cancellationReason: body.reason || null,
      updatedAt: new Date(),
    })
    .where(and(eq(subscriptions.id, subscription.id), ne(subscriptions.status, 'cancelled')))
    .returning();

  return NextResponse.json({
    success: true,
    subscriptionId: subscription.id,
    status: updated?.status ?? subscription.status,
    cancelAtPeriodEnd: true,
    refund: refundResult,
  });
}
