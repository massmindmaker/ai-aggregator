import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, AdminAuthError } from '@/lib/admin/guard';
import { walletDatabase } from '@/lib/ton-wallet/service';
import { listTonReviewRequired } from '@aiag/database';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/admin/ton/review?limit=50 — operator queue of review_required invoices (task 4.1). */
export async function GET(req: NextRequest) {
  try {
    await requireAdmin();
  } catch (caught) {
    if (caught instanceof AdminAuthError) {
      return NextResponse.json(
        { error: caught.code },
        { status: caught.code === 'UNAUTHORIZED' ? 401 : 403 },
      );
    }
    throw caught;
  }
  const rawLimit = Number(req.nextUrl.searchParams.get('limit') ?? '50');
  const limit = Number.isSafeInteger(rawLimit) && rawLimit > 0 && rawLimit <= 200 ? rawLimit : 50;
  const invoices = await listTonReviewRequired(walletDatabase, limit);
  return NextResponse.json({ invoices });
}
