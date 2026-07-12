import { NextRequest, NextResponse } from 'next/server';
import { tinkoff } from '@/lib/tinkoff';
import { db } from '@/lib/db';
import { eq, and, ne, sql } from '@aiag/database';
import { payments, subscriptions, balanceTransactions, users } from '@aiag/database/schema';
import type { WebhookNotification } from '@aiag/tinkoff';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const payload = (await request.json()) as WebhookNotification;

    // Verify webhook signature (Tinkoff HMAC token, see @aiag/tinkoff). Never
    // trust an unsigned callback with money-moving side effects.
    const webhookData = tinkoff.parseWebhook(payload);

    if (!webhookData.isValid) {
      console.error('Invalid Tinkoff webhook signature');
      return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
    }

    // Find payment by Tinkoff payment ID
    const payment = await db.query.payments.findFirst({
      where: eq(payments.tinkoffPaymentId, webhookData.paymentId),
    });

    if (!payment) {
      console.error('Payment not found:', webhookData.paymentId);
      return NextResponse.json({ error: 'Payment not found' }, { status: 404 });
    }

    const isConfirming = webhookData.success && webhookData.status === 'CONFIRMED';

    if (isConfirming) {
      // Idempotent credit path. Bank retries a CONFIRMED callback until it
      // gets a 2xx (and can also fire concurrently) — the guarded
      // UPDATE ... WHERE status <> 'confirmed' ... RETURNING is the atomic
      // gate: only the delivery that actually flips the row to 'confirmed'
      // proceeds to credit the balance below. Under Postgres READ COMMITTED,
      // a concurrent UPDATE on the same row blocks on the row lock until the
      // first commits, then re-evaluates the WHERE against the now-committed
      // row and returns 0 rows — so every retry/duplicate/parallel delivery
      // after the first is a guaranteed no-op. Everything (gate + credit +
      // ledger insert) runs in one transaction so a failure after the gate
      // rolls back the status flip too (the bank will retry, and the retry
      // will see status still not 'confirmed' and can succeed cleanly).
      await (db as unknown as {
        transaction: <T>(fn: (tx: typeof db) => Promise<T>) => Promise<T>;
      }).transaction(async (tx) => {
        const [confirmed] = await tx
          .update(payments)
          .set({
            status: 'confirmed',
            tinkoffStatus: webhookData.status,
            cardPan: webhookData.cardPan,
            tinkoffRebillId: webhookData.rebillId,
            confirmedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(eq(payments.id, payment.id), ne(payments.status, 'confirmed')))
          .returning();

        if (!confirmed) {
          // Already confirmed by an earlier delivery of this same webhook —
          // this is exactly what makes repeated CONFIRMED callbacks safe.
          console.log('[webhook/tinkoff] duplicate CONFIRMED, already settled', {
            paymentId: payment.id,
          });
          return;
        }

        // Explicit, unambiguous fork on payment type. A payment with a
        // subscriptionId is a TIER purchase -> activate the tier (grant the
        // tier's credit allowance, NOT the ruble sum). Anything else is a
        // balance top-up -> credit users.balance in rubles.
        if (confirmed.subscriptionId) {
          await activateSubscriptionTier(tx, confirmed, webhookData);
        } else {
          await creditBalance(tx, confirmed, webhookData);
        }
      });
    } else {
      // Non-credit status transitions (pending/authorized/rejected/etc.) —
      // bookkeeping only, no money moves.
      const newStatus = mapTinkoffStatus(webhookData.status);
      await db
        .update(payments)
        .set({
          status: newStatus,
          tinkoffStatus: webhookData.status,
          cardPan: webhookData.cardPan,
          tinkoffRebillId: webhookData.rebillId,
          updatedAt: new Date(),
        })
        .where(eq(payments.id, payment.id));

      if (webhookData.status === 'REFUNDED' || webhookData.status === 'PARTIAL_REFUNDED') {
        await handleRefund(payment.id, webhookData);
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Tinkoff webhook error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

function mapTinkoffStatus(tinkoffStatus: string): 'pending' | 'authorized' | 'confirmed' | 'refunded' | 'partial_refunded' | 'cancelled' | 'rejected' | 'failed' {
  const statusMap: Record<string, 'pending' | 'authorized' | 'confirmed' | 'refunded' | 'partial_refunded' | 'cancelled' | 'rejected' | 'failed'> = {
    NEW: 'pending',
    FORM_SHOWED: 'pending',
    AUTHORIZING: 'pending',
    AUTHORIZED: 'authorized',
    CONFIRMING: 'pending',
    CONFIRMED: 'confirmed',
    REVERSING: 'pending',
    PARTIAL_REVERSED: 'partial_refunded',
    REVERSED: 'refunded',
    REFUNDING: 'pending',
    PARTIAL_REFUNDED: 'partial_refunded',
    REFUNDED: 'refunded',
    REJECTED: 'rejected',
    CANCELED: 'cancelled',
    DEADLINE_EXPIRED: 'cancelled',
    AUTH_FAIL: 'failed',
  };

  return statusMap[tinkoffStatus] || 'pending';
}

/**
 * TOPUP path. Runs INSIDE the transaction opened by the guarded gate above —
 * `tx` already proved this payment just transitioned into 'confirmed' for the
 * first time, so this runs at most once per payment, ever. Credits the ruble
 * sum into the user's pay-per-use balance.
 */
async function creditBalance(
  tx: typeof db,
  payment: typeof payments.$inferSelect,
  webhookData: ReturnType<typeof tinkoff.parseWebhook>
) {
  const amountStr = webhookData.amount.toString();

  // Atomic increment (`UPDATE ... SET balance = balance + $amount ... RETURNING`)
  // instead of read-then-write: two different CONFIRMED payments for the same
  // user settling concurrently must not lose an update. `balance` is stored as
  // `text` (see schema/users.ts), hence the explicit ::numeric round-trip.
  const [updatedUser] = await tx
    .update(users)
    .set({
      balance: sql`(COALESCE(${users.balance}, '0')::numeric + ${amountStr}::numeric)::text`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, payment.userId))
    .returning({ balance: users.balance });

  if (!updatedUser) {
    console.error('[webhook/tinkoff] user not found for payment', {
      paymentId: payment.id,
      userId: payment.userId,
    });
    return;
  }

  const balanceAfter = parseFloat(updatedUser.balance || '0');
  const balanceBefore = balanceAfter - webhookData.amount;

  // Belt-and-suspenders: UNIQUE(payment_id, type) on balance_transactions
  // (migration 0053) makes a second 'deposit' row for the same payment a DB
  // error, not silent data — so even a bug in the gate above can't double-credit.
  await tx.insert(balanceTransactions).values({
    userId: payment.userId,
    paymentId: payment.id,
    type: 'deposit',
    amount: amountStr,
    balanceBefore: balanceBefore.toString(),
    balanceAfter: balanceAfter.toString(),
    description: 'Payment deposit',
    referenceType: 'payment',
    referenceId: payment.id,
  });
}

/**
 * TIER (subscription) path. Runs INSIDE the same guarded transaction, so it
 * fires at most once per payment. Flips the pending subscription to active,
 * sets the billing period (month/year from the payment metadata), binds the
 * rebillId for future recurring charges, and resets the period's credit
 * counter. It does NOT touch users.balance — a tier grants credits
 * (subscriptions.credits_limit, set at creation from TIERS[tier].credits), not
 * spendable rubles.
 */
async function activateSubscriptionTier(
  tx: typeof db,
  payment: typeof payments.$inferSelect,
  webhookData: ReturnType<typeof tinkoff.parseWebhook>
) {
  const yearly = (payment.metadata as { billing?: string } | null)?.billing === 'yearly';
  const now = new Date();
  const periodEnd = yearly
    ? new Date(now.getFullYear() + 1, now.getMonth(), now.getDate())
    : new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());

  // Guarded UPDATE: only flips a subscription that is not already active. Even
  // though the payment gate already guarantees single execution, this keeps the
  // tier activation itself idempotent and self-describing. credits_limit was
  // set from TIERS at creation; we grant a fresh period by zeroing usage.
  await tx
    .update(subscriptions)
    .set({
      status: 'active',
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      tinkoffRebillId: webhookData.rebillId,
      creditsUsed: 0,
      usedRequests: 0,
      usedTokens: 0,
      updatedAt: now,
    })
    .where(and(eq(subscriptions.id, payment.subscriptionId!), ne(subscriptions.status, 'active')));

  // TODO (recurring renewal): webhookData.rebillId is now bound to the
  // subscription; a scheduled job charging it each period to renew the tier is
  // a separate build and intentionally not implemented here. First payment
  // yields a working active tier, which is the requirement.
}

async function handleRefund(
  paymentId: string,
  webhookData: ReturnType<typeof tinkoff.parseWebhook>
) {
  await db
    .update(payments)
    .set({
      refundedAt: new Date(),
      refundedAmount: webhookData.amount.toString(),
      updatedAt: new Date(),
    })
    .where(eq(payments.id, paymentId));
}
