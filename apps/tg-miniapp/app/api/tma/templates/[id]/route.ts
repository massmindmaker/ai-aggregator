import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One template's full SHAREABLE spec. Still no secrets (the table has none); this is
// the spec a creator sees before creating an agent from it. mcp_endpoint_url is the
// shareable URL only.
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
  parent_name: string | null;
  avg_rating: string | null;
  rating_count: number;
  clone_count: number;
  author_tg_user_id: string;
  created_at: string;
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  // avg_rating/rating_count from a correlated subquery on template_ratings (no JOIN
  // fan-out on a single-row fetch). fork_parent_id + parent_name from a LEFT JOIN on
  // the parent template so the UI can show «форк от X».
  const rows = (await sql`
    SELECT t.id::text, t.name, t.description, t.system_prompt, t.model_slug, t.tools,
           t.mcp_endpoint_url, t.suggested_skills,
           t.price_credits::text AS price_credits, t.visibility,
           t.fork_parent_id::text AS fork_parent_id,
           parent.name AS parent_name,
           (SELECT ROUND(AVG(r.stars), 1)::text FROM template_ratings r WHERE r.template_id = t.id) AS avg_rating,
           (SELECT COUNT(*)::int FROM template_ratings r WHERE r.template_id = t.id) AS rating_count,
           t.clone_count,
           t.author_tg_user_id::text AS author_tg_user_id, t.created_at
    FROM agent_templates t
    LEFT JOIN agent_templates parent ON parent.id = t.fork_parent_id
    WHERE t.id = ${params.id}::uuid
      AND t.visibility = 'public'
    LIMIT 1
  `) as unknown as TemplateRow[];

  const template = rows[0] ?? null;
  if (!template) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  return NextResponse.json({ template });
}
