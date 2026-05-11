import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { db, sql } from '@/lib/db';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Выплаты — AI-Aggregator' };

interface Row {
  id: string;
  amount: string;
  currency: string;
  status: string;
  period_start: string;
  period_end: string;
  processed_at: string | null;
  transaction_id: string | null;
}

const STATUS: Record<
  string,
  { label: string; variant: 'default' | 'success' | 'warning' | 'destructive' | 'outline' }
> = {
  pending: { label: 'Ожидает', variant: 'outline' },
  approved: { label: 'Одобрена', variant: 'warning' },
  processing: { label: 'В работе', variant: 'warning' },
  paid: { label: 'Выплачена', variant: 'success' },
  failed: { label: 'Ошибка', variant: 'destructive' },
  rejected: { label: 'Отклонена', variant: 'destructive' },
};

export default async function PayoutsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login?callbackUrl=/dashboard/payouts');

  let rows: Row[] = [];
  try {
    const r = await db.execute(sql`
      SELECT id::text AS id, amount::text AS amount, currency, status,
             period_start::text AS period_start, period_end::text AS period_end,
             processed_at::text AS processed_at, transaction_id
      FROM payouts
      WHERE user_id = ${session.user.id}::uuid
      ORDER BY period_start DESC
      LIMIT 100
    `);
    rows = (((r as unknown as { rows?: unknown[] }).rows ?? r) as Row[]);
  } catch {
    rows = [];
  }

  return (
    <section className="container mx-auto max-w-5xl px-6 py-10">
      <h1 className="text-3xl font-bold tracking-tight mb-2">Выплаты</h1>
      <p className="text-muted-foreground mb-6">
        Регулярные перечисления вашего заработка автора на привязанные реквизиты.
      </p>

      {rows.length === 0 ? (
        <div
          className="rounded-md border"
          style={{ borderColor: 'var(--line)' }}
        >
          <EmptyState
            illustration="wallet"
            title="Пока ни одной выплаты"
            description="Выплаты создаются 2-го числа каждого месяца за фиксированный заработок предыдущего периода."
            actionLabel="К заработку"
            actionHref="/dashboard/earnings"
          />
        </div>
      ) : (
        <div className="rounded-md border" style={{ borderColor: 'var(--line)' }}>
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-muted-foreground bg-muted/30">
              <tr>
                <th className="px-4 py-3 text-left">Период</th>
                <th className="px-4 py-3 text-right">Сумма</th>
                <th className="px-4 py-3 text-left">Статус</th>
                <th className="px-4 py-3 text-left">Дата выплаты</th>
                <th className="px-4 py-3 text-left font-mono text-xs">Tx</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const meta = STATUS[p.status] ?? STATUS.pending;
                return (
                  <tr key={p.id} className="border-t" style={{ borderColor: 'var(--line)' }}>
                    <td className="px-4 py-3 font-mono text-xs">
                      {p.period_start?.slice(0, 10)} — {p.period_end?.slice(0, 10)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {Number(p.amount).toLocaleString('ru-RU')} {p.currency}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={meta.variant as never}>{meta.label}</Badge>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {p.processed_at?.slice(0, 16).replace('T', ' ') ?? '—'}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground truncate max-w-[160px]">
                      {p.transaction_id ?? '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
