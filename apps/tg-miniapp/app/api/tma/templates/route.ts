import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

// Public catalog row. Mirrors the read-only pattern in ../marketplace/route.ts.
// NO secrets: agent_templates has no secret columns, and we still select only the
// publicly safe spec fields here. avg_rating/rating_count come from a LEFT JOIN on
// template_ratings (discovery signal).
interface TemplateListRow {
  id: string;
  name: string | null;
  description: string | null;
  model_slug: string | null;
  tools: unknown;
  price_credits: string | null;
  clone_count: number;
  avg_rating: string | null;
  rating_count: number;
  author_tg_user_id: string;
  created_at: string;
}

export async function GET(req: NextRequest) {
  // sort: 'trending' (clone_count DESC), 'top' (avg_rating DESC NULLS LAST),
  // 'new' (created_at DESC — the default). The query is one of three fixed
  // tagged templates (no user-interpolated ORDER BY) to stay injection-safe.
  const sort = req.nextUrl.searchParams.get('sort');
  try {
    let rows: TemplateListRow[];
    if (sort === 'trending') {
      rows = (await sql`
        SELECT t.id::text, t.name, t.description, t.model_slug, t.tools,
               t.price_credits::text AS price_credits, t.clone_count,
               ROUND(AVG(r.stars), 1)::text AS avg_rating,
               COUNT(r.id)::int AS rating_count,
               t.author_tg_user_id::text AS author_tg_user_id, t.created_at
        FROM agent_templates t
        LEFT JOIN template_ratings r ON r.template_id = t.id
        WHERE t.visibility = 'public'
        GROUP BY t.id
        ORDER BY t.clone_count DESC
        LIMIT 100
      `) as unknown as TemplateListRow[];
    } else if (sort === 'top') {
      rows = (await sql`
        SELECT t.id::text, t.name, t.description, t.model_slug, t.tools,
               t.price_credits::text AS price_credits, t.clone_count,
               ROUND(AVG(r.stars), 1)::text AS avg_rating,
               COUNT(r.id)::int AS rating_count,
               t.author_tg_user_id::text AS author_tg_user_id, t.created_at
        FROM agent_templates t
        LEFT JOIN template_ratings r ON r.template_id = t.id
        WHERE t.visibility = 'public'
        GROUP BY t.id
        ORDER BY ROUND(AVG(r.stars), 1) DESC NULLS LAST, t.created_at DESC
        LIMIT 100
      `) as unknown as TemplateListRow[];
    } else {
      rows = (await sql`
        SELECT t.id::text, t.name, t.description, t.model_slug, t.tools,
               t.price_credits::text AS price_credits, t.clone_count,
               ROUND(AVG(r.stars), 1)::text AS avg_rating,
               COUNT(r.id)::int AS rating_count,
               t.author_tg_user_id::text AS author_tg_user_id, t.created_at
        FROM agent_templates t
        LEFT JOIN template_ratings r ON r.template_id = t.id
        WHERE t.visibility = 'public'
        GROUP BY t.id
        ORDER BY t.created_at DESC
        LIMIT 100
      `) as unknown as TemplateListRow[];
    }
    return NextResponse.json({ templates: rows });
  } catch (e) {
    console.error('templates list error:', e);
    return NextResponse.json({ templates: [], error: 'fetch_failed' }, { status: 200 });
  }
}
