/**
 * POST /api/admin/models/[id]/reject
 *
 * Rejects an author submission from the moderation queue.
 * Allowed only from status='draft' with metadata.review_state='pending'.
 * Body: { reason: string } — required, surfaces to author.
 * On success: status='depublished', depublished_reason set,
 * metadata.review_state cleared; audit_log row written.
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
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return withAdmin(async ({ user }) => {
    const { id } = await params;

    let body: { reason?: unknown } = {};
    try {
      body = (await req.json()) as { reason?: unknown };
    } catch {
      /* empty */
    }
    const reason = body.reason;
    if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
      return NextResponse.json({ error: 'REASON_REQUIRED' }, { status: 400 });
    }

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
      SET status = 'depublished',
          depublished_reason = ${reason},
          metadata = metadata - 'review_state'
      WHERE id = ${id}::uuid
    `);

    await audit(user.email!, 'model.reject', 'model', id, { slug: m.slug, reason });

    return NextResponse.json({ ok: true, status: 'depublished' });
  });
}
