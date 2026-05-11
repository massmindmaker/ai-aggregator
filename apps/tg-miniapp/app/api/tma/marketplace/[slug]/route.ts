import { NextRequest, NextResponse } from 'next/server';
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
  tags: string[] | null;
  status: string;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { slug: string } },
) {
  try {
    const rows = (await sql`
      SELECT id::text, slug,
             COALESCE(display_name, slug) AS name,
             description, image_url, type, tags, status
      FROM models
      WHERE slug = ${params.slug}
      LIMIT 1
    `) as unknown as ModelRow[];
    if (rows.length === 0) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ model: rows[0] });
  } catch (e) {
    console.error('marketplace detail error:', e);
    return NextResponse.json({ error: 'fetch_failed' }, { status: 500 });
  }
}
