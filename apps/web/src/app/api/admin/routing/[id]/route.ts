import { NextRequest, NextResponse } from 'next/server';
import { db, sql } from '@/lib/db';
import { requireAdmin, audit, AdminAuthError } from '@/lib/admin/guard';
import { firstRow } from '@/lib/admin/rows';

export const dynamic = 'force-dynamic';

// Mirrors DB constraint chk_markup_floor (migration 0047): reject sub-floor markup
// app-side so it surfaces as a clean 400, not an opaque 500 from the CHECK violation.
const MIN_MARKUP = 1.2;

function err(e: unknown) {
  if (e instanceof AdminAuthError) {
    return NextResponse.json({ error: e.code }, { status: e.code === 'UNAUTHORIZED' ? 401 : 403 });
  }
  console.error(e);
  return NextResponse.json({ error: 'INTERNAL' }, { status: 500 });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user: admin } = await requireAdmin();
    const { id } = await ctx.params;
    const body = (await req.json()) as {
      op: 'toggle' | 'setMarkup';
      enabled?: boolean;
      markup?: number;
    };

    switch (body.op) {
      case 'toggle': {
        const r = firstRow<{ id: string; enabled: boolean }>(
          await db.execute(sql`
            UPDATE model_upstreams SET enabled = ${!!body.enabled}
            WHERE id = ${id}::uuid
            RETURNING id::text AS id, enabled
          `)
        );
        if (!r) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
        await audit(admin.email, 'routing.toggle', 'model_upstream', id, {
          enabled: !!body.enabled,
        });
        return NextResponse.json({ ok: true, enabled: r.enabled });
      }
      case 'setMarkup': {
        if (typeof body.markup !== 'number' || body.markup < MIN_MARKUP) {
          return NextResponse.json(
            { error: 'BAD_MARKUP', message: 'markup must be >= 1.20' },
            { status: 400 }
          );
        }
        const r = firstRow<{ id: string }>(
          await db.execute(sql`
            UPDATE model_upstreams SET markup = ${body.markup}::numeric
            WHERE id = ${id}::uuid
            RETURNING id::text AS id
          `)
        );
        if (!r) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
        await audit(admin.email, 'routing.update_markup', 'model_upstream', id, {
          markup: body.markup,
        });
        return NextResponse.json({ ok: true });
      }
      default:
        return NextResponse.json({ error: 'UNKNOWN_OP' }, { status: 400 });
    }
  } catch (e) {
    return err(e);
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user: admin } = await requireAdmin();
    const { id } = await ctx.params;
    const r = firstRow<{ id: string }>(
      await db.execute(
        sql`DELETE FROM model_upstreams WHERE id = ${id}::uuid RETURNING id::text AS id`
      )
    );
    if (!r) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    await audit(admin.email, 'routing.delete_route', 'model_upstream', id, {});
    return NextResponse.json({ ok: true });
  } catch (e) {
    return err(e);
  }
}
