import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Floor on how often a schedule may fire — mirrors the CHECK in migration 0034.
// Bounds how much a self-running agent can spend within the daily budget guard.
const MIN_INTERVAL_MINUTES = 15;

interface ScheduleRow {
  id: string;
  agent_id: string;
  prompt: string;
  interval_minutes: number;
  enabled: boolean;
  next_run_at: string;
  last_run_at: string | null;
}

/** Ownership guard: returns the agent id iff it belongs to this tg_user (and isn't deleted). */
async function ownedAgentId(id: string, tgUserId: string): Promise<string | null> {
  const rows = (await sql`
    SELECT id::text FROM agents
    WHERE id = ${id}::uuid
      AND tg_user_id = ${tgUserId}::bigint
      AND status != 'deleted'
    LIMIT 1
  `) as unknown as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

async function loadSchedule(agentId: string): Promise<ScheduleRow | null> {
  const rows = (await sql`
    SELECT id::text, agent_id::text, prompt, interval_minutes, enabled,
           next_run_at, last_run_at
    FROM agent_schedules
    WHERE agent_id = ${agentId}::uuid
    LIMIT 1
  `) as unknown as ScheduleRow[];
  return rows[0] ?? null;
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  const agentId = await ownedAgentId(params.id, tgUserId);
  if (!agentId) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const schedule = await loadSchedule(agentId);
  return NextResponse.json({ schedule });
}

interface PutBody {
  prompt?: string;
  interval_minutes?: number;
  enabled?: boolean;
}

/**
 * Upsert the agent's single schedule. On a fresh insert next_run_at is seeded to
 * now()+interval; on update next_run_at is left as-is (so editing the prompt
 * doesn't reset the next fire). The worker's atomic claim advances next_run_at;
 * the budget guard + settleRun bill each fire — nothing money-shaped is here.
 */
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const prompt = body.prompt?.trim();
  if (!prompt) return NextResponse.json({ error: 'prompt_required' }, { status: 400 });

  const interval = Number(body.interval_minutes);
  if (!Number.isInteger(interval) || interval < MIN_INTERVAL_MINUTES) {
    return NextResponse.json({ error: 'interval_too_short' }, { status: 400 });
  }

  const enabled = body.enabled !== false; // default ON

  const agentId = await ownedAgentId(params.id, tgUserId);
  if (!agentId) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // 0035 dropped the one-per-agent unique index (agents may now have several named
  // schedules), so ON CONFLICT (agent_id) is no longer valid. Manual upsert: update
  // the agent's existing schedule if present (keeping its next_run_at), else insert.
  const existing = await loadSchedule(agentId);
  if (existing) {
    const upd = (await sql`
      UPDATE agent_schedules
         SET prompt = ${prompt.slice(0, 16000)},
             interval_minutes = ${interval},
             schedule_kind = 'interval',
             enabled = ${enabled}
       WHERE id = ${existing.id}::uuid
      RETURNING id::text, agent_id::text, prompt, interval_minutes, enabled,
                next_run_at, last_run_at
    `) as unknown as ScheduleRow[];
    if (!upd[0]) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ schedule: upd[0] });
  }
  const ins = (await sql`
    INSERT INTO agent_schedules
      (agent_id, tg_user_id, prompt, schedule_kind, interval_minutes, enabled, next_run_at)
    VALUES (
      ${agentId}::uuid, ${tgUserId}::bigint, ${prompt.slice(0, 16000)},
      'interval', ${interval}, ${enabled},
      now() + (${interval} * INTERVAL '1 minute')
    )
    RETURNING id::text, agent_id::text, prompt, interval_minutes, enabled,
              next_run_at, last_run_at
  `) as unknown as ScheduleRow[];

  if (!ins[0]) return NextResponse.json({ error: 'insert_failed' }, { status: 500 });
  return NextResponse.json({ schedule: ins[0] });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  const agentId = await ownedAgentId(params.id, tgUserId);
  if (!agentId) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  await sql`DELETE FROM agent_schedules WHERE agent_id = ${agentId}::uuid`;
  return NextResponse.json({ ok: true });
}

interface PostBody {
  name?: string;
  prompt?: string;
  schedule_kind?: 'interval' | 'daily' | 'weekly';
  interval_minutes?: number;
  at_time?: string; // HH:MM (Europe/Moscow wall-clock) for daily/weekly
  weekday?: number; // 0=Sun..6=Sat for weekly
  enabled?: boolean;
}

