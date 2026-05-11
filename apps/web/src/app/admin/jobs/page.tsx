import * as React from 'react';
import { db, sql } from '@/lib/db';
import { rowsOf } from '@/lib/admin/rows';
import { requireAdmin } from '@/lib/admin/guard';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { JobRowActions } from './JobRowActions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Async Jobs — AIAG Admin' };

type Row = {
  id: string;
  task_id: string;
  status: string;
  upstream_id: string;
  model_slug: string;
  org_id: string;
  user_email: string | null;
  created_at: string;
  completed_at: string | null;
  output: Record<string, unknown> | null;
  error_message: string | null;
};

export type JobsSearchParams = {
  status?: string;
  upstream?: string;
  from?: string;
  to?: string;
};

async function fetchJobs(params: JobsSearchParams): Promise<Row[]> {
  try {
    const status = params.status ?? null;
    const upstream = params.upstream ?? null;
    const now = Date.now();
    const to = params.to ? new Date(params.to) : new Date(now);
    const from = params.from ? new Date(params.from) : new Date(now - 7 * 24 * 3600_000);

    const r = await db.execute(sql`
      SELECT j.id::text AS id,
             j.task_id, j.status, j.upstream_id, j.model_slug,
             j.org_id::text AS org_id,
             u.email AS user_email,
             j.created_at, j.completed_at,
             j.output, j.error_message
      FROM prediction_jobs j
      LEFT JOIN organizations o ON o.id = j.org_id
      LEFT JOIN users u ON u.id = o.owner_id
      WHERE j.created_at >= ${from.toISOString()}::timestamptz
        AND j.created_at <= ${to.toISOString()}::timestamptz
        AND (${status}::text IS NULL OR j.status = ${status})
        AND (${upstream}::text IS NULL OR j.upstream_id = ${upstream})
      ORDER BY j.created_at DESC
      LIMIT 200
    `);
    return rowsOf<Row>(r);
  } catch (e) {
    console.error('[admin/jobs] fetch failed', e);
    return [];
  }
}

async function fetchCounters(): Promise<{
  queued: number;
  running: number;
  completed_today: number;
  failed: number;
}> {
  try {
    const r = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
        COUNT(*) FILTER (WHERE status = 'running')::int AS running,
        COUNT(*) FILTER (WHERE status = 'completed' AND completed_at::date = CURRENT_DATE)::int AS completed_today,
        COUNT(*) FILTER (WHERE status IN ('failed','timeout','cancelled') AND created_at > NOW() - INTERVAL '24 hours')::int AS failed
      FROM prediction_jobs
    `);
    const row = rowsOf<{
      queued: number;
      running: number;
      completed_today: number;
      failed: number;
    }>(r)[0];
    return row ?? { queued: 0, running: 0, completed_today: 0, failed: 0 };
  } catch {
    return { queued: 0, running: 0, completed_today: 0, failed: 0 };
  }
}

function statusBadge(s: string) {
  if (s === 'running') {
    return (
      <Badge variant="outline" className="inline-flex items-center gap-1.5">
        <span className="aiag-pulse-dot" aria-hidden style={{ width: 6, height: 6 }} />
        {s}
      </Badge>
    );
  }
  if (s === 'completed') return <Badge variant="default">{s}</Badge>;
  if (s === 'queued') return <Badge variant="outline">{s}</Badge>;
  return <Badge variant="destructive">{s}</Badge>;
}

export default async function AdminJobsPage({
  searchParams,
}: {
  searchParams: Promise<JobsSearchParams>;
}) {
  await requireAdmin();
  const params = await searchParams;
  const [rows, counters] = await Promise.all([fetchJobs(params), fetchCounters()]);

  return (
    <div className="container mx-auto px-4 py-8 max-w-7xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold tracking-tight">Async Prediction Jobs</h1>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs text-muted-foreground">Queued</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-amber-400">{counters.queued}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs text-muted-foreground">Running</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{counters.running}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs text-muted-foreground">Completed today</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{counters.completed_today}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs text-muted-foreground">Failed 24h</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-red-400">{counters.failed}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Jobs (last 200)</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase">
              <tr>
                <th className="text-left px-3 py-2">Task ID</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-left px-3 py-2">Upstream</th>
                <th className="text-left px-3 py-2">Model</th>
                <th className="text-left px-3 py-2">User</th>
                <th className="text-left px-3 py-2">Created</th>
                <th className="text-left px-3 py-2">Completed</th>
                <th className="text-right px-3 py-2">Действия</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t aiag-row-hover">
                  <td className="px-3 py-2 font-mono text-xs">{r.task_id}</td>
                  <td className="px-3 py-2">{statusBadge(r.status)}</td>
                  <td className="px-3 py-2 text-xs">{r.upstream_id}</td>
                  <td className="px-3 py-2 text-xs">{r.model_slug}</td>
                  <td className="px-3 py-2 text-xs">{r.user_email ?? '—'}</td>
                  <td className="px-3 py-2 text-xs">
                    {new Date(r.created_at).toLocaleString('ru-RU')}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.completed_at ? new Date(r.completed_at).toLocaleString('ru-RU') : '—'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <JobRowActions
                      id={r.id}
                      status={r.status}
                      output={r.output}
                      errorMessage={r.error_message}
                    />
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                    Нет задач
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
