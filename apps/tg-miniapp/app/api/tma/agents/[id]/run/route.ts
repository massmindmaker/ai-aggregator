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

  // Ownership check (also fetch connection_type to decide if this run is billed).
  const owner = (await sql`
    SELECT id::text, connection_type FROM agents
    WHERE id = ${params.id}::uuid
      AND tg_user_id = ${tgUserId}::bigint
      AND status = 'active'
    LIMIT 1
  `) as unknown as Array<{ id: string; connection_type: string | null }>;
  if (!owner[0]) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // BALANCE PRE-CHECK (guard only; authoritative debit stays in the worker's
  // settleRun). AIAG-supplied models debit tg_user_balances; BYOK/external
  // (connection_type='external_openai') are isExternal → zero charge, so skip.
  // This turns the async "ran, then failed in the worker with a tech error" into
  // an immediate, honest 402. It does NOT reserve/debit anything — settleRun's
  // guarded `balance_credits >= cost` UPDATE remains the single source of truth.
  const isExternal = owner[0].connection_type === 'external_openai';
  if (!isExternal) {
    const bal = (await sql`
      SELECT COALESCE(balance_credits, 0)::text AS balance_credits
      FROM tg_user_balances
      WHERE tg_user_id = ${tgUserId}::bigint
      LIMIT 1
    `) as unknown as Array<{ balance_credits: string }>;
    if (Number(bal[0]?.balance_credits ?? 0) <= 0) {
      return NextResponse.json({ error: 'insufficient_balance' }, { status: 402 });
    }
  }

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
  // If enqueue fails (Redis down / BullMQ error) the worker will NEVER pick up the
  // row, so a 202 would strand the run as 'pending' forever. Instead: mark the run
  // 'failed' (so the user/UI sees a terminal state, never a phantom pending) and
  // return 503 so the client can retry. Guarded on status='pending' so we never
  // clobber a row a racing worker already advanced.
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
      await sql`
        UPDATE agent_runs
        SET status = 'failed'
        WHERE id = ${runId}::uuid AND status = 'pending'
      `.catch((dbErr) => console.error('[agents/run] failed to mark run failed', dbErr));
      return NextResponse.json({ error: 'enqueue_failed' }, { status: 503 });
    }
  }

  return NextResponse.json({ run_id: runId, status: ins[0]?.status }, { status: 202 });
}
