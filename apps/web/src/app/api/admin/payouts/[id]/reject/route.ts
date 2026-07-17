/**
 * Phase 14-04 Task 3 — POST /api/admin/payouts/[id]/reject
 *
 * Marks a payout as 'failed' with error_message = reason and writes an
 * audit_log entry. UPDATE + audit INSERT are wrapped in a single
 * db.transaction (B-5) so partial state cannot leak when the row is missing
 * or already finalized.
 *
 * PROD-SCHEMA NOTE: the real `payouts` table has no `admin_note` column (the
 * migration file describing it is stale/drifted from prod) — the reject
 * reason is stored in `error_message` (a real column) and mirrored into
 * `metadata` for a structured audit trail. Prod's `status` column defaults
 * to 'pending' and has no CHECK constraint, so the guard excludes only the
 * two terminal states ('paid','failed') rather than matching a specific
 * in-flight status literal.
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
        SET status = 'failed',
            processed_at = NOW(),
            error_message = ${reason},
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'rejected_by', ${user.email}::text,
              'reject_reason', ${reason}::text
            )
        WHERE id = ${id}::uuid AND status NOT IN ('paid','failed')
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
