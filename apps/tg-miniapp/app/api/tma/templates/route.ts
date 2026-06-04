import { NextResponse } from 'next/server';
import postgres from 'postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

// Public catalog row. Mirrors the read-only pattern in ../marketplace/route.ts.
// NO secrets: agent_templates has no secret columns, and we still select only the
// publicly safe spec fields here.
interface TemplateListRow {
  id: string;
  name: string | null;
  description: string | null;
  model_slug: string | null;
  tools: unknown;
  price_credits: string | null;
  clone_count: number;
  author_tg_user_id: string;
  created_at: string;
}

export async function GET() {
  try {
    const rows = (await sql`
      SELECT id::text, name, description, model_slug, tools,
             price_credits::text AS price_credits, clone_count,
             author_tg_user_id::text AS author_tg_user_id, created_at
      FROM agent_templates
      WHERE visibility = 'public'
      ORDER BY created_at DESC
      LIMIT 100
    `) as unknown as TemplateListRow[];
    return NextResponse.json({ templates: rows });
  } catch (e) {
    console.error('templates list error:', e);
    return NextResponse.json({ templates: [], error: 'fetch_failed' }, { status: 200 });
  }
}
