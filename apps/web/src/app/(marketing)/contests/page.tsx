import * as React from 'react';
import Link from 'next/link';
import MainLayout from '@/components/layout/MainLayout';
import ContestCard, { ContestCardData } from './ContestCard';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';

export const metadata = {
  title: 'Конкурсы AI — AI-Aggregator',
  description:
    'Участвуйте в конкурсах по машинному обучению, соревнуйтесь за призы и публикуйте свои модели в маркетплейсе AIAG.',
};

// MVP: mock data — реальная выборка из Postgres в Task 22 (seed launch contest).
// Plan 07 Task 3: listing должен фильтроваться по статусу.
const MOCK_CONTESTS: ContestCardData[] = [
  {
    id: 'banking-tx',
    slug: 'launch-banking-tx',
    name: 'Классификация банковских транзакций',
    shortDescription:
      'Определите категорию транзакции по описанию платежа. F1-score на private split.',
    banner: null,
    sponsorName: 'Банк пример',
    prizePoolRub: 500_000,
    participantsCount: 142,
    startsAt: new Date('2026-04-15T00:00:00Z'),
    endsAt: new Date('2026-06-15T00:00:00Z'),
    status: 'open',
  },
  {
    id: 'doc-summary',
    slug: 'ru-doc-summarization',
    name: 'Резюмирование русских документов',
    shortDescription:
      'Сжатое описание юридических документов объёмом 5–15 страниц. Метрика — ROUGE-L.',
    banner: null,
    sponsorName: null,
    prizePoolRub: 250_000,
    participantsCount: 37,
    startsAt: new Date('2026-05-01T00:00:00Z'),
    endsAt: new Date('2026-07-01T00:00:00Z'),
    status: 'upcoming',
  },
  {
    id: 'ru-ner',
    slug: 'ru-ner-medical',
    name: 'NER для медицинских текстов',
    shortDescription:
      'Извлечение сущностей (симптомы, диагнозы, препараты) из анамнезов. Метрика — F1.',
    banner: null,
    sponsorName: 'HealthTech RU',
    prizePoolRub: 1_000_000,
    participantsCount: 284,
    startsAt: new Date('2026-01-15T00:00:00Z'),
    endsAt: new Date('2026-04-01T00:00:00Z'),
    status: 'completed',
  },
];

type StatusFilter = 'active' | 'upcoming' | 'past';

function filterByTab(
  contests: ContestCardData[],
  tab: StatusFilter
): ContestCardData[] {
  if (tab === 'active') {
    return contests.filter((c) =>
      ['active', 'evaluation'].includes(c.status as string)
    );
  }
  if (tab === 'upcoming') {
    return contests.filter((c) => c.status === 'upcoming' || c.status === 'pending_review');
  }
  return contests.filter((c) =>
    ['completed', 'cancelled'].includes(c.status as string)
  );
}

export default async function ContestsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: StatusFilter }>;
}) {
  const params = await searchParams;
  const tab: StatusFilter = params?.tab ?? 'active';
  const all = await fetchContests();
  const active = filterByTab(all, 'active');
  const upcoming = filterByTab(all, 'upcoming');
  const past = filterByTab(all, 'past');

  return (
    <>
      <div className="container mx-auto px-4 py-10 max-w-6xl">
        <header className="mb-8">
          <h1 className="text-4xl font-bold tracking-tight mb-2">
            Конкурсы AI
          </h1>
          <p className="text-muted-foreground text-lg">
            Соревнуйтесь с другими ML-инженерами, получайте призы и публикуйте
            модели в маркетплейсе с revshare 70–85%.
          </p>
        </header>

        <Tabs defaultValue={tab}>
          <TabsList>
            <TabsTrigger value="active" asChild>
              <Link href="/contests?tab=active">
                Активные ({active.length})
              </Link>
            </TabsTrigger>
            <TabsTrigger value="upcoming" asChild>
              <Link href="/contests?tab=upcoming">
                Скоро ({upcoming.length})
              </Link>
            </TabsTrigger>
            <TabsTrigger value="past" asChild>
              <Link href="/contests?tab=past">Прошедшие ({past.length})</Link>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="active" className="mt-6">
            <ContestGrid contests={active} emptyText="Нет активных конкурсов." />
          </TabsContent>
          <TabsContent value="upcoming" className="mt-6">
            <ContestGrid
              contests={upcoming}
              emptyText="Пока не анонсировано новых конкурсов."
            />
          </TabsContent>
          <TabsContent value="past" className="mt-6">
            <ContestGrid
              contests={past}
              emptyText="Прошедших конкурсов ещё нет."
            />
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}

function ContestGrid({
  contests,
  emptyText,
}: {
  contests: ContestCardData[];
  emptyText: string;
}) {
  if (contests.length === 0) {
    return (
      <div className="py-12 text-center text-muted-foreground">{emptyText}</div>
    );
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {contests.map((c) => (
        <ContestCard key={c.id} contest={c} />
      ))}
    </div>
  );
}
