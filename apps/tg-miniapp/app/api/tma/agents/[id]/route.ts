import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface AgentRow {
  id: string;
  tg_user_id: string;
  template_kind: string;
  name: string;
  description: string | null;
  system_prompt: string;
  tools: unknown;
  model_slug: string | null;
  budget_rub_monthly: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  input: string;
  output: string | null;
  status: string;
  cost_rub: string;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

async function loadAgent(id: string, tgUserId: string): Promise<AgentRow | null> {
  const rows = (await sql`
    SELECT id::text, tg_user_id::text, template_kind, name, description,
           system_prompt, tools, model_slug, budget_rub_monthly::text,
           status, created_at, updated_at
    FROM agents
    WHERE id = ${id}::uuid
      AND tg_user_id = ${tgUserId}::bigint
      AND status != 'deleted'
    LIMIT 1
  `) as unknown as AgentRow[];
  return rows[0] ?? null;
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  const agent = await loadAgent(params.id, tgUserId);
  if (!agent) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const runs = (await sql`
    SELECT id::text, input, output, status, cost_rub::text, error,
           created_at, completed_at
    FROM agent_runs
    WHERE agent_id = ${params.id}::uuid
    ORDER BY created_at DESC
    LIMIT 20
  `) as unknown as RunRow[];

  return NextResponse.json({ agent, runs });
}

interface PatchBody {
  name?: string;
  description?: string;
  system_prompt?: string;
  tools?: unknown[];
  model_slug?: string;
  budget_rub_monthly?: number;
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const existing = await loadAgent(params.id, tgUserId);
  if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const name = body.name?.trim() ? body.name.trim().slice(0, 200) : existing.name;
  const description =
    body.description !== undefined ? (body.description?.trim() || null) : existing.description;
  const systemPrompt = body.system_prompt?.trim()
    ? body.system_prompt.trim().slice(0, 8000)
    : existing.system_prompt;
  const tools = Array.isArray(body.tools) ? body.tools : (existing.tools as unknown[]);
  const modelSlug =
    body.model_slug !== undefined ? (body.model_slug?.trim() || null) : existing.model_slug;
  const budget =
    typeof body.budget_rub_monthly === 'number' && body.budget_rub_monthly >= 0
      ? body.budget_rub_monthly
      : Number(existing.budget_rub_monthly);

  const upd = (await sql`
    UPDATE agents
    SET name = ${name},
        description = ${description},
        system_prompt = ${systemPrompt},
        tools = ${sql.json(tools as never)},
        model_slug = ${modelSlug},
        budget_rub_monthly = ${budget},
        updated_at = NOW()
    WHERE id = ${params.id}::uuid
      AND tg_user_id = ${tgUserId}::bigint
    RETURNING id::text, tg_user_id::text, template_kind, name, description,
              system_prompt, tools, model_slug, budget_rub_monthly::text,
              status, created_at, updated_at
  `) as unknown as AgentRow[];

  return NextResponse.json({ agent: upd[0] });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  const res = (await sql`
    DELETE FROM agents
    WHERE id = ${params.id}::uuid
      AND tg_user_id = ${tgUserId}::bigint
    RETURNING id::text
  `) as unknown as Array<{ id: string }>;

  if (!res[0]) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
