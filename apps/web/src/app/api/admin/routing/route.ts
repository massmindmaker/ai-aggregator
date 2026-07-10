import { NextRequest, NextResponse } from 'next/server';
import { db, sql } from '@/lib/db';
import { requireAdmin, audit, AdminAuthError } from '@/lib/admin/guard';
import { rowsOf, firstRow } from '@/lib/admin/rows';

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

export async function GET(_req: NextRequest) {
  try {
    await requireAdmin();
    const r = await db.execute(sql`
      SELECT mu.id::text AS id,
             mu.model_id::text AS model_id,
             m.slug AS model_slug,
             m.type AS modality,
             mu.upstream_id, u.provider AS upstream_provider,
             mu.upstream_model_id, mu.markup::text AS markup, mu.enabled
      FROM model_upstreams mu
      JOIN models m ON m.id = mu.model_id
      JOIN upstreams u ON u.id = mu.upstream_id
      ORDER BY m.slug, mu.markup DESC
    `);
    return NextResponse.json({ routes: rowsOf(r) });
  } catch (e) {
    return err(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { user: admin } = await requireAdmin();
    const body = (await req.json()) as {
      model_id: string;
      upstream_id: string;
      upstream_model_id: string;
      markup?: number;
    };

    if (!body.model_id || !body.upstream_id || !body.upstream_model_id) {
      return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 400 });
    }
    if (typeof body.markup === 'number' && body.markup < MIN_MARKUP) {
      return NextResponse.json(
        { error: 'BAD_MARKUP', message: 'markup must be >= 1.20' },
        { status: 400 }
      );
    }
    const markup = typeof body.markup === 'number' && body.markup > 0 ? body.markup : 1.25;

    // Idempotent: check duplicates
    const dup = firstRow(
      await db.execute(sql`
        SELECT id FROM model_upstreams
        WHERE model_id = ${body.model_id}::uuid AND upstream_id = ${body.upstream_id}
      `)
    );
    if (dup) {
      return NextResponse.json({ error: 'DUPLICATE' }, { status: 409 });
    }

    const inserted = firstRow<{ id: string }>(
      await db.execute(sql`
        INSERT INTO model_upstreams (model_id, upstream_id, upstream_model_id, markup, enabled)
        VALUES (${body.model_id}::uuid, ${body.upstream_id}, ${body.upstream_model_id}, ${markup}, true)
        RETURNING id::text AS id
      `)
    );

    await audit(admin.email, 'routing.add_route', 'model_upstream', inserted?.id ?? null, {
      model_id: body.model_id,
      upstream_id: body.upstream_id,
      upstream_model_id: body.upstream_model_id,
      markup,
    });

    return NextResponse.json({ ok: true, id: inserted?.id ?? null });
  } catch (e) {
    return err(e);
  }
}
