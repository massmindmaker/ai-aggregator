import * as React from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db, sql } from '@/lib/db';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { formatPrice, formatNumber, formatDate } from '@aiag/shared';

export const dynamic = 'force-dynamic';

interface ContestRow {
  slug: string;
  name: string;
  description: string | null;
  short_description: string | null;
  rules: string | null;
  data_description: string | null;
  total_prize_pool: string | null;
  prizes: unknown;
  evaluation_metrics: unknown;
  total_participants: number;
  total_submissions: number;
  starts_at: string | null;
  ends_at: string | null;
  status: string;
  sponsor_name: string | null;
}

interface PrizeBreakdown {
  place: number;
  amount: number;
  extra?: string;
}

async function fetchContest(slug: string): Promise<ContestRow | null> {
  try {
    const r = await db.execute(sql`
      SELECT c.slug, c.name, c.description, c.short_description, c.rules,
             c.data_description, c.total_prize_pool::text AS total_prize_pool,
             c.prizes, c.evaluation_metrics,
             c.total_participants, c.total_submissions,
             c.starts_at::text AS starts_at, c.ends_at::text AS ends_at,
             c.status::text AS status,
             o.name AS sponsor_name
      FROM contests c
      LEFT JOIN organizations o ON o.id = c.organization_id
      WHERE c.slug = ${slug} AND c.is_public = true
      LIMIT 1
    `);
    const rows = (((r as unknown as { rows?: unknown[] }).rows ?? r) as ContestRow[]);
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const c = await fetchContest(slug);
  if (!c) return { title: 'Конкурс не найден' };
  return {
    title: `${c.name} — AI-Aggregator`,
    description: c.short_description ?? c.description ?? '',
  };
}

export default async function ContestDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const c = await fetchContest(slug);
  if (!c) notFound();

  const isOpen = c.status === 'active';
  const evalMetric =
    typeof c.evaluation_metrics === 'object' &&
    c.evaluation_metrics &&
    'primary' in (c.evaluation_metrics as Record<string, unknown>)
      ? String((c.evaluation_metrics as { primary: unknown }).primary)
      : '—';
  const prizeBreakdown: PrizeBreakdown[] = Array.isArray(c.prizes)
    ? (c.prizes as PrizeBreakdown[])
    : [];

  return (
    <div className="container mx-auto px-4 py-10 max-w-6xl">
      <section className="mb-8">
        <div className="aspect-[16/5] w-full overflow-hidden rounded-lg bg-gradient-to-br from-primary/20 via-primary/10 to-background flex items-center justify-center mb-6">
          <span className="text-8xl opacity-30">🏆</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <Badge variant={isOpen ? 'default' : 'secondary'}>
            {isOpen
              ? 'Приём работ'
              : c.status === 'upcoming'
                ? 'Скоро'
                : c.status === 'evaluation'
                  ? 'Оценка'
                  : 'Завершён'}
          </Badge>
          {c.sponsor_name && <Badge variant="outline">{c.sponsor_name}</Badge>}
          <Badge variant="outline">Метрика: {evalMetric}</Badge>
        </div>
        <h1 className="text-4xl font-bold tracking-tight mb-2">{c.name}</h1>
        <p className="text-lg text-muted-foreground max-w-3xl">
          {c.short_description ?? c.description ?? ''}
        </p>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6 p-4 rounded-lg border bg-muted/30">
          <Stat
            label="Призовой фонд"
            value={c.total_prize_pool ? formatPrice(Number(c.total_prize_pool)) : '—'}
          />
          <Stat label="Участники" value={formatNumber(c.total_participants)} />
          <Stat label="Сабмитов" value={formatNumber(c.total_submissions)} />
          <Stat
            label="Завершение"
            value={c.ends_at ? formatDate(new Date(c.ends_at)) : '—'}
          />
        </div>

        <div className="flex flex-wrap gap-3 mt-6">
          {isOpen && (
            <Button asChild size="lg">
              <Link href={`/contests/${c.slug}/register`}>Участвовать</Link>
            </Button>
          )}
          <Button asChild variant="outline" size="lg">
            <Link href={`/contests/${c.slug}/leaderboard`}>Leaderboard</Link>
          </Button>
        </div>
      </section>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Обзор</TabsTrigger>
          <TabsTrigger value="data">Данные</TabsTrigger>
          <TabsTrigger value="rules">Правила</TabsTrigger>
          <TabsTrigger value="prizes">Призы</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-6 prose dark:prose-invert max-w-none">
          <p>{c.description ?? c.short_description ?? ''}</p>
        </TabsContent>

        <TabsContent value="data" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>Датасет конкурса</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {c.data_description ?? 'Описание датасета будет добавлено организатором.'}
              </p>
              <p className="text-xs text-muted-foreground">
                Регистрация на конкурс обязательна для скачивания.
              </p>
              <Button disabled variant="secondary" size="sm">
                Скачать (требуется регистрация)
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="rules" className="mt-6 prose dark:prose-invert max-w-none">
          {c.rules ? (
            <p>{c.rules}</p>
          ) : (
            <p className="text-muted-foreground">Правила будут опубликованы организатором.</p>
          )}
        </TabsContent>

        <TabsContent value="prizes" className="mt-6">
          <div className="space-y-3">
            {prizeBreakdown.length === 0 ? (
              <div className="py-8 text-center text-muted-foreground border rounded-lg">
                Призовой фонд: {c.total_prize_pool ? formatPrice(Number(c.total_prize_pool)) : '—'}.
                Распределение призов появится при анонсе.
              </div>
            ) : (
              prizeBreakdown.map((p) => (
                <Card key={p.place}>
                  <CardContent className="pt-6 flex items-center justify-between">
                    <div>
                      <div className="text-sm text-muted-foreground">{p.place} место</div>
                      <div className="text-2xl font-bold">{formatPrice(p.amount)}</div>
                      {p.extra && (
                        <div className="text-sm text-primary mt-1">+ {p.extra}</div>
                      )}
                    </div>
                    <div className="text-4xl">
                      {['🥇', '🥈', '🥉'][p.place - 1] ?? '🎖'}
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-semibold mt-1">{value}</div>
    </div>
  );
}
