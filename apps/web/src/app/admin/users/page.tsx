import * as React from 'react';
import { db, sql } from '@/lib/db';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { UserRowActions } from './UserRowActions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Юзеры — AIAG Admin' };

type UserRow = {
  id: string;
  email: string;
  name: string | null;
  created_at: string;
  role: string;
  is_banned: boolean;
  last_login_at: string | null;
  balance: string | null;
  total_spent: string | null;
};

async function fetchUsers(query: string, status: string): Promise<UserRow[]> {
  try {
    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    if (query) {
      params.push(`%${query}%`);
      where.push(`(u.email ILIKE $${params.length} OR u.name ILIKE $${params.length})`);
    }
    if (status === 'banned') where.push('u.is_banned = TRUE');
    if (status === 'active') where.push('u.is_banned = FALSE');

    const result = await db.execute(sql`
      SELECT u.id::text, u.email, u.name, u.created_at, u.role::text,
             u.is_banned, u.last_login_at, u.balance::text,
             COALESCE((SELECT SUM(amount)::text FROM payments WHERE user_id = u.id AND status='confirmed'), '0') AS total_spent
      FROM users u
      ORDER BY u.created_at DESC
      LIMIT 200
    `);
    const rows = (result as unknown as { rows?: UserRow[] }).rows ?? (result as unknown as UserRow[]);
    let filtered = rows;
    if (query) {
      const q = query.toLowerCase();
      filtered = filtered.filter(
        (r) => r.email?.toLowerCase().includes(q) || r.name?.toLowerCase().includes(q)
      );
    }
    if (status === 'banned') filtered = filtered.filter((r) => r.is_banned);
    if (status === 'active') filtered = filtered.filter((r) => !r.is_banned);
    return filtered;
  } catch (e) {
    console.error('[admin/users] fetch failed', e);
    return [];
  }
}

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const sp = await searchParams;
  const q = sp.q ?? '';
  const status = sp.status ?? 'all';
  const rows = await fetchUsers(q, status);

  return (
    <div className="container mx-auto px-4 py-8 max-w-7xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold tracking-tight">Юзеры</h1>
        <Badge variant="outline">{rows.length} записей</Badge>
      </div>

      <form className="mb-4 flex gap-2 items-center" method="GET">
        <Input name="q" defaultValue={q} placeholder="email или имя" className="max-w-xs" />
        <select
          name="status"
          defaultValue={status}
          className="border rounded-md px-3 py-2 bg-background text-sm"
        >
          <option value="all">все</option>
          <option value="active">активные</option>
          <option value="banned">забаненные</option>
        </select>
        <button type="submit" className="px-4 py-2 rounded-md bg-amber-500 text-black text-sm font-medium hover:bg-amber-400">
          Найти
        </button>
      </form>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Список пользователей</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-3 py-2">Email</th>
                <th className="text-left px-3 py-2">Имя</th>
                <th className="text-left px-3 py-2">Роль</th>
                <th className="text-left px-3 py-2">Статус</th>
                <th className="text-right px-3 py-2">Баланс ₽</th>
                <th className="text-right px-3 py-2">Потратил ₽</th>
                <th className="text-left px-3 py-2">Создан</th>
                <th className="text-right px-3 py-2">Действия</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id} className="border-t aiag-row-hover">
                  <td className="px-3 py-2 font-mono text-xs">{u.email}</td>
                  <td className="px-3 py-2">{u.name ?? '—'}</td>
                  <td className="px-3 py-2">
                    <Badge variant={u.role === 'admin' ? 'default' : 'outline'}>{u.role}</Badge>
                  </td>
                  <td className="px-3 py-2">
                    {u.is_banned ? (
                      <Badge variant="destructive">забанен</Badge>
                    ) : (
                      <Badge variant="outline">активен</Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">{u.balance ?? '0'}</td>
                  <td className="px-3 py-2 text-right">
                    {(Number(u.total_spent ?? 0) || 0).toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {new Date(u.created_at).toLocaleDateString('ru-RU')}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <UserRowActions userId={u.id} email={u.email} isBanned={u.is_banned} />
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                    Ничего не найдено
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
