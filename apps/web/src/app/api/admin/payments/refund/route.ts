import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, AdminAuthError } from '@/lib/admin/guard';
import { getPaymentProvider, type ProviderId } from '@/lib/payments/providers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface AdminRefundBody {
  paymentId?: string;          // internal payment id
  provider?: ProviderId;
  providerPaymentId?: string;  // provider-side id
  amount?: number;             // rubles
  reason?: string;
}

/**
 * POST /api/admin/payments/refund
 *
 * Admin-only manual refund. Auth (role + step-up cookie) is enforced by
 * requireAdmin() — see apps/web/src/lib/admin/guard.ts.
 *
 * TODO (Plan 04 schema):
 *   - SELECT payment (verify status='confirmed')
 *   - call provider.refund
 *   - UPDATE payments SET refundedAmount, refundedAt, refundReason, status='refunded'|'partial_refunded'
 *   - INSERT balance_transactions (type='refund')
 *   - audit_log
 */
export async function POST(req: NextRequest) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AdminAuthError) {
      return NextResponse.json({ error: e.code }, { status: e.code === 'UNAUTHORIZED' ? 401 : 403 });
    }
    throw e;
  }

  const body = (await req.json().catch(() => ({}))) as AdminRefundBody;
  if (!body.provider || !body.providerPaymentId || !body.amount) {
    return NextResponse.json(
      {
        error: {
          message: 'provider, providerPaymentId, amount обязательны',
          code: 'BAD_REQUEST',
        },
      },
      { status: 400 }
    );
  }

  const provider = getPaymentProvider(body.provider);
  const result = await provider.refund(
    body.providerPaymentId,
    body.amount,
    body.reason || 'admin_manual_refund'
  );

  if (!result.success) {
    return NextResponse.json(
      { success: false, error: result.errorMessage },
      { status: 502 }
    );
  }

  return NextResponse.json({
    success: true,
    refundId: result.providerRefundId,
    paymentId: body.paymentId,
  });
}
