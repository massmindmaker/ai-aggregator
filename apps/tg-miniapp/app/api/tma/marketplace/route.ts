import { NextResponse } from 'next/server';
import postgres from 'postgres';

export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

interface ModelRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  image_url: string | null;
  type: string | null;
}

export async function GET() {
  try {
    const rows = (await sql`
      SELECT id::text, slug,
             COALESCE(display_name, slug) AS name,
             description, image_url, type
      FROM models
      WHERE enabled = true
        AND status IN ('live', 'active', 'published')
      ORDER BY created_at DESC
      LIMIT 50
    `) as unknown as ModelRow[];
    return NextResponse.json({ models: rows });
  } catch (e) {
    console.error('marketplace list error:', e);
    return NextResponse.json({ models: [], error: 'fetch_failed' }, { status: 200 });
  }
}
