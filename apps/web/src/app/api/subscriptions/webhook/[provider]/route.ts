import { NextRequest, NextResponse } from 'next/server';
import { getYooKassaClient, type ProviderId } from '@/lib/payments/providers';
import { isYooKassaIp, mapYooKassaStatus } from '@aiag/yookassa';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/subscriptions/webhook/[provider]
 *
 * Provider-agnostic webhook handler.
 *
 * Tinkoff is deliberately NOT handled here anymore (fix/rub-payments-tinkoff):
 * this route used to verify the signature, `console.log`, and return "OK"
 * without ever touching the DB — a silent payment-loss trap. Both initiators
 * (`/api/subscriptions/create`, `/api/payments/topup`) now point Tinkoff's
 * `notificationUrl` at `/api/webhooks/tinkoff`, the handler that actually
 * persists + settles. A `tinkoff` callback landing here means a stale/cached
 * NotificationURL from before this fix — 410 so it fails loud, not silent.
 *
 * YooKassa: IP whitelist + re-fetch payment by id. Persist+settle is still a
 * TODO (Plan 04 schema) — out of scope for the Tinkoff money-path fix.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { provider: string } }
) {
  const provider = params.provider as ProviderId;

  if (provider === 'tinkoff') {
    return NextResponse.json(
      { error: { message: 'Moved to /api/webhooks/tinkoff', code: 'GONE' } },
      { status: 410 }
    );
  }
  if (provider === 'yookassa' || provider === 'sbp') {
    return handleYooKassaWebhook(req);
  }

  return NextResponse.json(
    { error: { message: 'Unknown provider', code: 'UNKNOWN_PROVIDER' } },
    { status: 400 }
  );
}

async function handleYooKassaWebhook(req: NextRequest) {
  // IP whitelist check (best-effort: trust X-Forwarded-For if present)
  const xff = req.headers.get('x-forwarded-for');
  const ip = (xff ? xff.split(',')[0] : null) || req.headers.get('x-real-ip') || '';
  if (process.env.YOOKASSA_ENFORCE_IP === 'true' && ip && !isYooKassaIp(ip)) {
    console.warn('[webhook/yookassa] rejected non-whitelisted IP', { ip });
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    const client = getYooKassaClient();
    const { event, object } = await client.verifyAndFetch(payload);

    const internalStatus = mapYooKassaStatus(object.status);
    console.log('[webhook/yookassa] verified', {
      event: event.event,
      paymentId: object.id,
      status: object.status,
      internal: internalStatus,
      orderId: object.metadata?.order_id,
    });

    // TODO: persist + settle credits.
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('[webhook/yookassa] verify failed', e);
    return NextResponse.json({ error: 'Verification failed' }, { status: 400 });
  }
}
