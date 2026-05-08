/**
 * Phase 14-04 Task 3 — POST /api/admin/payouts/[id]/reject
 *
 * Marks a payout as 'failed' with admin_note = reason and writes an audit_log
 * entry. UPDATE + audit INSERT are wrapped in a single db.transaction (B-5)
 * so partial state cannot leak when the row is missing or already finalized.
 */
import { NextResponse } from 'next/server';
import { db, sql } from '@/lib/db';
import { withAdmin } from '@/lib/admin/api';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return withAdmin(async ({ user }) => {
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { reason?: unknown };
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason) {
      return NextResponse.json(
        { error: 'REASON_REQUIRED' },
        { status: 400 }
      );
    }

    const updated = await (db as unknown as {
      transaction: <T>(fn: (tx: typeof db) => Promise<T>) => Promise<T>;
    }).transaction(async (tx) => {
      const r = await tx.execute(sql`
        UPDATE payouts
        SET status = 'failed', admin_note = ${reason}, processed_at = NOW()
        WHERE id = ${id}::uuid AND status IN ('requested','processing')
        RETURNING id::text
      `);
      const rowCount =
        (r as { rowCount?: number }).rowCount ??
        (Array.isArray((r as { rows?: unknown[] }).rows)
          ? ((r as { rows?: unknown[] }).rows as unknown[]).length
          : Array.isArray(r)
            ? (r as unknown[]).length
            : 0);
      if (!rowCount) return false;

      await tx.execute(sql`
        INSERT INTO audit_log (actor_email, action, resource_type, resource_id, details, created_at)
        VALUES (
          ${user.email},
          'payout.reject',
          'payout',
          ${id},
          ${JSON.stringify({ reason })}::jsonb,
          NOW()
        )
      `);
      return true;
    });

    if (!updated) {
      return NextResponse.json(
        { error: 'NOT_FOUND_OR_FINAL' },
        { status: 404 }
      );
    }
    return NextResponse.json({ ok: true });
  });
}
