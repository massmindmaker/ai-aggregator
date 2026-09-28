import * as React from 'react';
import Link from 'next/link';
import MainLayout from '@/components/layout/MainLayout';
import { Badge } from '@/components/ui/Badge';
import LeaderboardTable from './LeaderboardTable';

export const metadata = { title: 'Leaderboard — AI-Aggregator' };

/**
 * Plan 07 Task 8: contest leaderboard.
 *
 * Polling-based (5s) via client component + SWR-style refetch. Private
 * scores are hidden server-side until contest.reveal_private_at ≤ now().
 */
export default async function LeaderboardPage({
  params: paramsPromise,
}: {
  params: Promise<{ slug: string }>;
}) {
  const params = await paramsPromise;
  return (
    <MainLayout>
      <div className="container mx-auto px-4 py-10 max-w-5xl">
        <Link
          href={`/contests/${params.slug}`}
          className="text-sm text-muted-foreground hover:text-foreground mb-4 inline-block"
        >
          ← К конкурсу
        </Link>

        <header className="mb-6 flex items-center justify-between flex-wrap gap-3">
          <h1 className="text-3xl font-bold tracking-tight">Leaderboard</h1>
          <Badge variant="outline">
            Обновляется каждые 30 секунд
          </Badge>
        </header>

        <p className="text-sm text-muted-foreground mb-6">
          Публичный score считается на 20% тестовой выборки. Финальный private
          score открывается после окончания конкурса.
        </p>

        <LeaderboardTable slug={params.slug} />
      </div>
    </MainLayout>
  );
}
