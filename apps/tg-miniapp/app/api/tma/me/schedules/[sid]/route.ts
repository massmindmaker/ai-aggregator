import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Floor on how often an interval schedule may fire — mirrors the CHECK in 0034/0035.
const MIN_INTERVAL_MINUTES = 15;

/**
 * Ownership guard: a schedule belongs to the caller iff its tg_user_id matches AND
 * its (non-deleted) agent belongs to the caller too. Returns the schedule_kind so
 * PATCH can validate edits against the row's kind. NULL ⇒ not the caller's.
 */
async function ownedSchedule(
  sid: string,
  tgUserId: string,
): Promise<{ id: string; schedule_kind: string } | null> {
  const rows = (await sql`
    SELECT s.id::text AS id, s.schedule_kind AS schedule_kind
    FROM agent_schedules s
    JOIN agents a ON a.id = s.agent_id
    WHERE s.id = ${sid}::uuid
      AND s.tg_user_id = ${tgUserId}::bigint
      AND a.tg_user_id = ${tgUserId}::bigint
      AND a.status != 'deleted'
    LIMIT 1
  `) as unknown as Array<{ id: string; schedule_kind: string }>;
  return rows[0] ?? null;
}

interface PatchBody {
  enabled?: boolean;
  name?: string;
  prompt?: string;
  // Edit timing (kind stays fixed at creation; only its parameters are editable).
  interval_minutes?: number;
  at_time?: string; // HH:MM
  weekday?: number; // 0=Sun..6=Sat
}

/**
 * PATCH /api/tma/me/schedules/[sid] — toggle `enabled` and/or edit a named
 * schedule's label/prompt/timing. Ownership-guarded (schedule + its agent must
 * belong to the caller). next_run_at is NOT reset on a prompt/name/enable edit;
 * it IS recomputed (now()+interval) when the interval changes, and (now()) when a
 * daily/weekly at_time/weekday changes, so a re-timed schedule fires from now.
 *
 * NO billing here — every future fire still flows through the worker's budget
 * guard + settleRun. Prepared statements only.
 */
export async function PATCH(req: NextRequest, { params }: { params: { sid: string } }) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!UUID_RE.test(params.sid)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const owned = await ownedSchedule(params.sid, tgUserId);
  if (!owned) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // Resolve every editable field to either a concrete new value or null="leave as
  // is", then run ONE prepared UPDATE using COALESCE(<new>, <existing>). This keeps
  // a single static query (no dynamic SET assembly) while only touching supplied
  // fields. A re-time flag controls whether next_run_at is re-anchored.
  let nEnabled: boolean | null = null;
  let nName: string | null = null;
  let nNameSet = false; // name can legitimately be cleared to null
  let nPrompt: string | null = null;
  let nInterval: number | null = null;
  let nAtTime: string | null = null;
  let nWeekday: number | null = null;
  let reanchorInterval = false;
  let reanchorNow = false;

  if (typeof body.enabled === 'boolean') nEnabled = body.enabled;

  if (typeof body.name === 'string') {
    nName = body.name.trim().slice(0, 120) || null;
    nNameSet = true;
  }

  if (typeof body.prompt === 'string') {
    const p = body.prompt.trim();
    if (!p) return NextResponse.json({ error: 'prompt_required' }, { status: 400 });
    nPrompt = p.slice(0, 16000);
  }

  if (owned.schedule_kind === 'interval' && body.interval_minutes !== undefined) {
    const iv = Number(body.interval_minutes);
    if (!Number.isInteger(iv) || iv < MIN_INTERVAL_MINUTES) {
      return NextResponse.json({ error: 'interval_too_short' }, { status: 400 });
    }
    nInterval = iv;
    reanchorInterval = true; // shortened interval takes effect immediately
  }

  if (owned.schedule_kind === 'daily' || owned.schedule_kind === 'weekly') {
    if (body.at_time !== undefined) {
      if (typeof body.at_time !== 'string' || !HHMM_RE.test(body.at_time)) {
        return NextResponse.json({ error: 'invalid_time' }, { status: 400 });
      }
      nAtTime = body.at_time;
      reanchorNow = true;
    }
    if (owned.schedule_kind === 'weekly' && body.weekday !== undefined) {
      const wd = Number(body.weekday);
      if (!Number.isInteger(wd) || wd < 0 || wd > 6) {
        return NextResponse.json({ error: 'invalid_weekday' }, { status: 400 });
      }
      nWeekday = wd;
      reanchorNow = true;
    }
  }

  if (
    nEnabled === null &&
    !nNameSet &&
    nPrompt === null &&
    nInterval === null &&
    nAtTime === null &&
    nWeekday === null
  ) {
    return NextResponse.json({ error: 'no_changes' }, { status: 400 });
  }

  // Single static prepared UPDATE. COALESCE(new, existing) leaves untouched columns
  // alone; for `name` (which can be cleared) the ${nNameSet} flag decides whether to
  // overwrite. next_run_at: interval re-anchor > now() re-anchor > unchanged.
  const rows = (await sql`
    UPDATE agent_schedules
       SET enabled          = COALESCE(${nEnabled}, enabled),
           name             = CASE WHEN ${nNameSet} THEN ${nName} ELSE name END,
           prompt           = COALESCE(${nPrompt}, prompt),
           interval_minutes = COALESCE(${nInterval}, interval_minutes),
           at_time          = COALESCE(${nAtTime}::time, at_time),
           weekday          = COALESCE(${nWeekday}, weekday),
           next_run_at      = CASE
             WHEN ${reanchorInterval} THEN now() + (${nInterval} * INTERVAL '1 minute')
             WHEN ${reanchorNow}      THEN now()
             ELSE next_run_at
           END
     WHERE id = ${params.sid}::uuid
       AND tg_user_id = ${tgUserId}::bigint
     RETURNING id::text, agent_id::text, name, schedule_kind,
               interval_minutes, at_time::text AS at_time, weekday, enabled,
               next_run_at, prompt
  `) as unknown as Array<Record<string, unknown>>;

  return NextResponse.json({ schedule: rows[0] ?? null });
}

/**
 * DELETE /api/tma/me/schedules/[sid] — remove a named schedule. Ownership-guarded
 * via the WHERE tg_user_id clause (belt-and-suspenders with ownedSchedule).
 */
export async function DELETE(req: NextRequest, { params }: { params: { sid: string } }) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!UUID_RE.test(params.sid)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  const owned = await ownedSchedule(params.sid, tgUserId);
  if (!owned) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  await sql`
    DELETE FROM agent_schedules
    WHERE id = ${params.sid}::uuid AND tg_user_id = ${tgUserId}::bigint
  `;
  return NextResponse.json({ ok: true });
}
