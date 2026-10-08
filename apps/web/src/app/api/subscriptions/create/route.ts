import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getPaymentProvider, getTier, type ProviderId } from '@/lib/payments/providers';
import { db } from '@/lib/db';
import { payments, subscriptions } from '@aiag/database/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CreateSubBody {
  tierId?: string;          // 'basic' | 'starter' | 'pro'
  yearly?: boolean;
  provider?: ProviderId;    // 'tinkoff' | 'yookassa' | 'sbp'
  email?: string;
  phone?: string;
}

/**
 * POST /api/subscriptions/create
 *
 * Sells a TIER (Basic/Starter/Pro — see TIERS in lib/payments/providers.ts).
 * Creates a *pending* `subscriptions` row (plan_name + credits_limit from the
 * tier) and a *pending* `payments` row linked to it via `subscriptionId`, then
 * inits the provider payment. For Tinkoff, `/api/webhooks/tinkoff` matches the
 * CONFIRMED callback to the payment by `tinkoff_payment_id` and — because the
 * payment carries a `subscriptionId` — ACTIVATES the tier (subscription ->
 * active, credits granted) instead of crediting rubles into the balance.
 *
 * TODO (recurring): the first payment binds `rebillId`; charging it monthly to
 * renew the tier is a separate build (not implemented here).
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json(
      { error: { message: 'Требуется вход', code: 'UNAUTHORIZED' } },
      { status: 401 }
    );
  }

  // TON-only launch (plan task 5.1): card rails live only when the deploy
  // explicitly configures them; without fiat env the only rail is TON.
  if (!process.env.TINKOFF_TERMINAL_KEY && !process.env.YOOKASSA_SHOP_ID) {
    return NextResponse.json(
      {
        error: {
          message: 'Оплата сейчас доступна только в TON (Gram) — пополните баланс криптокошельком',
          code: 'ton_only',
        },
      },
      { status: 503 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as CreateSubBody;
  // No tier in TIERS has monthly === 0 (Free tier removed — founder 2026-07-17,
  // see /CLAUDE.md founder decisions). getTier('free') now returns null, same
  // as any other bogus id, and falls into the Unknown-tier 400 below.
  const tier = getTier(body.tierId || '');
  if (!tier) {
    return NextResponse.json(
      { error: { message: 'Unknown tier', code: 'BAD_TIER' } },
      { status: 400 }
    );
  }

  const userId = (session.user as { id?: string }).id;
  if (!userId) {
    return NextResponse.json(
      { error: { message: 'Invalid session', code: 'NO_USER_ID' } },
      { status: 401 }
    );
  }

  const providerId: ProviderId = body.provider || 'tinkoff';
  const provider = getPaymentProvider(providerId);

  const amount = body.yearly ? tier.yearly : tier.monthly;
  // tier.credits is a MONTHLY allotment (see TIERS docblock + the pricing page,
  // which literally labels it "N кредитов / мес" for both billing toggles —
  // apps/web/src/app/pricing/PricingClient.tsx:36,52,70). The webhook grants
  // this as a single lump sum for the whole active period and activates a
  // 12-month period for yearly (see activateSubscriptionTier in
  // api/webhooks/tinkoff/route.ts: periodEnd = +1 year vs +1 month), so a flat
  // `tier.credits` here previously gave a yearly buyer 1 month of credits for a
  // 12-month-long subscription. All 3 TIERS price yearly at exactly 10×
  // monthly (basic 990→9900, starter 2490→24900, pro 6990→69900) — the
  // standard "pay for 10, get 12" annual discount — so credits must scale ×12
  // (not ×10) to match the 12-month period and honor the "credits/month" promise
  // on the pricing page for every month of that period.
  const credits = body.yearly ? tier.credits * 12 : tier.credits;
  const orderId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://ai-aggregator.ru';
  const description = `Подписка ${tier.name} (${body.yearly ? 'год' : 'месяц'})`;

  const result = await provider.initPayment({
    orderId,
    amountRub: amount,
    description,
    returnUrl: `${baseUrl}/dashboard/billing?status=success&order=${orderId}`,
    // Tinkoff → the real webhook that persists+settles (see /api/webhooks/tinkoff).
    // yookassa/sbp still land on the provider-agnostic stub (unchanged, out of
    // scope here) — see /api/subscriptions/webhook/[provider].
    notificationUrl:
      providerId === 'tinkoff'
        ? `${baseUrl}/api/webhooks/tinkoff`
        : `${baseUrl}/api/subscriptions/webhook/${providerId}`,
    email: body.email || (session.user as { email?: string }).email,
    phone: body.phone,
    metadata: {
      user_id: userId,
      tier_id: body.tierId!,
      billing: body.yearly ? 'yearly' : 'monthly',
    },
    recurrent: !body.yearly, // monthly → enable recurring rebill
  });

  if (!result.success) {
    // Same honesty rule as /api/payments/topup: an Init rejection is a
    // provider/config problem (e.g. missing terminal credentials on this
    // environment), not invalid user input — never surface the raw upstream
    // error text (it can read like "неверные параметры" and wrongly blame
    // the user). Log it server-side instead.
    // eslint-disable-next-line no-console
    console.error('[subscriptions/create] provider init failed', {
      provider: providerId,
      errorMessage: result.errorMessage,
    });
    return NextResponse.json(
      {
        error: {
          message: 'Оплата временно недоступна, попробуйте позже',
          code: 'PROVIDER_UNAVAILABLE',
        },
      },
      { status: 503 }
    );
  }

  // Persist a pending subscription (the TIER the user is buying) + a pending
  // payment linked to it, atomically. The webhook matches on tinkoff_payment_id
  // and activates the tier via payments.subscriptionId — without these rows a
  // real CONFIRMED callback 404s and the money is lost. modelId stays NULL: a
  // tier is not model-scoped (migration 0054). Period fields are placeholders
  // (now/now) until the webhook sets the real active period on CONFIRMED.
  const now = new Date();
  await (db as unknown as {
    transaction: <T>(fn: (tx: typeof db) => Promise<T>) => Promise<T>;
  }).transaction(async (tx) => {
    const [sub] = await tx
      .insert(subscriptions)
      .values({
        userId,
        status: 'pending',
        planName: tier.name,
        creditsLimit: credits,
        creditsUsed: 0,
        currentPeriodStart: now,
        currentPeriodEnd: now,
      })
      .returning({ id: subscriptions.id });

    await tx.insert(payments).values({
      userId,
      subscriptionId: sub.id,
      amount: String(amount),
      currency: 'RUB',
      status: 'pending',
      tinkoffPaymentId: providerId === 'tinkoff' ? result.providerPaymentId : undefined,
      tinkoffOrderId: orderId,
      paymentMethod: providerId,
      description,
      metadata: {
        kind: 'subscription',
        tier_id: body.tierId,
        billing: body.yearly ? 'yearly' : 'monthly',
        provider: providerId,
      },
    });
  });

  return NextResponse.json({
    success: true,
    orderId,
    paymentId: result.providerPaymentId,
    paymentUrl: result.paymentUrl,
    qrPayload: result.qrPayload,
    provider: providerId,
    amount,
    tier: tier.name,
  });
}
