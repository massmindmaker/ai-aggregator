import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  // Upsert on the unique (agent_id) index. INSERT seeds next_run_at = now()+interval;
  // ON CONFLICT updates prompt/interval/enabled but KEEPS the existing next_run_at.
  const rows = (await sql`
    INSERT INTO agent_schedules (agent_id, tg_user_id, prompt, interval_minutes, enabled, next_run_at)
    VALUES (
      ${agentId}::uuid,
      ${tgUserId}::bigint,
      ${prompt.slice(0, 16000)},
      ${interval},
      ${enabled},
      now() + (${interval} * INTERVAL '1 minute')
    )
    ON CONFLICT (agent_id) DO UPDATE
      SET prompt = EXCLUDED.prompt,
          interval_minutes = EXCLUDED.interval_minutes,
          enabled = EXCLUDED.enabled
    RETURNING id::text, agent_id::text, prompt, interval_minutes, enabled,
              next_run_at, last_run_at
  `) as unknown as ScheduleRow[];

  return NextResponse.json({ schedule: rows[0] });
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
