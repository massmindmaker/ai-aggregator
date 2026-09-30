import { NextRequest, NextResponse } from 'next/server';
import { db, sql } from '@/lib/db';
import { requireAdmin, audit, AdminAuthError } from '@/lib/admin/guard';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const { user: admin } = await requireAdmin();
    const body = (await req.json()) as { userIds?: string[] };
    const ids = body.userIds ?? [];
    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: 'NO_IDS' }, { status: 400 });
    }

    let created = 0;
    let skippedUnverifiedKyc = 0;
    for (const userId of ids) {
      // F-1 (security review): this route never looked at KYC, so an author
      // with kyc_status='none'/'rejected' could still be batched into a
      // 'processing' payout (and its accruals locked) — the batch was created
      // before approve's gate ever ran. Same rule as approve: only a verified
      // KYC with a kyc_type may enter the payout pipeline. The check lives in
      // the same statement as the INSERT so the author cannot race an update.
      const result = await db.execute(sql`
        WITH eligible_author AS (
          SELECT 1 FROM users
          WHERE id = ${userId}::uuid
            AND kyc_status = 'verified'
            AND kyc_type IS NOT NULL
        ),
        agg AS (
          SELECT COALESCE(SUM(author_share_rub), 0)::numeric AS total,
                 MIN(period_month) AS min_p, MAX(period_month) AS max_p
          FROM author_earnings WHERE author_id = ${userId} AND status = 'accruing'
        )
        INSERT INTO payouts (user_id, amount, currency, status, period_start, period_end, metadata)
        SELECT ${userId}::uuid, total, 'RUB', 'processing',
               COALESCE(min_p::timestamp, NOW()), COALESCE(max_p::timestamp, NOW()),
               jsonb_build_object('initiated_by', ${admin.email}, 'bulk', true)
        FROM agg, eligible_author WHERE total > 0
        RETURNING id::text
      `);
      const rows = (result as unknown as { rows?: unknown[] }).rows ?? result;
      if (Array.isArray(rows) && rows.length > 0) {
        created++;
        // Lock the earnings so they're not double-paid
        await db.execute(sql`
          UPDATE author_earnings SET status = 'locked'
          WHERE author_id = ${userId} AND status = 'accruing'
        `);
        await audit(admin.email, 'payout.process', 'user', userId, {});
      } else {
        // Either nothing to pay or the author is not KYC-verified; both must
        // leave an audit trail so a silent skip is not mistaken for a payout.
        skippedUnverifiedKyc++;
        await audit(admin.email, 'payout.process_skipped', 'user', userId, {
          reason: 'kyc_not_verified_or_no_accruals',
        });
      }
    }

    return NextResponse.json({ ok: true, created, skipped: skippedUnverifiedKyc });
  } catch (e) {
    if (e instanceof AdminAuthError) {
      return NextResponse.json({ error: e.code }, { status: e.code === 'UNAUTHORIZED' ? 401 : 403 });
    }
    console.error(e);
    return NextResponse.json({ error: 'INTERNAL', message: (e as Error).message }, { status: 500 });
  }
}
