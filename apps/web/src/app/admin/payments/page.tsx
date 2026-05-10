import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { db, sql } from '@/lib/db';
import { users } from '@aiag/database/schema';
import { eq } from '@aiag/database';
import MainLayout from '@/components/layout/MainLayout';
import { Badge } from '@/components/ui/Badge';
import RefundButton from './RefundButton';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Платежи — AI-Aggregator' };

type Status =
  | 'pending'
  | 'authorized'
  | 'confirmed'
  | 'refunded'
  | 'partial_refunded'
  | 'cancelled'
  | 'rejected'
  | 'failed';

interface PaymentRow {
  id: string;
  created_at: string;
  user_email: string | null;
  user_name: string | null;
  amount: string; // numeric → text from PG
  currency: string;
  status: Status;
  description: string | null;
  tinkoff_payment_id: string | null;
  refunded_amount: string | null;
}

const STATUS_LABELS: Record<Status, string> = {
  pending: 'Ожидает',
  authorized: 'Авторизован',
  confirmed: 'Подтверждён',
  refunded: 'Возвращён',
  partial_refunded: 'Частично возвращён',
  cancelled: 'Отменён',
  rejected: 'Отклонён',
  failed: 'Ошибка',
};

const STATUS_VARIANT: Record<
  Status,
  'default' | 'secondary' | 'outline' | 'destructive'
> = {
  pending: 'outline',
  authorized: 'secondary',
  confirmed: 'default',
  refunded: 'secondary',
  partial_refunded: 'secondary',
  cancelled: 'outline',
  rejected: 'destructive',
  failed: 'destructive',
};

export default async function AdminPaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect('/login?callbackUrl=/admin/payments');
  const me = await db.query.users.findFirst({
    where: eq(users.email, session.user.email!),
  });
  if (!me || me.role !== 'admin') redirect('/dashboard');

  const params = await searchParams;
  const status = params.status;
  const validStatuses = new Set([
    'pending',
    'authorized',
    'confirmed',
    'refunded',
    'cancelled',
    'failed',
  ]);
  const statusFilter =
    status && validStatuses.has(status) ? (status as Status) : null;

  const r = await db.execute(sql`
    SELECT p.id::text AS id, p.created_at, p.amount::text AS amount, p.currency,
           p.status::text AS status, p.description, p.tinkoff_payment_id,
           p.refunded_amount::text AS refunded_amount,
           u.email AS user_email, u.name AS user_name
    FROM payments p
    LEFT JOIN users u ON u.id = p.user_id
    ${statusFilter ? sql`WHERE p.status::text = ${statusFilter}` : sql``}
    ORDER BY p.created_at DESC
    LIMIT 200
  `);
  const rows = ((r as unknown as { rows?: unknown[] }).rows ?? r) as PaymentRow[];

  return (
    <MainLayout>
      <section className="container mx-auto max-w-7xl px-4 py-10">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Платежи</h1>
            <p className="mt-1 text-muted-foreground">
              Все платежи и возвраты по провайдерам Tinkoff / YooKassa / СБП.
            </p>
          </div>
        </div>

        <div className="mb-6 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-4 py-3 text-sm">
          <span className="text-xs text-muted-foreground">Статус:</span>
          {(['all', 'pending', 'confirmed', 'refunded', 'cancelled', 'failed'] as const).map(
            (s) => {
              const active = (statusFilter ?? 'all') === s;
              const href = s === 'all' ? '/admin/payments' : `/admin/payments?status=${s}`;
              return (
                <a
                  key={s}
                  href={href}
                  className={`px-3 py-1 rounded-full border text-xs transition-colors ${
                    active
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border hover:border-primary/40'
                  }`}
                >
                  {s === 'all' ? 'Все' : STATUS_LABELS[s as Status] || s}
                </a>
              );
            }
          )}
        </div>

        <div className="rounded-2xl border border-border bg-card overflow-hidden">
          {rows.length === 0 ? (
            <div className="px-6 py-16 text-center text-sm text-muted-foreground">
              Платежей не найдено.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-muted-foreground bg-muted/30">
                <tr>
                  <th className="px-4 py-3 text-left">Дата</th>
                  <th className="px-4 py-3 text-left">Пользователь</th>
                  <th className="px-4 py-3 text-left">Описание</th>
                  <th className="px-4 py-3 text-right">Сумма</th>
                  <th className="px-4 py-3 text-left">Статус</th>
                  <th className="px-4 py-3 text-right">Действия</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className="border-t border-border">
                    <td className="px-4 py-3 whitespace-nowrap">
                      {new Date(p.created_at).toLocaleString('ru-RU', {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })}
                    </td>
                    <td className="px-4 py-3">
                      <div>{p.user_name || '—'}</div>
                      <div className="text-xs text-muted-foreground">{p.user_email || ''}</div>
                    </td>
                    <td className="px-4 py-3">{p.description || '—'}</td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {Number(p.amount).toLocaleString('ru-RU')} {p.currency}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={STATUS_VARIANT[p.status]}>
                        {STATUS_LABELS[p.status]}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {p.status === 'confirmed' && p.tinkoff_payment_id && (
                        <RefundButton
                          paymentId={p.id}
                          providerPaymentId={p.tinkoff_payment_id}
                          amount={Number(p.amount)}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </MainLayout>
  );
}
