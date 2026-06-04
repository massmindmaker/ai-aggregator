import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

/**
 * GET /api/tma/me/schedules — list ALL the caller's schedules across all their
 * agents (the SCHEDULES screen, wireframe #25). READ-ONLY. No money moves.
 *
 * Scoped to the verified tg_user_id (x-tma-user-id, set by middleware from the
 * HS256-pinned JWT `sub`). JOINs agents only to surface the agent name; soft-
 * deleted agents are excluded so a schedule the worker would never fire (its
 * agent isn't status='active') doesn't appear as live. Prepared statements only.
 */
interface MeScheduleRow {
  id: string;
  agent_id: string;
  agent_name: string;
  name: string | null;
  schedule_kind: string;
  interval_minutes: number | null;
  at_time: string | null;
  weekday: number | null;
  enabled: boolean;
  next_run_at: string;
  prompt: string;
}

export async function GET(req: NextRequest) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  try {
    const rows = (await sql`
      SELECT s.id::text                AS id,
             s.agent_id::text          AS agent_id,
             a.name                    AS agent_name,
             s.name                    AS name,
             s.schedule_kind           AS schedule_kind,
             s.interval_minutes        AS interval_minutes,
             s.at_time::text           AS at_time,
             s.weekday                 AS weekday,
             s.enabled                 AS enabled,
             s.next_run_at             AS next_run_at,
             s.prompt                  AS prompt
      FROM agent_schedules s
      JOIN agents a ON a.id = s.agent_id
      WHERE s.tg_user_id = ${tgUserId}::bigint
        AND a.status != 'deleted'
      ORDER BY s.enabled DESC, s.next_run_at ASC
      LIMIT 200
    `) as unknown as MeScheduleRow[];

    return NextResponse.json({ schedules: rows });
  } catch (e) {
    console.error('me/schedules error:', e);
    return NextResponse.json({ error: 'fetch_failed' }, { status: 500 });
  }
}
