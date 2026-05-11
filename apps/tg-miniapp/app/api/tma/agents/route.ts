import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';
import { getTemplate } from '@/lib/agent-templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

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

export async function GET(req: NextRequest) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const rows = (await sql`
    SELECT id::text, tg_user_id::text, template_kind, name, description,
           system_prompt, tools, model_slug, budget_rub_monthly::text,
           status, created_at, updated_at
    FROM agents
    WHERE tg_user_id = ${tgUserId}::bigint
      AND status != 'deleted'
    ORDER BY created_at DESC
  `) as unknown as AgentRow[];

  return NextResponse.json({ agents: rows });
}

interface CreateBody {
  template_kind?: string;
  name?: string;
  description?: string;
  system_prompt?: string;
  tools?: unknown[];
  model_slug?: string;
  budget_rub_monthly?: number;
}

export async function POST(req: NextRequest) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const templateKind = (body.template_kind || 'personal').slice(0, 40);
  const template = getTemplate(templateKind);

  const name = (body.name?.trim() || template?.name || 'Без имени').slice(0, 200);
  const description = body.description?.trim() || template?.description || null;
  const systemPrompt = (body.system_prompt?.trim() || template?.systemPrompt || '').slice(0, 8000);
  if (!systemPrompt) {
    return NextResponse.json({ error: 'system_prompt_required' }, { status: 400 });
  }
  const tools = Array.isArray(body.tools) ? body.tools : (template?.suggestedTools ?? []);
  const modelSlug = body.model_slug?.trim() || template?.defaultModelSlug || null;
  const budget =
    typeof body.budget_rub_monthly === 'number' && body.budget_rub_monthly >= 0
      ? body.budget_rub_monthly
      : 1000;

  const ins = (await sql`
    INSERT INTO agents (
      tg_user_id, template_kind, name, description,
      system_prompt, tools, model_slug, budget_rub_monthly
    )
    VALUES (
      ${tgUserId}::bigint,
      ${templateKind},
      ${name},
      ${description},
      ${systemPrompt},
      ${sql.json(tools as never)},
      ${modelSlug},
      ${budget}
    )
    RETURNING id::text, tg_user_id::text, template_kind, name, description,
              system_prompt, tools, model_slug, budget_rub_monthly::text,
              status, created_at, updated_at
  `) as unknown as AgentRow[];

  return NextResponse.json({ agent: ins[0] }, { status: 201 });
}
