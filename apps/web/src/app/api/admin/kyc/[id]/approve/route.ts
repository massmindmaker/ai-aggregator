import { NextResponse } from 'next/server';
import { db, sql } from '@/lib/db';
import { withAdmin } from '@/lib/admin/api';
import { audit } from '@/lib/admin/guard';
import { rowsOf } from '@/lib/admin/rows';

const REQUIRED_DOCS: Record<string, string[]> = {
  self_employed: ['self_employed_certificate', 'inn_certificate'],
  ip: ['ip_egrip', 'inn_certificate'],
  individual: ['passport_main', 'passport_registration', 'inn_certificate'],
};

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return withAdmin(async ({ user }) => {
    const { id } = await params;

    const doc = rowsOf<{
      id: string;
      user_id: string;
      status: string;
      doc_type: string;
      kyc_type: string | null;
    }>(
      await db.execute(sql`
        SELECT d.id::text, d.user_id::text, d.status, d.doc_type, u.kyc_type
        FROM kyc_documents d
        JOIN users u ON u.id = d.user_id
        WHERE d.id = ${id}::uuid
      `)
    )[0];

    if (!doc) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    if (doc.status === 'approved') {
      return NextResponse.json({ error: 'IDEMPOTENT_NOOP' }, { status: 409 });
    }

    // Approve this doc atomically
    await db.execute(sql`
      UPDATE kyc_documents
      SET status = 'approved',
          reviewed_at = NOW(),
          reviewed_by = (SELECT id FROM users WHERE email = ${user.email}),
          rejection_reason = NULL
      WHERE id = ${id}::uuid
    `);

    let promoted = false;
    if (doc.kyc_type && REQUIRED_DOCS[doc.kyc_type]) {
      const required = REQUIRED_DOCS[doc.kyc_type];
      const approvedDocs = rowsOf<{ doc_type: string }>(
        await db.execute(sql`
          SELECT DISTINCT doc_type FROM kyc_documents
          WHERE user_id = ${doc.user_id}::uuid AND status = 'approved'
        `)
      ).map((r) => r.doc_type);
      const allOk = required.every((t) => approvedDocs.includes(t));
      if (allOk) {
        await db.execute(sql`
          UPDATE users
          SET kyc_status='verified', kyc_verified_at=NOW()
          WHERE id = ${doc.user_id}::uuid
        `);
        promoted = true;
      } else {
        // First doc approved while still 'none' → bump to 'pending' for visibility
        const stillNone = rowsOf(
          await db.execute(sql`
            SELECT 1 FROM users WHERE id = ${doc.user_id}::uuid AND kyc_status='none'
          `)
        );
        if (stillNone.length > 0) {
          await db.execute(sql`
            UPDATE users SET kyc_status='pending'
            WHERE id = ${doc.user_id}::uuid AND kyc_status='none'
          `);
        }
      }
    }

    await audit(user.email!, 'kyc.approve_doc', 'kyc_document', id, {
      doc_type: doc.doc_type,
      user_id: doc.user_id,
      promoted_to_verified: promoted,
    });

    return NextResponse.json({ ok: true, promoted });
  });
}
