/** Legacy catalog approval; authored versions use a separate reviewed lifecycle. */
import { NextResponse } from 'next/server';
import { db, sql } from '@/lib/db';
import { withAdmin } from '@/lib/admin/api';
import { rowsOf } from '@/lib/admin/rows';

interface ModelRow {
  id: string;
  slug: string;
  status: string;
  review_state: string | null;
  author_user_id: string | null;
  has_author_version: boolean;
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAdmin(async ({ user }) => {
    const { id } = await params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return NextResponse.json({ error: 'INVALID_MODEL_ID' }, { status: 400 });
    }
    return db.transaction(async (tx) => {
      const model = rowsOf<ModelRow>(await tx.execute(sql`
        SELECT m.id::text AS id, m.slug, m.status,
               m.metadata->>'review_state' AS review_state, m.author_user_id::text,
               EXISTS (SELECT 1 FROM author_model_versions v WHERE v.model_id=m.id) AS has_author_version
        FROM models m WHERE m.id=${id}::uuid LIMIT 1 FOR UPDATE OF m
      `))[0];
      if (!model) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
      if (model.author_user_id !== null || model.has_author_version) {
        return NextResponse.json({ error: 'AUTHOR_VERSION_REVIEW_REQUIRED' }, { status: 409 });
      }
      if (model.status !== 'draft' || model.review_state !== 'pending') {
        return NextResponse.json({
          error: 'NOT_IN_REVIEW_QUEUE', status: model.status, review_state: model.review_state,
        }, { status: 400 });
      }
      const updated = rowsOf<{ id: string }>(await tx.execute(sql`
        UPDATE models SET status='live', enabled=true,
          metadata=(metadata - 'review_state') || jsonb_build_object(
            'approved_at', to_char(NOW() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'approved_by', ${user.email ?? null}::text
          )
        WHERE id=${id}::uuid AND status='draft' AND metadata->>'review_state'='pending'
          AND author_user_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM author_model_versions v WHERE v.model_id=models.id)
        RETURNING id::text AS id
      `));
      if (updated.length !== 1) {
        return NextResponse.json({ error: 'MODEL_REVIEW_CONFLICT' }, { status: 409 });
      }
      // Mandatory audit shares the transaction; failure rolls back activation.
      await tx.execute(sql`
        INSERT INTO audit_log (actor_email, action, resource_type, resource_id, details, created_at)
        VALUES (${user.email ?? null}, 'model.approve', 'model', ${id},
                ${JSON.stringify({ slug: model.slug })}::jsonb, NOW())
      `);
      return NextResponse.json({ ok: true, status: 'live' });
    });
  });
}
