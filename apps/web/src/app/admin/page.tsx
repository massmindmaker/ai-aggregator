import * as React from 'react';
import Link from 'next/link';
import { db, sql } from '@/lib/db';
import { rowsOf } from '@/lib/admin/rows';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { CountUp } from '@/components/ui/CountUp';
import { RevenueChart } from './RevenueChart';
import { TopOrgsChart } from './TopOrgsChart';

export const metadata = { title: 'Админка — AI-Aggregator' };
export const dynamic = 'force-dynamic';

type Kpi = {
  revenue_today: number;
  mrr: number;
  dau: number;
  mau: number;
  margin_pct: number;
};

async function getKpis(): Promise<Kpi> {
  try {
    const r = await db.execute(sql`
      WITH today AS (
        SELECT
          COALESCE(SUM(delta::numeric), 0) AS revenue_today,
          COUNT(DISTINCT org_id)::int AS active_orgs_today
        FROM gateway_transactions
        WHERE type = 'settle'
          AND created_at::date = CURRENT_DATE
      ),
      cost_24 AS (
        SELECT COALESCE(SUM(upstream_cost_usd::numeric * 100), 0) AS upstream_cost_rub_est,
               COALESCE(SUM(total_cost_rub::numeric), 0) AS revenue_24h
        FROM requests
        WHERE created_at > NOW() - INTERVAL '24 hours'
      ),
      dau AS (
        SELECT COUNT(DISTINCT o.owner_id)::int AS dau
        FROM gateway_transactions t
        JOIN organizations o ON o.id = t.org_id
        WHERE t.created_at > NOW() - INTERVAL '24 hours'
      ),
      mau AS (
        SELECT COUNT(DISTINCT o.owner_id)::int AS mau
        FROM gateway_transactions t
        JOIN organizations o ON o.id = t.org_id
        WHERE t.created_at > NOW() - INTERVAL '30 days'
      )
      SELECT
        today.revenue_today,
        cost_24.revenue_24h,
        cost_24.upstream_cost_rub_est,
        dau.dau,
        mau.mau
      FROM today, cost_24, dau, mau
    `);
    const row = rowsOf<{
      revenue_today: string | number;
      revenue_24h: string | number;
      upstream_cost_rub_est: string | number;
      dau: number;
      mau: number;
    }>(r)[0];
    if (!row) throw new Error('no row');
    const rev24 = Number(row.revenue_24h) || 0;
    const cost24 = Number(row.upstream_cost_rub_est) || 0;
    const margin = rev24 > 0 ? Math.max(0, ((rev24 - cost24) / rev24) * 100) : 0;

    // MRR
    let mrr = 0;
    try {
      const m = await db.execute(sql`
        SELECT COALESCE(SUM(p.price_rub::numeric), 0)::numeric AS mrr
        FROM subscriptions s
        LEFT JOIN pricing_plans p ON p.id = s.plan_id
        WHERE s.status = 'active'
      `);
      mrr = Number(rowsOf<{ mrr: string | number }>(m)[0]?.mrr ?? 0) || 0;
    } catch {
      // ignore — pricing_plans may not have price_rub column
    }

    return {
      revenue_today: Number(row.revenue_today) || 0,
      mrr,
      dau: row.dau ?? 0,
      mau: row.mau ?? 0,
      margin_pct: margin,
    };
  } catch (e) {
    console.error('[admin] kpis fail', e);
    return { revenue_today: 0, mrr: 0, dau: 0, mau: 0, margin_pct: 0 };
  }
}

async function getRevenueDaily(): Promise<{ date: string; total: number }[]> {
  try {
    const r = await db.execute(sql`
      SELECT to_char(d::date, 'YYYY-MM-DD') AS date,
             COALESCE(SUM(t.delta::numeric), 0)::numeric AS total
      FROM generate_series(CURRENT_DATE - INTERVAL '29 days', CURRENT_DATE, '1 day'::interval) d
      LEFT JOIN gateway_transactions t
        ON t.created_at::date = d::date AND t.type = 'settle'
      GROUP BY d
      ORDER BY d
    `);
    return rowsOf<{ date: string; total: string | number }>(r).map((row) => ({
      date: row.date,
      total: Number(row.total) || 0,
    }));
  } catch {
    return [];
  }
}

