import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, audit, AdminAuthError } from '@/lib/admin/guard';
import { walletDatabase } from '@/lib/ton-wallet/service';
import { resolveTonReviewDecision } from '@aiag/database';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface DecisionBody {
  eventId?: string;
  action?: 'acknowledge_no_credit' | 'retry_settle';
}

/**
 * POST /api/admin/ton/review/[id] — append-only operator decision on a
 * review_required invoice (task 4.1). Money is never moved here: acknowledge
 * is the terminal no-credit verdict; retry only schedules the worker's
 * re-evaluation on its next sweep (durable-but-re-evaluable reviews, 0101).
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  let adminEmail: string;
  try {
    const { user } = await requireAdmin();
    adminEmail = user.email;
  } catch (caught) {
    if (caught instanceof AdminAuthError) {
      return NextResponse.json(
        { error: caught.code },
        { status: caught.code === 'UNAUTHORIZED' ? 401 : 403 },
      );
    }
    throw caught;
  }
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as DecisionBody;
  if (!id || !body.eventId || (body.action !== 'acknowledge_no_credit' && body.action !== 'retry_settle')) {
    return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 400 });
  }
  try {
    const outcome = await resolveTonReviewDecision(walletDatabase, {
      invoiceId: id,
      eventId: body.eventId,
      actor: adminEmail,
      action: body.action,
    });
    await audit(adminEmail, `ton.review.${body.action}`, 'ton_invoice', id, { eventId: body.eventId });
    return NextResponse.json({ outcome });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : 'TON_REVIEW_FAILED';
    if (message === 'TON_REVIEW_TARGET_INVALID' || message === 'TON_REVIEW_ACTOR_INVALID') {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    throw caught;
  }
}
