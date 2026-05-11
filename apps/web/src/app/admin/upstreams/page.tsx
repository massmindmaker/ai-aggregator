import * as React from 'react';
import { db, sql } from '@/lib/db';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Sparkline } from '@/components/ui/Sparkline';
import { UpstreamRowActions } from './UpstreamRowActions';

// FIXME: replace with real per-upstream latency series (hourly bins from upstream_health)
function placeholderLatency(seed: string, len = 12): number[] {
  let h = 0;
  for (const c of seed) h = ((h << 5) - h + c.charCodeAt(0)) | 0;
  const rng = (i: number) =>
    Math.sin(h + i * 0.9) * 30 + 150 + Math.sin(i * 0.4) * 15;
  return Array.from({ length: len }, (_, i) => Math.max(20, rng(i)));
}

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Аплинки — AIAG Admin' };

type Row = {
  id: string;
  provider: string;
  enabled: boolean;
  latency_p50_ms: number;
  uptime: string;
  last_checked_at: string | null;
  last_ok: boolean | null;
  requests_24h: number;
  errors_24h: number;
  metadata: Record<string, unknown> | null;
};

async function fetchUpstreams(): Promise<Row[]> {
  try {
    const r = await db.execute(sql`
      SELECT u.id, u.provider, u.enabled, u.latency_p50_ms, u.uptime::text,
             u.metadata,
             (SELECT checked_at FROM upstream_health WHERE upstream_id = u.id ORDER BY checked_at DESC LIMIT 1) AS last_checked_at,
             (SELECT ok FROM upstream_health WHERE upstream_id = u.id ORDER BY checked_at DESC LIMIT 1) AS last_ok,
             COALESCE((SELECT COUNT(*)::int FROM requests r WHERE r.upstream_id = u.id AND r.created_at > NOW() - INTERVAL '24 hours'), 0) AS requests_24h,
             COALESCE((SELECT COUNT(*)::int FROM requests r WHERE r.upstream_id = u.id AND r.created_at > NOW() - INTERVAL '24 hours' AND r.status_code >= 500), 0) AS errors_24h
      FROM upstreams u
      ORDER BY u.provider
    `);
    return ((r as unknown as { rows?: Row[] }).rows ?? (r as unknown as Row[])) || [];
  } catch (e) {
    console.error('[admin/upstreams] fetch failed', e);
    return [];
  }
}

function statusOf(r: Row): {
  label: string;
  color: 'default' | 'destructive' | 'outline';
  dot: 'success' | 'danger' | 'muted';
} {
  if (!r.enabled) return { label: 'отключён', color: 'outline', dot: 'muted' };
  if (r.last_ok === false) return { label: 'down', color: 'destructive', dot: 'danger' };
  if (r.errors_24h > 0 && r.requests_24h > 0 && r.errors_24h / r.requests_24h > 0.1)
    return { label: 'degraded', color: 'destructive', dot: 'danger' };
  if (r.last_ok === true) return { label: 'online', color: 'default', dot: 'success' };
  return { label: 'unknown', color: 'outline', dot: 'muted' };
}

export default async function AdminUpstreamsPage() {
  const rows = await fetchUpstreams();

  return (
    <div className="container mx-auto px-4 py-8 max-w-7xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold tracking-tight">Аплинки</h1>
        <Badge variant="outline">{rows.length} провайдеров</Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Провайдеры и здоровье</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase">
              <tr>
                <th className="text-left px-3 py-2">ID</th>
                <th className="text-left px-3 py-2">Провайдер</th>
                <th className="text-left px-3 py-2">Статус</th>
                <th className="text-right px-3 py-2">Latency p50</th>
                <th className="text-right px-3 py-2">Req 24h</th>
                <th className="text-right px-3 py-2">Err rate</th>
                <th className="text-right px-3 py-2">Markup %</th>
                <th className="text-left px-3 py-2">Последняя проба</th>
                <th className="text-right px-3 py-2">Действия</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const s = statusOf(r);
                const errRate =
                  r.requests_24h > 0 ? ((r.errors_24h / r.requests_24h) * 100).toFixed(1) : '—';
                const markup = (r.metadata as { markup_pct?: number } | null)?.markup_pct ?? 0;
                return (
                  <tr key={r.id} className="border-t aiag-row-hover">
                    <td className="px-3 py-2 font-mono text-xs">{r.id}</td>
                    <td className="px-3 py-2">{r.provider}</td>
                    <td className="px-3 py-2">
                      <Badge variant={s.color} className="inline-flex items-center gap-1.5">
                        <span
                          className={`aiag-pulse-dot aiag-pulse-dot-${s.dot}`}
                          style={{ width: 6, height: 6 }}
                          aria-hidden
                        />
                        {s.label}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex items-center gap-2 justify-end">
                        <Sparkline
                          data={placeholderLatency(r.id, 12)}
                          width={60}
                          height={18}
                          strokeWidth={1}
                          color={r.latency_p50_ms > 500 ? '#ef4444' : '#22c55e'}
                          animate={false}
                        />
                        <span>{r.latency_p50_ms} ms</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right">{r.requests_24h}</td>
                    <td className="px-3 py-2 text-right">{errRate}%</td>
                    <td className="px-3 py-2 text-right">{markup}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {r.last_checked_at ? new Date(r.last_checked_at).toLocaleString('ru-RU') : '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <UpstreamRowActions
                        upstreamId={r.id}
                        enabled={r.enabled}
                        markupPct={markup}
                      />
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">
                    Нет аплинков
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
