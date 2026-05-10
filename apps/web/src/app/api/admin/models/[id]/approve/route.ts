/**
 * POST /api/admin/models/[id]/approve
 *
 * Approves an author submission from the moderation queue.
 * Allowed only from status='draft' with metadata.review_state='pending'.
 * On success: status='live', enabled=true, metadata.review_state cleared,
 * metadata.approved_at + approved_by recorded; audit_log row written.
 */
import { NextResponse } from 'next/server';
import { db, sql } from '@/lib/db';
import { withAdmin } from '@/lib/admin/api';
import { audit } from '@/lib/admin/guard';
import { rowsOf } from '@/lib/admin/rows';

interface ModelRow {
  id: string;
  slug: string;
  status: string;
  review_state: string | null;
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return withAdmin(async ({ user }) => {
    const { id } = await params;

    const m = rowsOf<ModelRow>(
      await db.execute(sql`
        SELECT id::text AS id, slug, status, metadata->>'review_state' AS review_state
        FROM models WHERE id = ${id}::uuid LIMIT 1
      `)
    )[0];
    if (!m) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    if (m.status !== 'draft' || m.review_state !== 'pending') {
      return NextResponse.json(
        { error: 'NOT_IN_REVIEW_QUEUE', status: m.status, review_state: m.review_state },
        { status: 400 }
      );
    }

    await db.execute(sql`
      UPDATE models
      SET status = 'live',
          enabled = true,
          metadata = (metadata - 'review_state')
                     || jsonb_build_object(
                       'approved_at', to_char(NOW() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                       'approved_by', ${user.email ?? null}::text
                     )
      WHERE id = ${id}::uuid
    `);

    await audit(user.email!, 'model.approve', 'model', id, { slug: m.slug });

    return NextResponse.json({ ok: true, status: 'live' });
  });
}
