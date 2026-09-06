import * as React from 'react';
import { db, sql } from '@/lib/db';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { rowsOf } from '@/lib/admin/rows';
import { ReferralRowActions } from './ReferralRowActions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Рефералы — AIAG Admin' };

interface LeaderRow {
  user_id: string;
  email: string;
  qualifying_count: number;
  total_paid_rub: string;
}
interface RedemptionRow {
  id: string;
  referrer_email: string;
  referred_email: string;
  bonus_referrer_rub: string;
  bonus_referred_rub: string;
  paid_out: boolean;
  fraud_flagged: boolean;
  fraud_reason: string | null;
  redeemed_at: string;
}

async function fetchLeaders(): Promise<LeaderRow[]> {
  try {
    const r = await db.execute(sql`
      SELECT u.id::text AS user_id, u.email,
             COUNT(rr.id)::int AS qualifying_count,
             COALESCE(SUM(rr.bonus_referrer_rub) FILTER (WHERE rr.paid_out), 0)::text AS total_paid_rub
      FROM users u
      JOIN referral_redemptions rr ON rr.referrer_user_id = u.id
      WHERE rr.fraud_flagged = false
      GROUP BY u.id, u.email
      ORDER BY total_paid_rub::numeric DESC, qualifying_count DESC
      LIMIT 50
    `);
    return rowsOf<LeaderRow>(r);
  } catch (e) {
    console.error(e);
    return [];
  }
}

async function fetchRedemptions(filter: string): Promise<RedemptionRow[]> {
  let where = 'TRUE';
  if (filter === 'pending') where = 'rr.paid_out = false AND rr.fraud_flagged = false';
  else if (filter === 'paid') where = 'rr.paid_out = true';
  else if (filter === 'fraud') where = 'rr.fraud_flagged = true';
  try {
    const r = await db.execute(sql`
      SELECT rr.id::text,
             ru.email AS referrer_email,
             tu.email AS referred_email,
             rr.bonus_referrer_rub::text,
             rr.bonus_referred_rub::text,
             rr.paid_out, rr.fraud_flagged, rr.fraud_reason,
             rr.redeemed_at::text
      FROM referral_redemptions rr
      JOIN users ru ON ru.id = rr.referrer_user_id
      JOIN users tu ON tu.id = rr.referred_user_id
      WHERE ${sql.raw(where)}
      ORDER BY rr.redeemed_at DESC
      LIMIT 200
    `);
    return rowsOf<RedemptionRow>(r);
  } catch (e) {
    console.error(e);
    return [];
  }
}

export default async function AdminReferralsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const sp = await searchParams;
  const filter = sp.filter ?? 'all';

  const [leaders, redemptions] = await Promise.all([fetchLeaders(), fetchRedemptions(filter)]);

  return (
    <div className="container mx-auto px-4 py-8 max-w-7xl space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">Реферальная программа</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Топ-50 рефереров (по выплачено ₽)</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-3 py-2">Email</th>
                <th className="text-right px-3 py-2">Привлёк</th>
                <th className="text-right px-3 py-2">Выплачено ₽</th>
              </tr>
            </thead>
            <tbody>
              {leaders.map((l) => (
                <tr key={l.user_id} className="border-t">
                  <td className="px-3 py-2 font-mono text-xs">{l.email}</td>
                  <td className="px-3 py-2 text-right">{l.qualifying_count}</td>
                  <td className="px-3 py-2 text-right">
                    {Number(l.total_paid_rub ?? 0).toFixed(2)}
                  </td>
                </tr>
              ))}
              {leaders.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-3 py-8 text-center text-muted-foreground">
                    Пока нет данных
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center justify-between">
            <span>Все redemption&apos;ы</span>
            <form className="flex gap-2 text-sm" method="GET">
              <select
                name="filter"
                defaultValue={filter}
                className="border rounded-md px-2 py-1 bg-background text-xs"
              >
                <option value="all">все</option>
                <option value="pending">ожидание</option>
                <option value="paid">оплачены</option>
                <option value="fraud">фрод</option>
              </select>
              <button type="submit" className="px-3 py-1 rounded-md border text-xs">
                Фильтр
              </button>
            </form>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-3 py-2">Реферер</th>
                <th className="text-left px-3 py-2">Приглашённый</th>
                <th className="text-right px-3 py-2">Бонус реф. ₽</th>
                <th className="text-right px-3 py-2">Бонус нов. ₽</th>
                <th className="text-left px-3 py-2">Статус</th>
                <th className="text-left px-3 py-2">Дата</th>
                <th className="text-right px-3 py-2">Действия</th>
              </tr>
            </thead>
            <tbody>
              {redemptions.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="px-3 py-2 font-mono text-xs">{r.referrer_email}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.referred_email}</td>
                  <td className="px-3 py-2 text-right">
                    {Number(r.bonus_referrer_rub).toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {Number(r.bonus_referred_rub).toFixed(2)}
                  </td>
                  <td className="px-3 py-2">
                    {r.fraud_flagged ? (
                      <Badge variant="destructive" title={r.fraud_reason ?? ''}>
                        фрод
                      </Badge>
                    ) : r.paid_out ? (
                      <Badge>оплачен</Badge>
                    ) : (
                      <Badge variant="outline">ожидание</Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {new Date(r.redeemed_at).toLocaleString('ru-RU')}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <ReferralRowActions
                      id={r.id}
                      paidOut={r.paid_out}
                      fraudFlagged={r.fraud_flagged}
                    />
                  </td>
                </tr>
              ))}
              {redemptions.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
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
