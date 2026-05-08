import { NextResponse } from 'next/server';
import { db, sql } from '@/lib/db';
import { withAdmin } from '@/lib/admin/api';
import { audit } from '@/lib/admin/guard';
import { rowsOf } from '@/lib/admin/rows';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return withAdmin(async ({ user }) => {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const reason = (body as { reason?: unknown }).reason;
    if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
      return NextResponse.json({ error: 'REASON_REQUIRED' }, { status: 400 });
    }

    const doc = rowsOf<{ id: string; user_id: string; status: string }>(
      await db.execute(sql`
        SELECT id::text, user_id::text, status
        FROM kyc_documents
        WHERE id = ${id}::uuid
      `)
    )[0];
    if (!doc) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    if (doc.status === 'rejected') {
      return NextResponse.json({ error: 'IDEMPOTENT_NOOP' }, { status: 409 });
    }

    await db.execute(sql`
      UPDATE kyc_documents
      SET status='rejected',
          reviewed_at=NOW(),
          reviewed_by=(SELECT id FROM users WHERE email = ${user.email}),
          rejection_reason=${reason}
      WHERE id = ${id}::uuid
    `);
    await db.execute(sql`
      UPDATE users SET kyc_status='rejected' WHERE id = ${doc.user_id}::uuid
    `);

    await audit(user.email!, 'kyc.reject_doc', 'kyc_document', id, {
      reason,
      user_id: doc.user_id,
    });

    return NextResponse.json({ ok: true });
  });
}
