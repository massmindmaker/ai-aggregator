import * as React from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import MainLayout from '@/components/layout/MainLayout';
import { Card, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { db, sql } from '@/lib/db';
import { auth } from '@/auth';
import { stripProviderBrand } from '@/lib/marketplace/strip-provider-brand';
import { ReviewForm } from './ReviewForm';

export const dynamic = 'force-dynamic';

interface ModelRow {
  id: string;
  slug: string;
  display_name: string | null;
  type: string;
  cached_avg_rating: string | null;
  cached_review_count: number;
}

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

async function loadData(slug: string) {
  const modelRes = await db.execute(sql`
    SELECT id, slug, display_name, type,
      cached_avg_rating, cached_review_count
    FROM models WHERE slug = ${slug} LIMIT 1
  `);
  const model = rows<ModelRow>(modelRes)[0];
  if (!model) return null;
  const reviewsRes = await db.execute(sql`
    SELECT r.id, r.rating, r.title, r.content, r.created_at,
      u.name AS user_name
    FROM gateway_model_reviews r
    LEFT JOIN users u ON u.id = r.user_id
    WHERE r.model_slug = ${slug} AND r.is_hidden = false
    ORDER BY r.created_at DESC
    LIMIT 100
  `);
  return { model, reviews: rows<ReviewRow>(reviewsRes) };
}

function Stars({ value }: { value: number }) {
  return (
    <span className="text-yellow-500" aria-label={`${value} из 5`}>
      {'★'.repeat(value)}
      <span className="text-muted-foreground">{'★'.repeat(5 - value)}</span>
    </span>
  );
}

export default async function ReviewsPage({
  params,
}: {
  params: Promise<{ org: string; model: string }>;
}) {
  const { org, model: modelSlugPart } = await params;
  // Slug может быть как `provider/model`, так и просто `model-name`
  // Пробуем оба варианта.
  const candidates = [
    `${decodeURIComponent(org)}/${decodeURIComponent(modelSlugPart)}`,
    decodeURIComponent(modelSlugPart),
  ];
  let data: Awaited<ReturnType<typeof loadData>> = null;
  let resolvedSlug = candidates[0];
  for (const c of candidates) {
    const d = await loadData(c);
    if (d) {
      data = d;
      resolvedSlug = c;
      break;
    }
  }
  if (!data) notFound();
  const { model, reviews } = data;
  const session = await auth();
  const avg = model.cached_avg_rating ? Number(model.cached_avg_rating) : null;

  return (
    <MainLayout>
      <div className="container mx-auto px-4 py-10 max-w-4xl">
        <Link
          href={`/marketplace/${org}/${modelSlugPart}`}
          className="text-sm text-muted-foreground hover:text-primary"
        >
          ← {model.display_name ? stripProviderBrand(model.display_name) : model.slug}
        </Link>

        <h1 className="text-3xl font-bold tracking-tight mt-4 mb-2">Отзывы</h1>
        <div className="flex items-center gap-3 mb-8">
          <Badge variant="outline">{model.type}</Badge>
          {avg !== null ? (
            <span className="text-lg">
              <Stars value={Math.round(avg)} />{' '}
              <span className="font-semibold">{avg.toFixed(2)}</span>{' '}
              <span className="text-muted-foreground text-sm">
                ({model.cached_review_count} отзывов)
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">Пока нет оценок</span>
          )}
        </div>

        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-3">Оставить отзыв</h2>
          {session?.user ? (
            <ReviewForm slug={resolvedSlug} />
          ) : (
            <Card>
              <CardContent className="py-6 text-sm text-muted-foreground">
                <Link
                  href={`/login?next=/marketplace/${org}/${modelSlugPart}/reviews`}
                  className="text-primary hover:underline"
                >
                  Войдите
                </Link>
                , чтобы оставить отзыв.
              </CardContent>
            </Card>
          )}
        </section>

        <section>
          <h2 className="text-xl font-semibold mb-3">
            Все отзывы ({reviews.length})
          </h2>
          {reviews.length === 0 ? (
            <p className="text-muted-foreground">
              Эту модель ещё никто не оценил. Будьте первым!
            </p>
          ) : (
            <div className="space-y-3">
              {reviews.map((r) => (
                <Card key={r.id}>
                  <CardContent className="py-4">
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <Stars value={r.rating} />
                        <span className="text-sm font-medium">
                          {r.user_name ?? 'Аноним'}
                        </span>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {new Date(r.created_at).toLocaleDateString('ru-RU')}
                      </span>
                    </div>
                    {r.title ? (
                      <h3 className="font-semibold">{r.title}</h3>
                    ) : null}
                    {r.content ? (
                      <p className="text-sm mt-1 whitespace-pre-wrap">
                        {r.content}
                      </p>
                    ) : null}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>
      </div>
    </MainLayout>
  );
}
