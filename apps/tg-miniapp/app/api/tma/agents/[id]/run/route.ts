import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RunBody {
  input?: string;
}

/**
 * Stub: enqueue an agent run.
 * Wave 04 wires the real agent-worker — for now we insert a pending row
 * so UI can render the chat-style history and the worker can pick it up.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  let body: RunBody;
  try {
    body = (await req.json()) as RunBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const input = body.input?.trim();
  if (!input) return NextResponse.json({ error: 'input_required' }, { status: 400 });

  // Ownership check
  const owner = (await sql`
    SELECT id::text FROM agents
    WHERE id = ${params.id}::uuid
      AND tg_user_id = ${tgUserId}::bigint
      AND status = 'active'
    LIMIT 1
  `) as unknown as Array<{ id: string }>;
  if (!owner[0]) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const ins = (await sql`
    INSERT INTO agent_runs (agent_id, tg_user_id, input, status)
    VALUES (
      ${params.id}::uuid,
      ${tgUserId}::bigint,
      ${input.slice(0, 16000)},
      'pending'
    )
    RETURNING id::text, status, created_at
  `) as unknown as Array<{ id: string; status: string; created_at: string }>;

  return NextResponse.json({ run_id: ins[0]?.id, status: ins[0]?.status }, { status: 202 });
}
