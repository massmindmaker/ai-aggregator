/**
 * POST /api/admin/models/[id]/depublish
 *
 * Phase 14 / plan 14-06 — model degradation state machine (spec §7.3).
 * Allowed transitions: 'live' → 'depublished' OR 'frozen' → 'depublished'.
 * 'depublished' is TERMINAL; pending earnings remain pending until cron resolves.
 * Reason is required and recorded in audit_log (action 'model.depublish').
 */
import { NextResponse } from 'next/server';
import { db, sql } from '@/lib/db';
import { withAdmin } from '@/lib/admin/api';
import { audit } from '@/lib/admin/guard';
import { rowsOf } from '@/lib/admin/rows';

interface ModelStatusRow {
  id: string;
  slug: string;
  status: string;
}

const ALLOWED_FROM = new Set(['live', 'frozen']);

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
      /* empty body */
    }
    const reason = body.reason;
    if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
      return NextResponse.json({ error: 'REASON_REQUIRED' }, { status: 400 });
    }

    const m = rowsOf<ModelStatusRow>(
      await db.execute(
        sql`SELECT id::text AS id, slug, status FROM models WHERE id = ${id}::uuid LIMIT 1`
      )
    )[0];
    if (!m) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    if (m.status === 'depublished') {
      return NextResponse.json({ error: 'IDEMPOTENT_NOOP' }, { status: 409 });
    }
    if (!ALLOWED_FROM.has(m.status)) {
      return NextResponse.json(
        { error: 'INVALID_TRANSITION', from: m.status, to: 'depublished' },
        { status: 400 }
      );
    }

    await db.execute(sql`
      UPDATE models
      SET status='depublished', depublished_reason=${reason}
      WHERE id = ${id}::uuid
    `);

    await audit(user.email!, 'model.depublish', 'model', id, {
      slug: m.slug,
      reason,
      prev_status: m.status,
    });

    return NextResponse.json({ ok: true, status: 'depublished' });
  });
}
