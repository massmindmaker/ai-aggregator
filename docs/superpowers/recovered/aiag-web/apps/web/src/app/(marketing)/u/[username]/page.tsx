import * as React from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import MainLayout from '@/components/layout/MainLayout';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Avatar, AvatarFallback } from '@/components/ui/Avatar';
import { formatPrice, formatNumber, getInitials } from '@aiag/shared';

/**
 * Plan 07 Task 10: public author profile `/u/[username]`.
 *
 * Shows: avatar, bio, joined, published models count, contest wins, avg
 * rating + list of published models + contests participated in.
 * Aggregate query spec lives in plan §11.3.
 */

interface ProfileData {
  username: string;
  displayName: string;
  bio: string | null;
  joinedAt: string;
  modelsCount: number;
  winsCount: number;
  avgRating: number | null;
  models: Array<{
    slug: string;
    name: string;
    rating: number | null;
    requestsThisMonth: number;
  }>;
  contestResults: Array<{
    slug: string;
    name: string;
    rank: number;
    prizeRub: number;
  }>;
}

const MOCK_PROFILES: Record<string, ProfileData> = {
  'irina-k': {
    username: 'irina-k',
    displayName: 'Ирина Комарова',
    bio: 'ML engineer, работаю с NLP в медицине. Kaggle Master.',
    joinedAt: '2025-12-03T00:00:00Z',
    modelsCount: 2,
    winsCount: 1,
    avgRating: 4.6,
    models: [
      {
        slug: 'medner-ru-v2',
        name: 'MedNER RU v2',
        rating: 4.6,
        requestsThisMonth: 12_400,
      },
    ],
    contestResults: [
      {
        slug: 'ru-ner-medical',
        name: 'NER для медицинских текстов',
        rank: 1,
        prizeRub: 600_000,
      },
    ],
  },
};

export async function generateMetadata({
  params,
}: {
  params: { username: string };
}) {
  const p = MOCK_PROFILES[params.username];
  if (!p) return { title: 'Профиль не найден' };
  return {
    title: `${p.displayName} — AI-Aggregator`,
    description: p.bio ?? `Публичный профиль ${p.displayName}`,
  };
}

export default function PublicProfilePage({
  params,
}: {
  params: { username: string };
}) {
  const p = MOCK_PROFILES[params.username];
  if (!p) notFound();

  return (
    <MainLayout>
      <div className="container mx-auto px-4 py-10 max-w-4xl">
        <div className="flex items-start gap-4 mb-8">
          <Avatar className="h-20 w-20">
            <AvatarFallback>{getInitials(p.displayName)}</AvatarFallback>
          </Avatar>
          <div className="flex-1">
            <h1 className="text-3xl font-bold">{p.displayName}</h1>
            <div className="text-muted-foreground">@{p.username}</div>
            {p.bio && <p className="mt-3 max-w-2xl">{p.bio}</p>}
            <div className="mt-3 flex gap-2 flex-wrap">
              <Badge variant="outline">
                Моделей: {formatNumber(p.modelsCount)}
              </Badge>
              <Badge variant="outline">
                Побед: {formatNumber(p.winsCount)}
              </Badge>
              {p.avgRating !== null && (
                <Badge variant="outline">
                  Рейтинг: {p.avgRating.toFixed(1)} / 5
                </Badge>
              )}
            </div>
          </div>
        </div>

        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-3">Модели</h2>
          {p.models.length === 0 ? (
            <div className="text-muted-foreground text-sm">
              Пока нет опубликованных моделей.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {p.models.map((m) => (
                <Card key={m.slug}>
                  <CardHeader>
                    <CardTitle>
                      <Link
                        href={`/marketplace/${params.username}/${m.slug}`}
                        className="hover:text-primary"
                      >
                        {m.name}
                      </Link>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm text-muted-foreground">
                    {m.rating !== null && <>Рейтинг: {m.rating.toFixed(1)} · </>}
                    {formatNumber(m.requestsThisMonth)} запросов за месяц
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>

        <section>
          <h2 className="text-xl font-semibold mb-3">Результаты в конкурсах</h2>
          {p.contestResults.length === 0 ? (
            <div className="text-muted-foreground text-sm">
              Пока не участвовал(а) в конкурсах.
            </div>
          ) : (
            <ul className="space-y-3">
              {p.contestResults.map((r) => (
                <li
                  key={r.slug}
                  className="flex items-center justify-between p-4 rounded-lg border"
                >
                  <div>
                    <Link
                      href={`/contests/${r.slug}`}
                      className="font-medium hover:text-primary"
                    >
                      {r.name}
                    </Link>
                    <div className="text-sm text-muted-foreground">
                      {r.rank} место
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-muted-foreground">Приз</div>
                    <div className="font-semibold">
                      {formatPrice(r.prizeRub)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </MainLayout>
  );
}
