import * as React from 'react';
import { db, sql } from '@/lib/db';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { OrgRowActions } from './OrgRowActions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Организации — AIAG Admin' };

type OrgRow = {
  id: string;
  slug: string;
  name: string;
  owner_email: string | null;
  members_count: number;
  subscription_credits: string;
  payg_credits: string;
  status: string;
};

async function fetchOrgs(): Promise<OrgRow[]> {
  try {
    const r = await db.execute(sql`
      SELECT o.id::text, o.slug, o.name,
             u.email AS owner_email,
             (SELECT COUNT(*)::int FROM organization_members WHERE organization_id = o.id) AS members_count,
             o.subscription_credits::text,
             o.payg_credits::text,
             COALESCE(o.status, 'active') AS status
      FROM organizations o
      LEFT JOIN users u ON u.id = o.owner_id
      ORDER BY o.created_at DESC
      LIMIT 200
    `);
    return ((r as unknown as { rows?: OrgRow[] }).rows ?? (r as unknown as OrgRow[])) || [];
  } catch (e) {
    console.error('[admin/orgs] fetch failed', e);
    return [];
  }
}

export default async function AdminOrgsPage() {
  const rows = await fetchOrgs();

  return (
    <div className="container mx-auto px-4 py-8 max-w-7xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold tracking-tight">Организации</h1>
        <Badge variant="outline">{rows.length}</Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Список</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase">
              <tr>
                <th className="text-left px-3 py-2">Слаг</th>
                <th className="text-left px-3 py-2">Название</th>
                <th className="text-left px-3 py-2">Владелец</th>
                <th className="text-right px-3 py-2">Участники</th>
                <th className="text-right px-3 py-2">Подписка ₽</th>
                <th className="text-right px-3 py-2">PAYG ₽</th>
                <th className="text-left px-3 py-2">Статус</th>
                <th className="text-right px-3 py-2">Действия</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id} className="border-t aiag-row-hover">
                  <td className="px-3 py-2 font-mono text-xs">{o.slug}</td>
                  <td className="px-3 py-2">{o.name}</td>
                  <td className="px-3 py-2 text-xs">{o.owner_email ?? '—'}</td>
                  <td className="px-3 py-2 text-right">{o.members_count}</td>
                  <td className="px-3 py-2 text-right">{Number(o.subscription_credits).toFixed(2)}</td>
                  <td className="px-3 py-2 text-right">{Number(o.payg_credits).toFixed(2)}</td>
                  <td className="px-3 py-2">
                    <Badge variant={o.status === 'active' ? 'outline' : 'destructive'}>{o.status}</Badge>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <OrgRowActions orgId={o.id} status={o.status} />
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                    Нет данных
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
