import * as React from 'react';
import Link from 'next/link';
import { db, sql } from '@/lib/db';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { ContestForm } from '../ContestForm';
import { ContestSubmissionsActions } from './ContestSubmissionsActions';

export const dynamic = 'force-dynamic';

type Contest = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  dataset_url: string | null;
  eval_metric: string | null;
  total_prize_pool: string | null;
  starts_at: string | null;
  ends_at: string | null;
  sponsor_id: string | null;
  status: string;
};

async function fetchContest(slug: string): Promise<{
  contest: Contest | null;
  submissions: Array<{
    id: string;
    participant_email: string | null;
    score: string | null;
    status: string;
    rank: number | null;
    final_rank: number | null;
  }>;
}> {
  try {
    const [c, s] = await Promise.all([
      db.execute(sql`
        SELECT id::text, slug, name, description, dataset_url, eval_metric,
               total_prize_pool::text, starts_at::text, ends_at::text,
               sponsor_id::text, status::text
        FROM contests WHERE slug = ${slug}
      `),
      db.execute(sql`
        SELECT cs.id::text,
               u.email AS participant_email,
               cs.score::text,
               cs.status::text,
               cs.rank,
               cs.final_rank
        FROM contest_submissions cs
        JOIN contests ct ON ct.id = cs.contest_id
        LEFT JOIN users u ON u.id = cs.user_id
        WHERE ct.slug = ${slug}
        ORDER BY COALESCE(cs.final_rank, 999), COALESCE(cs.score, 0) DESC
        LIMIT 100
      `).catch(() => ({ rows: [] })),
    ]);
    const contestRows = ((c as unknown as { rows?: Contest[] }).rows ?? (c as unknown as Contest[])) || [];
    const subRows = ((s as unknown as { rows?: unknown[] }).rows ?? (s as unknown as unknown[])) || [];
    return {
      contest: contestRows[0] ?? null,
      submissions: subRows as Array<{
        id: string;
        participant_email: string | null;
        score: string | null;
        status: string;
        rank: number | null;
        final_rank: number | null;
      }>,
    };
  } catch (e) {
    console.error(e);
    return { contest: null, submissions: [] };
  }
}

export default async function AdminContestDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { contest, submissions } = await fetchContest(slug);
  if (!contest) {
    return (
      <div className="container mx-auto px-4 py-8 max-w-3xl">
        <h1 className="text-2xl font-bold">Не найдено</h1>
        <Link href="/admin/contests" className="text-amber-500 mt-4 inline-block">← К списку</Link>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/admin/contests" className="text-xs text-muted-foreground hover:text-amber-400">
            ← Контесты
          </Link>
          <h1 className="text-3xl font-bold mt-1">{contest.name}</h1>
          <div className="flex gap-2 mt-2">
            <Badge>{contest.status}</Badge>
            <span className="text-xs text-muted-foreground">/{contest.slug}</span>
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Параметры</CardTitle>
        </CardHeader>
        <CardContent>
          <ContestForm
            initial={{
              slug: contest.slug,
              name: contest.name,
              description: contest.description ?? '',
              dataset_url: contest.dataset_url ?? '',
              eval_metric: contest.eval_metric ?? '',
              total_prize_pool: contest.total_prize_pool ?? '',
              starts_at: contest.starts_at?.slice(0, 16) ?? '',
              ends_at: contest.ends_at?.slice(0, 16) ?? '',
              sponsor_id: contest.sponsor_id ?? '',
            }}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Сабмишены ({submissions.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase">
              <tr>
                <th className="text-left px-3 py-2">#</th>
                <th className="text-left px-3 py-2">Участник</th>
                <th className="text-right px-3 py-2">Score</th>
                <th className="text-left px-3 py-2">Статус</th>
                <th className="text-right px-3 py-2">Действия</th>
              </tr>
            </thead>
            <tbody>
              {submissions.map((s, i) => {
                const effectiveRank = s.final_rank ?? s.rank ?? i + 1;
                const suggestedSlug = `contest-${contest.slug}-rank${effectiveRank}`;
                return (
                  <tr key={s.id} className="border-t">
                    <td className="px-3 py-2">{effectiveRank}</td>
                    <td className="px-3 py-2 text-xs">{s.participant_email ?? '—'}</td>
                    <td className="px-3 py-2 text-right">{s.score ?? '—'}</td>
                    <td className="px-3 py-2">
                      <Badge variant="outline">{s.status}</Badge>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <ContestSubmissionsActions
                        slug={contest.slug}
                        submissionId={s.id}
                        rank={effectiveRank}
                        finalRank={s.final_rank}
                        participantEmail={s.participant_email}
                        suggestedSlug={suggestedSlug}
                      />
                    </td>
                  </tr>
                );
              })}
              {submissions.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                    Нет сабмишенов
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
