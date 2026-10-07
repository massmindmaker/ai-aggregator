import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getPaymentProvider, type ProviderId } from '@/lib/payments/providers';
import { db } from '@/lib/db';
import { payments } from '@aiag/database/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface TopupBody {
  amountRub?: number;
  provider?: ProviderId;
  email?: string;
  phone?: string;
}

const MIN_TOPUP = 100;     // 100 ₽
const MAX_TOPUP = 100000;  // 100 000 ₽ — single-shot guardrail

/**
 * POST /api/payments/topup
 *
 * Pay-per-use balance top-up. For Tinkoff, `/api/webhooks/tinkoff` is the live
 * handler: it matches the callback to the `payments` row inserted below (by
 * `tinkoff_payment_id`) and credits `users.balance` idempotently on CONFIRMED.
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
          message: 'Оплата сейчас доступна только в TON — пополните баланс кошельком Toncoin',
          code: 'ton_only',
        },
      },
      { status: 503 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as TopupBody;
  const amount = Number(body.amountRub);
  if (!Number.isFinite(amount) || amount < MIN_TOPUP || amount > MAX_TOPUP) {
    return NextResponse.json(
      {
        error: {
          message: `Сумма должна быть от ${MIN_TOPUP} до ${MAX_TOPUP} ₽`,
          code: 'BAD_AMOUNT',
        },
      },
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
  const orderId = `topup_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://ai-aggregator.ru';
  const description = `Пополнение баланса AIAG: ${amount} ₽`;

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
      kind: 'topup',
    },
  });

  if (!result.success) {
    // The upstream provider (Tinkoff/YooKassa) rejected Init — most commonly
    // because the provider isn't configured on this environment (missing
    // terminal/secret) rather than anything the user did wrong. Log the raw
    // provider error for debugging, but never surface it to the user — it
    // leaks provider internals and wrongly implies a user input mistake.
    // eslint-disable-next-line no-console
    console.error('[payments/topup] provider init failed', {
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

  // Persist the pending payment now — the webhook matches purely on
  // tinkoff_payment_id, so without this row a real CONFIRMED callback 404s
  // and the money is lost (see fix/rub-payments-tinkoff).
  await db.insert(payments).values({
    userId,
    amount: String(amount),
    currency: 'RUB',
    status: 'pending',
    tinkoffPaymentId: providerId === 'tinkoff' ? result.providerPaymentId : undefined,
    tinkoffOrderId: orderId,
    paymentMethod: providerId,
    description,
    metadata: {
      kind: 'topup',
      provider: providerId,
    },
  });

  return NextResponse.json({
    success: true,
    orderId,
    paymentId: result.providerPaymentId,
    paymentUrl: result.paymentUrl,
    qrPayload: result.qrPayload,
    provider: providerId,
    amount,
  });
}
