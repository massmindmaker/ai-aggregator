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

  // Launch authorization — ADDITIVE for hire (OWASP LLM06 isolation downstream).
  // Allowed if the caller is EITHER:
  //   (a) the agent OWNER (legacy: tg_user_id = caller), OR
  //   (b) a HIRER with an ACTIVE agent_sessions row (agent_id, hirer = caller).
  // In BOTH cases the run row's tg_user_id is set to the CALLER below, so the
  // worker debits the caller and derives the memory/history scope server-side
  // from (run.tg_user_id vs owner) — never from the request body. The single
  // EXISTS query covers both cases without changing the owner path's behaviour.
  const allowed = (await sql`
    SELECT 1
    WHERE EXISTS (
      SELECT 1 FROM agents
       WHERE id = ${params.id}::uuid
         AND status = 'active'
         AND tg_user_id = ${tgUserId}::bigint
    )
    OR EXISTS (
      SELECT 1
        FROM agent_sessions s
        JOIN agents a ON a.id = s.agent_id
       WHERE s.agent_id = ${params.id}::uuid
         AND s.hirer_tg_user_id = ${tgUserId}::bigint
         AND s.status = 'active'
         AND a.status = 'active'
    )
  `) as unknown as Array<{ '?column?': number }>;
  if (!allowed[0]) return NextResponse.json({ error: 'not_found' }, { status: 404 });

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

  const runId = ins[0]?.id;

  // Enqueue BullMQ job for agent-worker to consume.
  if (runId) {
    try {
      const { Queue } = await import('bullmq');
      const IORedisMod = await import('ioredis');
      const IORedis = IORedisMod.default;
      const connection = new IORedis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      });
      const queue = new Queue('agent-run', { connection: connection as never });
      await queue.add('run', { runId }, { removeOnComplete: 100, removeOnFail: 100 });
      await queue.close();
      await connection.quit();
    } catch (e) {
      console.error('[agents/run] failed to enqueue', e);
    }
  }

  return NextResponse.json({ run_id: runId, status: ins[0]?.status }, { status: 202 });
}
