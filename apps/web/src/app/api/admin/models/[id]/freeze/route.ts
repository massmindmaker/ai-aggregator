/**
 * POST /api/admin/models/[id]/freeze
 *
 * Phase 14 / plan 14-06 — model degradation state machine (spec §7.3).
 * Transitions models.status: 'live' → 'frozen' (idempotent: 409 if already frozen).
 * Reason is required and recorded in audit_log (action 'model.freeze').
 *
 * Once frozen, the gateway middleware `model-status-check` short-circuits
 * /v1/* requests for this model with HTTP 503 + Retry-After: 3600.
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
    if (m.status === 'frozen') {
      return NextResponse.json({ error: 'IDEMPOTENT_NOOP' }, { status: 409 });
    }
    if (m.status !== 'live') {
      // Spec §7.3: only live → frozen is allowed.
      return NextResponse.json(
        { error: 'INVALID_TRANSITION', from: m.status, to: 'frozen' },
        { status: 400 }
      );
    }

    await db.execute(sql`
      UPDATE models
      SET status='frozen', frozen_reason=${reason}
      WHERE id = ${id}::uuid
    `);

    await audit(user.email!, 'model.freeze', 'model', id, {
      slug: m.slug,
      reason,
      prev_status: m.status,
    });

    return NextResponse.json({ ok: true, status: 'frozen' });
  });
}
