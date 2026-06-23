import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /api/tma/agents/[id]/hire — нанять агента.
//
// Наём ≠ клон: наниматель НЕ получает копию. Он получает ИЗОЛИРОВАННЫЙ инстанс
// чужого агента — спека владельца read-only, а память/история нанимателя
// namespaced per (agent_id, hirer_tg_user_id) (worker resolveRunScope + 0040).
// Биллинг — путь AIAG: дебетуется НАНИМАТЕЛЬ (его x-tma-user-id попадает в
// agent_runs.tg_user_id → settleRun дебетует его). Никакой передачи ключей.
//
// Идемпотентно: повторный наём = no-op (UNIQUE(agent_id, hirer_tg_user_id),
// ON CONFLICT DO UPDATE возвращает существующую активную сессию).
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  // Агент должен существовать и быть активным. Владелец нанимать себя не может —
  // у него уже есть прямой owner-доступ (его память = shared scope).
  const rows = (await sql`
    SELECT tg_user_id::text AS owner_id
    FROM agents
    WHERE id = ${params.id}::uuid AND status = 'active'
    LIMIT 1
  `) as unknown as Array<{ owner_id: string }>;
  const agent = rows[0];
  if (!agent) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (String(agent.owner_id) === String(tgUserId)) {
    return NextResponse.json({ error: 'cannot_hire_own_agent' }, { status: 400 });
  }

  // Upsert активной сессии найма. hirer_tg_user_id = аутентифицированный
  // x-tma-user-id (серверная граница; тело запроса НЕ участвует в scope).
  const upsert = (await sql`
    INSERT INTO agent_sessions (agent_id, hirer_tg_user_id, status)
    VALUES (${params.id}::uuid, ${tgUserId}::bigint, 'active')
    ON CONFLICT (agent_id, hirer_tg_user_id)
    DO UPDATE SET status = 'active', updated_at = NOW()
    RETURNING id::text, agent_id::text, hirer_tg_user_id::text AS hirer_tg_user_id,
              status, created_at
  `) as unknown as Array<{
    id: string;
    agent_id: string;
    hirer_tg_user_id: string;
    status: string;
    created_at: string;
  }>;

  return NextResponse.json({ session: upsert[0] }, { status: 200 });
}
