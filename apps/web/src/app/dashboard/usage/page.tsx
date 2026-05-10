import { redirect } from 'next/navigation';
import { Activity, Coins, Timer } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/Card';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { gatewayRequests } from '@aiag/database/schema';
import { and, eq, gte, sql } from '@aiag/database';
import { getOrCreateDefaultOrg } from '@/lib/dashboard/org';

export const dynamic = 'force-dynamic';

interface UsagePageProps {
  searchParams?: Promise<{ days?: string }>;
}

export default async function DashboardUsagePage({ searchParams }: UsagePageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect('/login?next=/dashboard/usage');

  const params = (await searchParams) ?? {};
  const days = Math.min(Math.max(Number(params.days || '30'), 1), 90);
  const orgId = await getOrCreateDefaultOrg(session.user.id);

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  let hero: {
    totalRequests: number;
    totalCostRub: string;
    avgLatencyMs: number;
  } = { totalRequests: 0, totalCostRub: '0', avgLatencyMs: 0 };
  let byDay: Array<{ day: string; totalRub: string; requests: number }> = [];
  let topModels: Array<{ modelSlug: string; totalRub: string; requests: number }> = [];

  try {
    const heroResult = await db
      .select({
        totalRequests: sql<number>`COUNT(*)::int`,
        totalCostRub: sql<string>`COALESCE(SUM(${gatewayRequests.totalCostRub}), 0)::text`,
        avgLatencyMs: sql<number>`COALESCE(AVG(${gatewayRequests.latencyMs}), 0)::int`,
      })
      .from(gatewayRequests)
      .where(
        and(
          eq(gatewayRequests.orgId, orgId),
          gte(gatewayRequests.createdAt, since7d),
        ),
      );
    if (heroResult[0]) hero = heroResult[0];

    byDay = await db
      .select({
        day: sql<string>`DATE_TRUNC('day', ${gatewayRequests.createdAt})::date::text`,
        totalRub: sql<string>`COALESCE(SUM(${gatewayRequests.totalCostRub}), 0)::text`,
        requests: sql<number>`COUNT(*)::int`,
      })
      .from(gatewayRequests)
      .where(
        and(
          eq(gatewayRequests.orgId, orgId),
          gte(gatewayRequests.createdAt, since),
        ),
      )
      .groupBy(sql`DATE_TRUNC('day', ${gatewayRequests.createdAt})`)
      .orderBy(sql`DATE_TRUNC('day', ${gatewayRequests.createdAt})`);

    topModels = await db
      .select({
        modelSlug: gatewayRequests.modelSlug,
        totalRub: sql<string>`COALESCE(SUM(${gatewayRequests.totalCostRub}), 0)::text`,
        requests: sql<number>`COUNT(*)::int`,
      })
      .from(gatewayRequests)
      .where(
        and(
          eq(gatewayRequests.orgId, orgId),
          gte(gatewayRequests.createdAt, since),
        ),
      )
      .groupBy(gatewayRequests.modelSlug)
      .orderBy(sql`SUM(${gatewayRequests.totalCostRub}) DESC`)
      .limit(10);
  } catch (e) {
    console.error('[dashboard/usage] db error', e);
  }

  const maxByDay = Math.max(1, ...byDay.map((d) => Number(d.totalRub) || 0));
  const maxTop = Math.max(1, ...topModels.map((m) => Number(m.totalRub) || 0));

  return (
    <>
      <section className="container mx-auto max-w-6xl px-4 py-10">
        <header className="mb-6">
          <h1 className="text-3xl font-bold tracking-tight">Аналитика и расходы</h1>
          <p className="text-muted-foreground mt-1">
            Сводка за последние {days} дн.
          </p>
        </header>

        <div className="grid gap-4 sm:grid-cols-3 mb-8">
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Coins className="h-4 w-4 text-primary" />
                Расход за 7 дн
              </div>
              <div className="mt-2 text-3xl font-bold">
                {Number(hero.totalCostRub).toLocaleString('ru-RU', {
                  maximumFractionDigits: 2,
                })}{' '}
                <span className="text-base text-muted-foreground">₽</span>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Activity className="h-4 w-4 text-primary" />
                Запросов за 7 дн
              </div>
              <div className="mt-2 text-3xl font-bold">
                {Number(hero.totalRequests).toLocaleString('ru-RU')}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Timer className="h-4 w-4 text-primary" />
                Средняя задержка
              </div>
              <div className="mt-2 text-3xl font-bold">
                {Number(hero.avgLatencyMs).toLocaleString('ru-RU')}{' '}
                <span className="text-base text-muted-foreground">ms</span>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="mb-6">
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-semibold">Расходы по дням</h2>
              <div className="text-xs text-muted-foreground">за {days} дн.</div>
            </div>
            {byDay.length === 0 ? (
              <p className="text-sm text-muted-foreground py-12 text-center">
                Нет данных за выбранный период.
              </p>
            ) : (
              <div className="flex items-end gap-1 h-48">
                {byDay.map((d) => {
                  const v = Number(d.totalRub) || 0;
                  const pct = (v / maxByDay) * 100;
                  return (
                    <div
                      key={d.day}
                      className="flex-1 flex flex-col items-center gap-1"
                      title={`${d.day}: ${v.toFixed(2)} ₽ (${d.requests} req)`}
                    >
                      <div
                        className="w-full rounded-t bg-primary/60 hover:bg-primary transition-colors"
                        style={{ height: `${Math.max(pct, 2)}%` }}
                      />
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex justify-between text-xs text-muted-foreground mt-2">
              <span>{byDay[0]?.day || '—'}</span>
              <span>{byDay[byDay.length - 1]?.day || '—'}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <h2 className="text-lg font-semibold mb-4">Топ-10 моделей</h2>
            {topModels.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                Нет данных.
              </p>
            ) : (
              <ul className="space-y-2">
                {topModels.map((m) => {
                  const v = Number(m.totalRub) || 0;
                  const pct = (v / maxTop) * 100;
                  return (
                    <li key={m.modelSlug}>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="font-mono text-xs">{m.modelSlug}</span>
                        <span className="tabular-nums">
                          {v.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽
                          <span className="text-muted-foreground ms-2">
                            ({m.requests} req)
                          </span>
                        </span>
                      </div>
                      <div className="h-2 bg-muted/30 rounded overflow-hidden">
                        <div
                          className="h-full bg-primary"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>
    </>
  );
}
