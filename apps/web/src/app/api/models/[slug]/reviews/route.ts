import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, sql } from '@/lib/db';

interface ReviewRow {
  id: string;
  rating: number;
  title: string | null;
  content: string | null;
  user_name: string | null;
  created_at: string;
}

function rows<T>(r: unknown): T[] {
  return ((r as { rows?: T[] }).rows ?? (r as T[])) ?? [];
}

async function recomputeRating(slug: string) {
  await db.execute(sql`
    UPDATE models SET
      cached_avg_rating = (
        SELECT ROUND(AVG(rating)::numeric, 2)
        FROM gateway_model_reviews
        WHERE model_slug = ${slug} AND is_hidden = false
      ),
      cached_review_count = (
        SELECT COUNT(*)::int
        FROM gateway_model_reviews
        WHERE model_slug = ${slug} AND is_hidden = false
      )
    WHERE slug = ${slug}
  `);
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const decodedSlug = decodeURIComponent(slug);
  try {
    // #7 (security review 2026-07): do not select r.user_id — this is a
    // public, unauthenticated endpoint. u.name (display name) is the only
    // author identity exposed; the internal user PK never leaves the server.
    const result = await db.execute(sql`
      SELECT r.id, r.rating, r.title, r.content, r.created_at,
        u.name AS user_name
      FROM gateway_model_reviews r
      LEFT JOIN users u ON u.id = r.user_id
      WHERE r.model_slug = ${decodedSlug} AND r.is_hidden = false
      ORDER BY r.created_at DESC
      LIMIT 100
    `);
    const reviews = rows<ReviewRow>(result);
    const avgRes = await db.execute(sql`
      SELECT cached_avg_rating::float AS avg, cached_review_count AS count
      FROM models WHERE slug = ${decodedSlug} LIMIT 1
    `);
    const summary =
      rows<{ avg: number | null; count: number }>(avgRes)[0] ??
      { avg: null, count: 0 };
    return NextResponse.json({
      success: true,
      data: { reviews, summary },
    });
  } catch (e) {
    return NextResponse.json(
      { error: { message: (e as Error).message } },
      { status: 500 }
    );
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json(
      { error: { message: 'Требуется вход' } },
      { status: 401 }
    );
  }

  const { slug } = await params;
  const decodedSlug = decodeURIComponent(slug);
  const body = await req.json().catch(() => ({}));

  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return NextResponse.json(
      { error: { message: 'rating должен быть целым 1-5' } },
      { status: 400 }
    );
  }

  const title = (body.title ?? '').toString().slice(0, 200) || null;
  const content = (body.content ?? '').toString().slice(0, 5000) || null;

  // Verify model exists
  const modelRes = await db.execute(
    sql`SELECT 1 FROM models WHERE slug = ${decodedSlug} LIMIT 1`
  );
  if (rows(modelRes).length === 0) {
    return NextResponse.json(
      { error: { message: 'Модель не найдена' } },
      { status: 404 }
    );
  }

  await db.execute(sql`
    INSERT INTO gateway_model_reviews (model_slug, user_id, rating, title, content)
    VALUES (${decodedSlug}, ${session.user.id}, ${rating}, ${title}, ${content})
    ON CONFLICT (user_id, model_slug) DO UPDATE
      SET rating = EXCLUDED.rating,
          title = EXCLUDED.title,
          content = EXCLUDED.content,
          updated_at = NOW(),
          is_hidden = false
  `);

  await recomputeRating(decodedSlug);

  return NextResponse.json({ success: true });
}