async function getTopOrgs(): Promise<{ name: string; total: number }[]> {
  try {
    const r = await db.execute(sql`
      SELECT COALESCE(o.name, t.org_id::text) AS name,
             COALESCE(SUM(t.delta::numeric), 0)::numeric AS total
      FROM gateway_transactions t
      LEFT JOIN organizations o ON o.id = t.org_id
      WHERE t.type = 'settle'
        AND t.created_at > NOW() - INTERVAL '7 days'
      GROUP BY t.org_id, o.name
      ORDER BY total DESC
      LIMIT 10
    `);
    return rowsOf<{ name: string; total: string | number }>(r).map((row) => ({
      name: row.name,
      total: Number(row.total) || 0,
    }));
  } catch {
    return [];
  }
}

async function getHealth(): Promise<{ id: string; provider: string; ok: boolean | null }[]> {
  try {
    const r = await db.execute(sql`
      SELECT u.id, u.provider,
             (SELECT ok FROM upstream_health WHERE upstream_id = u.id ORDER BY checked_at DESC LIMIT 1) AS ok
      FROM upstreams u
      WHERE u.enabled
      ORDER BY u.provider
    `);
    return rowsOf<{ id: string; provider: string; ok: boolean | null }>(r);
  } catch {
    return [];
  }
}

async function getRecentActivity(): Promise<
  { kind: string; label: string; at: string }[]
> {
  try {
    const r = await db.execute(sql`
      (SELECT 'audit' AS kind,
              actor_email || ' · ' || action AS label,
              created_at AS at
       FROM audit_log
       ORDER BY created_at DESC
       LIMIT 10)
      ORDER BY at DESC
      LIMIT 10
    `);
    return rowsOf<{ kind: string; label: string; at: string }>(r);
  } catch {
    return [];
  }
}

export default async function AdminHomePage() {
  const [kpi, daily, topOrgs, health, recent] = await Promise.all([
    getKpis(),
    getRevenueDaily(),
    getTopOrgs(),
    getHealth(),
    getRecentActivity(),
  ]);

  return (
    <div className="container mx-auto px-4 py-8 max-w-7xl">
      <h1 className="text-3xl font-bold tracking-tight mb-6">Бизнес-дашборд</h1>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs text-muted-foreground">Выручка сегодня</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-amber-400">
              <CountUp end={kpi.revenue_today} decimals={2} suffix=" ₽" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs text-muted-foreground">MRR</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">
              <CountUp end={kpi.mrr} decimals={2} suffix=" ₽" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs text-muted-foreground">DAU / MAU</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">
              <CountUp end={kpi.dau} /> / <CountUp end={kpi.mau} />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs text-muted-foreground">Маржа 24ч</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">
              <CountUp end={kpi.margin_pct} decimals={1} suffix="%" />
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Выручка, последние 30 дней</CardTitle>
          </CardHeader>
          <CardContent>
            <RevenueChart data={daily} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Топ-10 организаций (7д)</CardTitle>
          </CardHeader>
          <CardContent>
            <TopOrgsChart data={topOrgs} />
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Здоровье аплинков</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {health.map((h) => (
                <li key={h.id} className="flex items-center justify-between">
                  <Link href="/admin/upstreams" className="hover:text-amber-400">
                    {h.provider}
                  </Link>
                  <span
                    className={`inline-block w-2.5 h-2.5 rounded-full ${
                      h.ok === true
                        ? 'bg-green-500'
                        : h.ok === false
                          ? 'bg-red-500'
                          : 'bg-gray-500'
                    }`}
                  />
                </li>
              ))}
              {health.length === 0 && (
                <li className="text-muted-foreground">Нет данных</li>
              )}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Последние события</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-xs">
              {recent.map((r, i) => (
                <li
                  key={i}
                  className="flex items-center justify-between border-b border-border/40 pb-1"
                >
                  <span>
                    <Badge variant="outline" className="mr-2 text-[10px]">
                      {r.kind}
                    </Badge>
                    {r.label}
                  </span>
                  <span className="text-muted-foreground">
                    {new Date(r.at).toLocaleString('ru-RU')}
                  </span>
                </li>
              ))}
              {recent.length === 0 && (
                <li className="text-muted-foreground">Пусто</li>
              )}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
