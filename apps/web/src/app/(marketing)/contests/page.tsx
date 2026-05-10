import Link from 'next/link';
import { db, sql } from '@/lib/db';
import ContestCard, { ContestCardData } from './ContestCard';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';

export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Конкурсы AI — AI-Aggregator',
  description:
    'Участвуйте в конкурсах по машинному обучению, соревнуйтесь за призы и публикуйте свои модели в маркетплейсе AIAG.',
};

interface ContestRow {
  id: string;
  slug: string;
  name: string;
  short_description: string | null;
  banner: string | null;
  sponsor_name: string | null;
  total_prize_pool: string | null;
  total_participants: number;
  starts_at: string | null;
  ends_at: string | null;
  status: string;
}

async function fetchContests(): Promise<ContestCardData[]> {
  try {
    const r = await db.execute(sql`
      SELECT c.id::text AS id, c.slug, c.name, c.short_description, c.banner,
             o.name AS sponsor_name,
             c.total_prize_pool::text AS total_prize_pool,
             c.total_participants,
             c.starts_at::text AS starts_at,
             c.ends_at::text AS ends_at,
             c.status::text AS status
      FROM contests c
      LEFT JOIN organizations o ON o.id = c.organization_id
      WHERE c.is_public = true
      ORDER BY c.starts_at DESC NULLS LAST
      LIMIT 100
    `);
    const rows = (((r as unknown as { rows?: unknown[] }).rows ?? r) as ContestRow[]);
    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      shortDescription: row.short_description ?? '',
      banner: row.banner,
      sponsorName: row.sponsor_name,
      prizePoolRub: row.total_prize_pool ? Number(row.total_prize_pool) : 0,
      participantsCount: row.total_participants ?? 0,
      startsAt: row.starts_at ? new Date(row.starts_at) : new Date(),
      endsAt: row.ends_at ? new Date(row.ends_at) : new Date(),
      status: row.status as ContestCardData['status'],
    }));
  } catch {
    return [];
  }
}

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
    <div className="container mx-auto px-4 py-10 max-w-6xl">
      <header className="mb-8">
        <h1 className="text-4xl font-bold tracking-tight mb-2">Конкурсы AI</h1>
        <p className="text-muted-foreground text-lg">
          Соревнуйтесь с другими ML-инженерами, получайте призы и публикуйте модели в маркетплейсе с revshare 70–85%.
        </p>
      </header>

      <Tabs defaultValue={tab}>
        <TabsList>
          <TabsTrigger value="active" asChild>
            <Link href="/contests?tab=active">Активные ({active.length})</Link>
          </TabsTrigger>
          <TabsTrigger value="upcoming" asChild>
            <Link href="/contests?tab=upcoming">Скоро ({upcoming.length})</Link>
          </TabsTrigger>
          <TabsTrigger value="past" asChild>
            <Link href="/contests?tab=past">Прошедшие ({past.length})</Link>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="active" className="mt-6">
          <ContestGrid contests={active} emptyText="Нет активных конкурсов." />
        </TabsContent>
        <TabsContent value="upcoming" className="mt-6">
          <ContestGrid contests={upcoming} emptyText="Пока не анонсировано новых конкурсов." />
        </TabsContent>
        <TabsContent value="past" className="mt-6">
          <ContestGrid contests={past} emptyText="Прошедших конкурсов ещё нет." />
        </TabsContent>
      </Tabs>
    </div>
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
    return <div className="py-12 text-center text-muted-foreground">{emptyText}</div>;
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {contests.map((c) => (
        <ContestCard key={c.id} contest={c} />
      ))}
    </div>
  );
}
