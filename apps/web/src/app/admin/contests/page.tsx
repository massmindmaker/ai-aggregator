import * as React from 'react';
import Link from 'next/link';
import { db, sql } from '@/lib/db';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { ContestStatusActions } from './ContestStatusActions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Контесты — AIAG Admin' };

type Row = {
  id: string;
  slug: string;
  name: string;
  status: string;
  starts_at: string | null;
  ends_at: string | null;
  total_prize_pool: string | null;
  total_submissions: number;
};

async function fetchContests(): Promise<Row[]> {
  try {
    const r = await db.execute(sql`
      SELECT id::text, slug, name, status::text, starts_at, ends_at,
             total_prize_pool::text, total_submissions
      FROM contests ORDER BY created_at DESC LIMIT 200
    `);
    return ((r as unknown as { rows?: Row[] }).rows ?? (r as unknown as Row[])) || [];
  } catch (e) {
    console.error(e);
    return [];
  }
}

export default async function AdminContestsPage() {
  const rows = await fetchContests();

  return (
    <div className="container mx-auto px-4 py-8 max-w-7xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold tracking-tight">Контесты</h1>
        <Link
          href="/admin/contests/new"
          className="px-4 py-2 rounded-md bg-amber-500 text-black text-sm font-medium hover:bg-amber-400"
        >
          + Создать
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Все контесты ({rows.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase">
              <tr>
                <th className="text-left px-3 py-2">Слаг</th>
                <th className="text-left px-3 py-2">Название</th>
                <th className="text-left px-3 py-2">Статус</th>
                <th className="text-left px-3 py-2">Начало</th>
                <th className="text-left px-3 py-2">Конец</th>
                <th className="text-right px-3 py-2">Призовой ₽</th>
                <th className="text-right px-3 py-2">Сабмишны</th>
                <th className="text-right px-3 py-2">Действия</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="border-t">
                  <td className="px-3 py-2 font-mono text-xs">{c.slug}</td>
                  <td className="px-3 py-2">{c.name}</td>
                  <td className="px-3 py-2">
                    <Badge variant={c.status === 'active' ? 'default' : 'outline'}>{c.status}</Badge>
                  </td>
                  <td className="px-3 py-2 text-xs">{c.starts_at ? new Date(c.starts_at).toLocaleDateString('ru-RU') : '—'}</td>
                  <td className="px-3 py-2 text-xs">{c.ends_at ? new Date(c.ends_at).toLocaleDateString('ru-RU') : '—'}</td>
                  <td className="px-3 py-2 text-right">{Number(c.total_prize_pool ?? 0).toFixed(2)}</td>
                  <td className="px-3 py-2 text-right">{c.total_submissions}</td>
                  <td className="px-3 py-2 text-right">
                    <span className="inline-flex items-center gap-2">
                      <ContestStatusActions slug={c.slug} status={c.status} />
                      <Link
                        href={`/admin/contests/${c.slug}`}
                        className="text-amber-500 hover:text-amber-400 text-xs"
                      >
                        Открыть →
                      </Link>
                    </span>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                    Нет контестов
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
