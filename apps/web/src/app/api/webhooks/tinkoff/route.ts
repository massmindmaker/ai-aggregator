import { NextRequest, NextResponse } from "next/server";
import { tinkoff } from "@/lib/tinkoff";
import { resolveTinkoffSecret, getTier } from "@/lib/payments/providers";
import { getOrCreateDefaultOrg } from "@/lib/dashboard/org";
import {
  blockUnconfirmedTopupGrantForRefund,
  calculateTopupGrantCredits,
  confirmTinkoffTopup,
  rublesToKopecks,
} from "@/lib/payments/topup-confirmation";
import { reconcileFullTopupRefund } from "@/lib/payments/topup-refund";
import { db } from "@/lib/db";
import { eq, and, inArray, sql } from "@aiag/database";
import {
  payments,
  paymentWebhookLogs,
  subscriptions,
} from "@aiag/database/schema";
import type { WebhookNotification } from "@aiag/tinkoff";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    // Fail-closed: if no terminal secret is configured, refuse to verify at all
    // rather than fall back to the guessable 'placeholder_secret' (which would
    // let a forged callback pass). A misconfigured prod must reject, not mint.
    if (!resolveTinkoffSecret()) {
      console.error(
        "[webhook/tinkoff] terminal secret not configured — rejecting",
      );
      return NextResponse.json({ error: "Not configured" }, { status: 400 });
    }

    const payload = (await request.json()) as WebhookNotification;

    // Verify webhook signature (Tinkoff HMAC token, see @aiag/tinkoff). The
    // secret is resolved via the SAME chain as Init (TINKOFF_PASSWORD ||
    // TINKOFF_SECRET_KEY) so a legitimately-signed CONFIRMED always validates.
    const webhookData = tinkoff.parseWebhook(payload);

    if (!webhookData.isValid) {
      console.error("Invalid Tinkoff webhook signature");
      return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
    }

    // Find payment by Tinkoff payment ID
    const payment = await db.query.payments.findFirst({
      where: eq(payments.tinkoffPaymentId, webhookData.paymentId),
    });

    if (!payment) {
      console.error("Payment not found:", webhookData.paymentId);
      return NextResponse.json({ error: "Payment not found" }, { status: 404 });
    }

    if (
      payment.tinkoffPaymentId !== webhookData.paymentId ||
      payment.tinkoffOrderId !== webhookData.orderId
    ) {
      await recordReconciliationFailure(
        payment.id,
        payload,
        "HIGH: provider payment/order identity mismatch",
      );
      return NextResponse.json(
        { error: "Payment identity mismatch" },
        { status: 409 },
      );
    }

    const metadata = payment.metadata as Record<string, unknown> | null;
    const isTopup =
      payment.subscriptionId === null &&
      metadata?.kind === "topup" &&
      metadata?.provider === "tinkoff";
    const isSubscription = payment.subscriptionId !== null;
    const isConfirming =
      webhookData.success && webhookData.status === "CONFIRMED";

    if (
      !webhookData.success &&
      [
        "CONFIRMED",
        "REFUNDED",
        "PARTIAL_REFUNDED",
        "REVERSED",
        "PARTIAL_REVERSED",
      ].includes(webhookData.status)
    ) {
      await recordReconciliationFailure(
        payment.id,
        payload,
        "HIGH: unsuccessful terminal money notification",
      );
      return NextResponse.json(
        { error: "Terminal notification requires reconciliation" },
        { status: 409 },
      );
    }

    if (isConfirming) {
      if (isTopup) {
        if (!Number.isSafeInteger(payload.Amount) || payload.Amount <= 0) {
          await recordReconciliationFailure(
            payment.id,
            payload,
            "HIGH: invalid signed top-up Amount",
          );
          return NextResponse.json(
            { error: "Invalid payment amount" },
            { status: 409 },
          );
        }
        const persistedKopecks = rublesToKopecks(payment.amount);
        if (persistedKopecks === null || persistedKopecks !== payload.Amount) {
          await recordReconciliationFailure(
            payment.id,
            payload,
            "HIGH: signed Amount differs from persisted RUB amount",
          );
          return NextResponse.json(
            { error: "Payment amount mismatch" },
            { status: 409 },
          );
        }
        let grantCredits: number | undefined;
        if (payment.status === "pending" || payment.status === "authorized") {
          const basic = getTier("basic");
          if (!basic) throw new Error("canonical Basic tier is unavailable");
          grantCredits = calculateTopupGrantCredits(payload.Amount, {
            priceRubles: basic.monthly,
            credits: basic.credits,
          });
        }
        const confirmation = await confirmTinkoffTopup({
          paymentId: payment.id,
          userId: payment.userId,
          providerPaymentId: webhookData.paymentId,
          providerOrderId: webhookData.orderId,
          paidKopecks: payload.Amount,
          grantCredits,
          tinkoffStatus: "CONFIRMED",
          cardPan: webhookData.cardPan,
          rebillId: webhookData.rebillId,
        });
        if (confirmation.kind === "reconciliation_required") {
          await recordReconciliationFailure(
            payment.id,
            payload,
            `HIGH: top-up confirmation CAS rejected (${confirmation.reason})`,
          );
          return NextResponse.json(
            { error: "Top-up requires reconciliation" },
            { status: 409 },
          );
        }
      } else if (isSubscription) {
        await (
          db as unknown as {
            transaction: <T>(fn: (tx: typeof db) => Promise<T>) => Promise<T>;
          }
        ).transaction(async (tx) => {
          const [confirmed] = await tx
            .update(payments)
            .set({
              status: "confirmed",
              tinkoffStatus: webhookData.status,
              cardPan: webhookData.cardPan,
              tinkoffRebillId: webhookData.rebillId,
              confirmedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(payments.id, payment.id),
                inArray(payments.status, ["pending", "authorized"]),
              ),
            )
            .returning();
          if (confirmed)
            await activateSubscriptionTier(tx, confirmed, webhookData);
        });
      } else {
        await recordReconciliationFailure(
          payment.id,
          payload,
          "HIGH: CONFIRMED payment type is ambiguous",
        );
        return NextResponse.json(
          { error: "Unsupported payment type" },
          { status: 409 },
        );
      }
    } else if (webhookData.status === "REFUNDED") {
      if (isTopup) {
        let snapshotExists = Boolean(
          payment.topupOrgId &&
          payment.topupPaidKopecks &&
          payment.topupGrantCredits,
        );
        if (!snapshotExists) {
          const block = await blockUnconfirmedTopupGrantForRefund({
            paymentId: payment.id,
            providerPaymentId: webhookData.paymentId,
            providerOrderId: webhookData.orderId,
          });
          snapshotExists = block.kind === "snapshot_exists";
        }
        if (!snapshotExists) {
          await recordReconciliationFailure(
            payment.id,
            payload,
            "HIGH: REFUNDED top-up arrived before an immutable grant snapshot",
          );
          return NextResponse.json(
            { error: "Top-up requires reconciliation" },
            { status: 409 },
          );
        }
        const outcome = await reconcileFullTopupRefund(payment.id, {
          provider: "tinkoff",
          providerPaymentId: webhookData.paymentId,
          providerOrderId: webhookData.orderId,
        });
        if (outcome.kind !== "settled" && outcome.kind !== "already_settled") {
          await recordReconciliationFailure(
            payment.id,
            payload,
            `HIGH: full top-up refund reconciliation failed (${outcome.kind})`,
          );
          return NextResponse.json(
            { error: "Top-up refund reconciliation failed" },
            { status: 409 },
          );
        }
      } else if (isSubscription) {
        await handleSubscriptionRefund(payment.id, webhookData);
      } else {
        await recordReconciliationFailure(
          payment.id,
          payload,
          "HIGH: REFUNDED payment type is ambiguous",
        );
        return NextResponse.json(
          { error: "Unsupported payment type" },
          { status: 409 },
        );
      }
    } else if (webhookData.status === "PARTIAL_REFUNDED" && isTopup) {
      if (
        !payment.topupOrgId ||
        !payment.topupPaidKopecks ||
        !payment.topupGrantCredits
      ) {
        await blockUnconfirmedTopupGrantForRefund({
          paymentId: payment.id,
          providerPaymentId: webhookData.paymentId,
          providerOrderId: webhookData.orderId,
        });
      }
      await recordReconciliationFailure(
        payment.id,
        payload,
        "HIGH: partial top-up webhook has no claim-bound operation identity",
      );
      return NextResponse.json(
        { error: "Partial refund requires reconciliation" },
        { status: 409 },
      );
    } else if (webhookData.status === "PARTIAL_REFUNDED" && isSubscription) {
      await handleSubscriptionRefund(payment.id, webhookData);
    } else if (webhookData.status === "PARTIAL_REVERSED") {
      await recordReconciliationFailure(
        payment.id,
        payload,
        "HIGH: PARTIAL_REVERSED is unsupported",
      );
      return NextResponse.json(
        { error: "Partial reversal requires reconciliation" },
        { status: 409 },
      );
    } else if (webhookData.status === "REVERSED" && isTopup) {
      if (
        payment.topupOrgId ||
        payment.topupPaidKopecks ||
        payment.topupGrantCredits
      ) {
        await recordReconciliationFailure(
          payment.id,
          payload,
          "HIGH: REVERSED contradicts an existing top-up grant snapshot",
        );
        return NextResponse.json(
          { error: "Reversal contradicts settled top-up" },
          { status: 409 },
        );
      }
      const reversed = await db
        .update(payments)
        .set({
          status: "cancelled",
          tinkoffStatus: "REVERSED",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(payments.id, payment.id),
            inArray(payments.status, ["pending", "authorized"]),
          ),
        )
        .returning({ id: payments.id });
      if (
        reversed.length === 0 &&
        !["cancelled", "rejected", "failed"].includes(payment.status)
      ) {
        await recordReconciliationFailure(
          payment.id,
          payload,
          "HIGH: REVERSED top-up has an ineligible predecessor",
        );
        return NextResponse.json(
          { error: "Reversal requires reconciliation" },
          { status: 409 },
        );
      }
    } else if (webhookData.status === "REVERSED" && isSubscription) {
      await db
        .update(payments)
        .set({
          status: "refunded",
          tinkoffStatus: "REVERSED",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(payments.id, payment.id),
            inArray(payments.status, ["pending", "authorized"]),
          ),
        );
    } else {
      await applyMonotonicTransition(payment.id, webhookData);
    }

    return new NextResponse("OK", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  } catch (error) {
    console.error("Tinkoff webhook error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

type LocalPaymentStatus = typeof payments.$inferSelect.status;

const TRANSITION_POLICY: Partial<
  Record<
    string,
    { target: LocalPaymentStatus; predecessors: LocalPaymentStatus[] }
  >
> = {
  NEW: { target: "pending", predecessors: ["pending"] },
  FORM_SHOWED: { target: "pending", predecessors: ["pending"] },
  AUTHORIZING: { target: "pending", predecessors: ["pending"] },
  CONFIRMING: { target: "pending", predecessors: ["pending"] },
  AUTHORIZED: { target: "authorized", predecessors: ["pending", "authorized"] },
  REVERSING: { target: "authorized", predecessors: ["authorized"] },
  REFUNDING: { target: "confirmed", predecessors: ["confirmed"] },
  REJECTED: { target: "rejected", predecessors: ["pending", "authorized"] },
  CANCELED: { target: "cancelled", predecessors: ["pending", "authorized"] },
  DEADLINE_EXPIRED: {
    target: "cancelled",
    predecessors: ["pending", "authorized"],
  },
  AUTH_FAIL: { target: "failed", predecessors: ["pending", "authorized"] },
  REVERSED: { target: "cancelled", predecessors: ["pending", "authorized"] },
};

async function applyMonotonicTransition(
  paymentId: string,
  webhookData: ReturnType<typeof tinkoff.parseWebhook>,
) {
  const policy = TRANSITION_POLICY[webhookData.status];
  if (!policy) return;
  await db
    .update(payments)
    .set({
      status: policy.target,
      tinkoffStatus: webhookData.status,
      cardPan: webhookData.cardPan,
      tinkoffRebillId: webhookData.rebillId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(payments.id, paymentId),
        inArray(payments.status, policy.predecessors),
      ),
    );
}

async function recordReconciliationFailure(
  paymentId: string,
  payload: WebhookNotification,
  error: string,
) {
  await db.insert(paymentWebhookLogs).values({
    paymentId,
    eventType: payload.Status,
    payload: {
      status: payload.Status,
      paymentId: String(payload.PaymentId),
      orderId: payload.OrderId,
    },
    signatureValid: "true",
    processingError: error,
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
  webhookData: ReturnType<typeof tinkoff.parseWebhook>,
) {
  const meta = payment.metadata as {
    billing?: string;
    tier_id?: string;
  } | null;
  const yearly = meta?.billing === "yearly";
  const now = new Date();
  const periodEnd = yearly
    ? new Date(now.getFullYear() + 1, now.getMonth(), now.getDate())
    : new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());

  // Guarded UPDATE: activate ONLY the pending subscription this purchase
  // created (`status = 'pending'`). Using eq('pending') — not ne('active') —
  // means a CONFIRMED callback can never resurrect a cancelled/expired
  // subscription into active. credits_limit was set from TIERS at creation; we
  // grant a fresh period by zeroing usage.
  await tx
    .update(subscriptions)
    .set({
      status: "active",
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      tinkoffRebillId: webhookData.rebillId,
      creditsUsed: 0,
      usedRequests: 0,
      usedTokens: 0,
      updatedAt: now,
    })
    .where(
      and(
        eq(subscriptions.id, payment.subscriptionId!),
        eq(subscriptions.status, "pending"),
      ),
    );

  // ─── BRIDGE: tier → gateway-spendable credits ───────────────────────────
  // Flipping the subscriptions row to active is NOT enough: the gateway debits
  // organizations.subscription_credits (BIGINT MICRO-credits), scoped by the
  // user's default org (the SAME org billing/summary shows). Without this the
  // paid tier still 402s. tier.credits is the MONTHLY allowance; a yearly
  // purchase grants 12 months up-front (the annual deal — billed at
  // tier.yearly = 10×monthly, but 12 months of credits). SET (not `+=`): a
  // fresh period REPLACES the subscription bucket — these credits do not roll
  // over — while payg_credits (a separate column) is left untouched.
  // subscription_credits_expires_at is read by the gateway to expire the bucket.
  const tier = getTier(meta?.tier_id || "");
  if (tier) {
    const grantedMicro = tier.credits * (yearly ? 12 : 1) * 1000;
    const orgId = await getOrCreateDefaultOrg(payment.userId, tx);
    await tx.execute(sql`
      UPDATE organizations
      SET subscription_credits = ${grantedMicro}::bigint,
          subscription_credits_expires_at = ${periodEnd}
      WHERE id = ${orgId}::uuid
    `);
  } else {
    // Payment metadata carried no known tier_id — can't size the grant. Do NOT
    // throw: that rolls back the whole settlement (status flip included) and
    // the bank retry would loop forever on the same bad metadata. Log for
    // reconciliation; in practice /api/subscriptions/create always sets tier_id.
    console.error(
      "[webhook/tinkoff] subscription CONFIRMED but tier_id missing/unknown — org NOT credited",
      {
        paymentId: payment.id,
        subscriptionId: payment.subscriptionId,
        tierId: meta?.tier_id,
      },
    );
  }

  // TODO (recurring renewal): webhookData.rebillId is now bound to the
  // subscription; a scheduled job charging it each period to renew the tier is
  // a separate build and intentionally not implemented here. First payment
  // yields a working active tier, which is the requirement.
}

async function handleSubscriptionRefund(
  paymentId: string,
  webhookData: ReturnType<typeof tinkoff.parseWebhook>,
) {
  await db
    .update(payments)
    .set({
      status:
        webhookData.status === "REFUNDED" ? "refunded" : "partial_refunded",
      tinkoffStatus: webhookData.status,
      refundedAt: new Date(),
      refundedAmount: webhookData.amount.toString(),
      updatedAt: new Date(),
    })
    .where(eq(payments.id, paymentId));
}
