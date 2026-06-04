import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One template's full SHAREABLE spec. Still no secrets (the table has none); this is
// the spec a cloner sees before cloning. mcp_endpoint_url is the shareable URL only.
interface TemplateRow {
  id: string;
  name: string | null;
  description: string | null;
  system_prompt: string | null;
  model_slug: string | null;
  tools: unknown;
  mcp_endpoint_url: string | null;
  suggested_skills: unknown;
  price_credits: string | null;
  visibility: string;
  fork_parent_id: string | null;
  clone_count: number;
  author_tg_user_id: string;
  created_at: string;
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  const rows = (await sql`
    SELECT id::text, name, description, system_prompt, model_slug, tools,
           mcp_endpoint_url, suggested_skills,
           price_credits::text AS price_credits, visibility,
           fork_parent_id::text AS fork_parent_id, clone_count,
           author_tg_user_id::text AS author_tg_user_id, created_at
    FROM agent_templates
    WHERE id = ${params.id}::uuid
      AND visibility = 'public'
    LIMIT 1
  `) as unknown as TemplateRow[];

  const template = rows[0] ?? null;
  if (!template) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  return NextResponse.json({ template });
}
