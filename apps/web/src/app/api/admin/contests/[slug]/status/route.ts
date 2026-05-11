import { NextRequest, NextResponse } from 'next/server';
import { withAdmin } from '@/lib/admin/api';
import { audit } from '@/lib/admin/guard';
import { db, sql } from '@/lib/db';
import { z } from 'zod';

export const runtime = 'nodejs';

const schema = z.object({
  status: z.enum(['draft', 'active', 'closed', 'evaluating', 'archived']),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  return withAdmin(async ({ user: admin }) => {
    const { slug } = await params;
    const body = schema.safeParse(await req.json());
    if (!body.success) {
      return NextResponse.json({ error: body.error.flatten() }, { status: 422 });
    }
    const { status } = body.data;

    // Когда переводим в active — также делаем публичным.
    const isPublicUpdate = status === 'active' ? sql`, is_public = TRUE` : sql``;

    const result = await db.execute(sql`
      UPDATE contests
      SET status = ${status}::contest_status, updated_at = NOW() ${isPublicUpdate}
      WHERE slug = ${slug}
      RETURNING id::text, slug, status::text, is_public
    `);

    const rows =
      (result as unknown as { rows?: unknown[] }).rows ??
      (result as unknown as unknown[]);
    const contest = (rows as unknown[])[0] as
      | { id: string; slug: string; status: string; is_public: boolean }
      | undefined;

    if (!contest) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }

    await audit(admin.email, 'contest.status', 'contest', slug, { status });
    return NextResponse.json({ contest });
  });
}
