import * as React from 'react';
import { db, sql } from '@/lib/db';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { rowsOf } from '@/lib/admin/rows';
import { EmptyState } from '@/components/ui/EmptyState';
import { PromoCreateForm } from './PromoCreateForm';
import { PromoRowActions } from './PromoRowActions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Промокоды — AIAG Admin' };

interface PromoRow {
  id: string;
  code: string;
  description: string | null;
  kind: string;
  value: string;
  min_amount_rub: string | null;
  max_uses: number | null;
  uses_count: number;
  per_user_limit: number;
  valid_from: string | null;
  valid_until: string | null;
  applies_to: string;
  active: boolean;
  created_at: string;
}

async function fetchPromos(): Promise<PromoRow[]> {
  try {
    const r = await db.execute(sql`
      SELECT id::text, code, description, kind, value::text,
             min_amount_rub::text, max_uses, uses_count, per_user_limit,
             valid_from::text, valid_until::text, applies_to, active, created_at::text
      FROM promo_codes
      ORDER BY created_at DESC
      LIMIT 200
    `);
    return rowsOf<PromoRow>(r);
  } catch (e) {
    console.error(e);
    return [];
  }
}

export default async function AdminPromosPage() {
  const promos = await fetchPromos();
  return (
    <div className="container mx-auto px-4 py-8 max-w-7xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Промокоды</h1>
        <Badge variant="outline">{promos.length}</Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Создать промокод</CardTitle>
        </CardHeader>
        <CardContent>
          <PromoCreateForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Все промокоды</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-3 py-2">Код</th>
                <th className="text-left px-3 py-2">Тип</th>
                <th className="text-right px-3 py-2">Значение</th>
                <th className="text-right px-3 py-2">Мин ₽</th>
                <th className="text-right px-3 py-2">Использ.</th>
                <th className="text-left px-3 py-2">Действует до</th>
                <th className="text-left px-3 py-2">Статус</th>
                <th className="text-right px-3 py-2">Действия</th>
              </tr>
            </thead>
            <tbody>
              {promos.map((p) => (
                <tr key={p.id} className="border-t">
                  <td className="px-3 py-2 font-mono text-xs">{p.code}</td>
                  <td className="px-3 py-2 text-xs">{p.kind}</td>
                  <td className="px-3 py-2 text-right">
                    {p.kind === 'percent_off'
                      ? `${Number(p.value).toFixed(0)}%`
                      : `${Number(p.value).toFixed(2)} ₽`}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {p.min_amount_rub ? Number(p.min_amount_rub).toFixed(2) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-xs">
                    {p.uses_count} / {p.max_uses ?? '∞'}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {p.valid_until ? new Date(p.valid_until).toLocaleDateString('ru-RU') : '—'}
                  </td>
                  <td className="px-3 py-2">
                    {p.active ? <Badge>активен</Badge> : <Badge variant="outline">отключён</Badge>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <PromoRowActions id={p.id} active={p.active} />
                  </td>
                </tr>
              ))}
              {promos.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3">
                    <EmptyState
                      title="Промокодов нет"
                      description="Создайте первый промокод в форме выше."
                      size="sm"
                    />
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
