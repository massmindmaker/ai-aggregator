import * as React from 'react';
import Link from 'next/link';
import { db, sql } from '@/lib/db';
import { rowsOf } from '@/lib/admin/rows';
import { requireAdmin } from '@/lib/admin/guard';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { PayoutRowActions } from './PayoutRowActions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Выплаты — AIAG Admin' };

const VALID_STATUSES = ['requested', 'processing', 'paid', 'failed'] as const;
type StatusFilter = (typeof VALID_STATUSES)[number];

type PayoutsSearchParams = {
  status_filter?: string;
};

type Row = {
  id: string;
  author_id: string;
  author_email: string | null;
  kyc_status: string | null;
  kyc_type: string | null;
  amount_rub: string;
  tax_withheld_rub: string;
  net_paid_rub: string;
  method: string;
  status: string;
  requested_at: string;
  paid_at: string | null;
};

type Counters = {
  pending: number;
  processing: number;
  paid_today: number;
  failed_7d: number;
};

async function fetchCounters(): Promise<Counters> {
  try {
    const r = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE status='requested')::int AS pending,
        COUNT(*) FILTER (WHERE status='processing')::int AS processing,
        COUNT(*) FILTER (WHERE status='paid' AND paid_at::date = CURRENT_DATE)::int AS paid_today,
        COUNT(*) FILTER (WHERE status='failed' AND requested_at > NOW() - INTERVAL '7 days')::int AS failed_7d
      FROM payouts
    `);
    return (
      rowsOf<Counters>(r)[0] ?? {
        pending: 0,
        processing: 0,
        paid_today: 0,
        failed_7d: 0,
      }
    );
  } catch {
    return { pending: 0, processing: 0, paid_today: 0, failed_7d: 0 };
  }
}

async function fetchRows(status: StatusFilter): Promise<Row[]> {
  try {
    const r = await db.execute(sql`
      SELECT p.id::text, p.author_id::text,
             u.email AS author_email,
             u.kyc_status, u.kyc_type,
             p.amount_rub::text, p.tax_withheld_rub::text, p.net_paid_rub::text,
             p.method, p.status,
             p.requested_at::text AS requested_at,
             p.paid_at::text AS paid_at
      FROM payouts p
      JOIN users u ON u.id = p.author_id
      WHERE p.status = ${status}
      ORDER BY p.requested_at DESC
      LIMIT 200
    `);
    return rowsOf<Row>(r);
  } catch (e) {
    console.error('[admin/payouts] fetch failed', e);
    return [];
  }
}

function statusBadge(s: string) {
  if (s === 'paid') return <Badge variant="default">{s}</Badge>;
  if (s === 'requested' || s === 'processing')
    return <Badge variant="outline">{s}</Badge>;
  return <Badge variant="destructive">{s}</Badge>;
}

export default async function AdminPayoutsPage({
  searchParams,
}: {
  searchParams: Promise<PayoutsSearchParams>;
}) {
  await requireAdmin();
  const params = await searchParams;
  const raw = params.status_filter ?? 'requested';
  const status: StatusFilter = (
    VALID_STATUSES as readonly string[]
  ).includes(raw)
    ? (raw as StatusFilter)
    : 'requested';

  const [counters, rows] = await Promise.all([
    fetchCounters(),
    fetchRows(status),
  ]);

  return (
    <div className="container mx-auto px-4 py-8 max-w-7xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold tracking-tight">Выплаты авторам</h1>
        <Badge variant="outline">{rows.length} в фильтре</Badge>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs text-muted-foreground">
              Pending
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-amber-400">
              {counters.pending}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs text-muted-foreground">
              Processing
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{counters.processing}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs text-muted-foreground">
              Paid today
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-emerald-400">
              {counters.paid_today}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs text-muted-foreground">
              Failed 7d
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-red-400">
              {counters.failed_7d}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="mb-4 flex gap-2 items-center text-sm">
        <span className="text-muted-foreground">Фильтр:</span>
        {VALID_STATUSES.map((s) => (
          <Link
            key={s}
            href={`/admin/payouts?status_filter=${s}`}
            className={`px-3 py-1 rounded border ${
              status === s
                ? 'bg-amber-400/20 border-amber-400 text-amber-100'
                : 'border-muted text-muted-foreground hover:border-amber-400/50'
            }`}
          >
            {s}
          </Link>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            Очередь выплат — статус «{status}»
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase">
              <tr>
                <th className="text-left px-3 py-2">Email</th>
                <th className="text-left px-3 py-2">KYC</th>
                <th className="text-right px-3 py-2">Сумма ₽</th>
                <th className="text-right px-3 py-2">Удержано ₽</th>
                <th className="text-right px-3 py-2">Net ₽</th>
                <th className="text-left px-3 py-2">Method</th>
                <th className="text-left px-3 py-2">Статус</th>
                <th className="text-left px-3 py-2">Когда</th>
                <th className="text-left px-3 py-2">Действия</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="px-3 py-2 text-xs font-mono">
                    {r.author_email ?? '—'}
                  </td>
                  <td className="px-3 py-2">
                    <Badge
                      variant={
                        r.kyc_status === 'verified' ? 'default' : 'outline'
                      }
                    >
                      {r.kyc_status ?? 'none'}/{r.kyc_type ?? '—'}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {Number(r.amount_rub).toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-right text-muted-foreground">
                    {Number(r.tax_withheld_rub).toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {Number(r.net_paid_rub).toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-xs">{r.method}</td>
                  <td className="px-3 py-2">{statusBadge(r.status)}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {r.paid_at
                      ? new Date(r.paid_at).toLocaleString('ru-RU')
                      : new Date(r.requested_at).toLocaleString('ru-RU')}
                  </td>
                  <td className="px-3 py-2">
                    <PayoutRowActions
                      id={r.id}
                      amountRub={Number(r.amount_rub)}
                      kycStatus={r.kyc_status ?? 'none'}
                      kycType={r.kyc_type}
                      status={r.status}
                    />
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={9}
                    className="px-3 py-8 text-center text-muted-foreground"
                  >
                    Нет выплат в этом статусе
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