/**
 * POST /api/tma/agents/[id]/schedule — CREATE a NEW named schedule for this agent
 * (the SCHEDULES screen; 0035 dropped the one-per-agent unique, so an agent may
 * have several). Ownership-guarded. Seeds next_run_at to the first occurrence:
 *   interval → now()+interval_minutes;
 *   daily    → today@at_time if still ahead, else tomorrow@at_time (Europe/Moscow);
 *   weekly   → next weekday@at_time strictly ahead (Europe/Moscow).
 *
 * NO billing here. Every future fire enqueues a NORMAL run → worker budget guard +
 * settleRun + BYOK-zero rule apply unchanged. Prepared statements only.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const prompt = body.prompt?.trim();
  if (!prompt) return NextResponse.json({ error: 'prompt_required' }, { status: 400 });

  const name = body.name?.trim().slice(0, 120) || null;
  const enabled = body.enabled !== false; // default ON
  const kind = body.schedule_kind ?? 'interval';

  if (kind === 'interval') {
    const interval = Number(body.interval_minutes);
    if (!Number.isInteger(interval) || interval < MIN_INTERVAL_MINUTES) {
      return NextResponse.json({ error: 'interval_too_short' }, { status: 400 });
    }
    const agentId = await ownedAgentId(params.id, tgUserId);
    if (!agentId) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    const rows = (await sql`
      INSERT INTO agent_schedules
        (agent_id, tg_user_id, name, prompt, schedule_kind, interval_minutes, enabled, next_run_at)
      VALUES (
        ${agentId}::uuid, ${tgUserId}::bigint, ${name}, ${prompt.slice(0, 16000)},
        'interval', ${interval}, ${enabled},
        now() + (${interval} * INTERVAL '1 minute')
      )
      RETURNING id::text, agent_id::text, name, prompt, schedule_kind,
                interval_minutes, at_time::text AS at_time, weekday, enabled,
                next_run_at, last_run_at
    `) as unknown as Array<Record<string, unknown>>;
    if (!rows[0]) return NextResponse.json({ error: 'insert_failed' }, { status: 500 });
    return NextResponse.json({ schedule: rows[0] }, { status: 201 });
  }

  // daily | weekly → require a valid HH:MM; weekly also a weekday 0..6.
  if (kind !== 'daily' && kind !== 'weekly') {
    return NextResponse.json({ error: 'invalid_kind' }, { status: 400 });
  }
  const atTime = body.at_time;
  if (typeof atTime !== 'string' || !HHMM_RE.test(atTime)) {
    return NextResponse.json({ error: 'invalid_time' }, { status: 400 });
  }
  let weekday: number | null = null;
  if (kind === 'weekly') {
    weekday = Number(body.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      return NextResponse.json({ error: 'invalid_weekday' }, { status: 400 });
    }
  }

  const agentId = await ownedAgentId(params.id, tgUserId);
  if (!agentId) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // Seed first occurrence in Europe/Moscow wall-clock. For daily: today@at_time if
  // still ahead else +1 day. For weekly: nearest matching weekday@at_time strictly
  // ahead (delta math identical to the worker's claim advance).
  const rows = (await sql`
    INSERT INTO agent_schedules
      (agent_id, tg_user_id, name, prompt, schedule_kind, at_time, weekday, enabled, next_run_at)
    VALUES (
      ${agentId}::uuid, ${tgUserId}::bigint, ${name}, ${prompt.slice(0, 16000)},
      ${kind}, ${atTime}::time, ${weekday}, ${enabled},
      CASE ${kind}
        WHEN 'daily' THEN
          (
            (
              ((now() AT TIME ZONE 'Europe/Moscow')::date + ${atTime}::time)
              + CASE
                  WHEN ((now() AT TIME ZONE 'Europe/Moscow')::date + ${atTime}::time)
                         > (now() AT TIME ZONE 'Europe/Moscow')
                  THEN INTERVAL '0 day' ELSE INTERVAL '1 day'
                END
            ) AT TIME ZONE 'Europe/Moscow'
          )
        ELSE
          (
            (
              ((now() AT TIME ZONE 'Europe/Moscow')::date + ${atTime}::time)
              + (
                (
                  ((${weekday}
                    - EXTRACT(DOW FROM (now() AT TIME ZONE 'Europe/Moscow'))::int
                    + 7) % 7)
                  + CASE
                      WHEN ((${weekday}
                             - EXTRACT(DOW FROM (now() AT TIME ZONE 'Europe/Moscow'))::int
                             + 7) % 7) = 0
                        AND ((now() AT TIME ZONE 'Europe/Moscow')::date + ${atTime}::time)
                             <= (now() AT TIME ZONE 'Europe/Moscow')
                      THEN 7 ELSE 0
                    END
                ) * INTERVAL '1 day'
              )
            ) AT TIME ZONE 'Europe/Moscow'
          )
      END
    )
    RETURNING id::text, agent_id::text, name, prompt, schedule_kind,
              interval_minutes, at_time::text AS at_time, weekday, enabled,
              next_run_at, last_run_at
  `) as unknown as Array<Record<string, unknown>>;

  if (!rows[0]) return NextResponse.json({ error: 'insert_failed' }, { status: 500 });
  return NextResponse.json({ schedule: rows[0] }, { status: 201 });
}
