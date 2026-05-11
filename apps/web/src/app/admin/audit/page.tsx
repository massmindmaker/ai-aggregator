import * as React from 'react';
import { db, sql } from '@/lib/db';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Аудит — AIAG Admin' };

type Row = {
  id: number;
  actor_email: string;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  details: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
};

async function fetchAudit(filter: { actor: string; action: string; from: string; to: string }): Promise<Row[]> {
  try {
    const r = await db.execute(sql`
      SELECT id, actor_email, action, resource_type, resource_id, details, ip_address, created_at
      FROM audit_log
      WHERE
        (${filter.actor} = '' OR actor_email ILIKE '%' || ${filter.actor} || '%') AND
        (${filter.action} = '' OR action ILIKE '%' || ${filter.action} || '%') AND
        (${filter.from} = '' OR created_at >= ${filter.from}::timestamptz) AND
        (${filter.to} = '' OR created_at <= ${filter.to}::timestamptz)
      ORDER BY created_at DESC
      LIMIT 500
    `);
    return ((r as unknown as { rows?: Row[] }).rows ?? (r as unknown as Row[])) || [];
  } catch (e) {
    console.error(e);
    return [];
  }
}

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ actor?: string; action?: string; from?: string; to?: string }>;
}) {
  const sp = await searchParams;
  const f = { actor: sp.actor ?? '', action: sp.action ?? '', from: sp.from ?? '', to: sp.to ?? '' };
  const rows = await fetchAudit(f);

  return (
    <div className="container mx-auto px-4 py-8 max-w-7xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold tracking-tight">Аудит</h1>
        <a
          href={`/api/admin/audit?actor=${encodeURIComponent(f.actor)}&action=${encodeURIComponent(
            f.action
          )}&from=${encodeURIComponent(f.from)}&to=${encodeURIComponent(f.to)}&format=csv`}
          className="px-4 py-2 rounded-md bg-amber-500 text-black text-sm font-medium hover:bg-amber-400"
        >
          Export CSV
        </a>
      </div>

      <form className="mb-4 flex gap-2 flex-wrap" method="GET">
        <Input name="actor" placeholder="actor email" defaultValue={f.actor} className="max-w-xs" />
        <Input name="action" placeholder="action" defaultValue={f.action} className="max-w-xs" />
        <Input name="from" type="datetime-local" defaultValue={f.from} />
        <Input name="to" type="datetime-local" defaultValue={f.to} />
        <button type="submit" className="px-4 py-2 rounded-md border text-sm hover:bg-accent">
          Применить
        </button>
      </form>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Последние {rows.length} записей</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase">
              <tr>
                <th className="text-left px-3 py-2">Когда</th>
                <th className="text-left px-3 py-2">Кто</th>
                <th className="text-left px-3 py-2">Action</th>
                <th className="text-left px-3 py-2">Resource</th>
                <th className="text-left px-3 py-2">Details</th>
                <th className="text-left px-3 py-2">IP</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t align-top aiag-row-hover">
                  <td className="px-3 py-2 text-xs whitespace-nowrap">
                    {new Date(r.created_at).toLocaleString('ru-RU')}
                  </td>
                  <td className="px-3 py-2 text-xs font-mono">{r.actor_email}</td>
                  <td className="px-3 py-2">
                    <Badge variant="outline">{r.action}</Badge>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.resource_type ?? '—'}
                    {r.resource_id && <span className="text-muted-foreground"> / {r.resource_id}</span>}
                  </td>
                  <td className="px-3 py-2 text-xs font-mono max-w-md truncate">
                    {r.details ? JSON.stringify(r.details) : '—'}
                  </td>
                  <td className="px-3 py-2 text-xs">{r.ip_address ?? '—'}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                    Пусто
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
