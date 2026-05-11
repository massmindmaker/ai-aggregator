import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { db, sql } from '@/lib/db';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Мои доходы — AI-Aggregator' };

interface Row {
  period_month: string | null;
  model_name: string | null;
  model_slug: string | null;
  gross_revenue_rub: string;
  upstream_cost_rub: string;
  margin_rub: string;
  tier_pct: number;
  author_share_rub: string;
  status: string;
}

const STATUS_LABEL: Record<string, string> = {
  accruing: 'Начисляется',
  locked: 'Зафиксировано',
  paid: 'Выплачено',
};

function fmt(s: string): string {
  return Number(s).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
}

export default async function EarningsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login?callbackUrl=/dashboard/earnings');

  let rows: Row[] = [];
  try {
    const r = await db.execute(sql`
      SELECT e.period_month::text AS period_month,
             m.display_name AS model_name, m.slug AS model_slug,
             e.gross_revenue_rub::text AS gross_revenue_rub,
             e.upstream_cost_rub::text AS upstream_cost_rub,
             e.margin_rub::text AS margin_rub,
             e.tier_pct,
             e.author_share_rub::text AS author_share_rub,
             e.status
      FROM author_earnings e
      LEFT JOIN models m ON m.id = e.model_id
      WHERE e.author_id = ${session.user.id}::uuid
      ORDER BY e.period_month DESC NULLS LAST, m.slug
      LIMIT 100
    `);
    rows = (((r as unknown as { rows?: unknown[] }).rows ?? r) as Row[]);
  } catch {
    rows = [];
  }

  const totalAccruing = rows
    .filter((e) => e.status === 'accruing')
    .reduce((a, b) => a + Number(b.author_share_rub), 0);
  const totalPaid = rows
    .filter((e) => e.status === 'paid')
    .reduce((a, b) => a + Number(b.author_share_rub), 0);

  return (
    <div className="container mx-auto px-4 py-10 max-w-5xl">
      <h1 className="text-3xl font-bold tracking-tight mb-6">Мои доходы</h1>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <StatCard
          label="Накоплено (к выплате)"
          value={`${totalAccruing.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`}
          hint="Будет зафиксировано 2-го числа следующего месяца"
        />
        <StatCard
          label="Выплачено всего"
          value={`${totalPaid.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`}
        />
        <StatCard
          label="Текущий revshare tier"
          value="70% (baseline)"
          hint="80% при self-host, 85% при exclusive"
        />
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Реквизиты для выплаты</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between flex-wrap gap-3">
          <div className="text-sm text-muted-foreground">
            Метод выплаты не настроен.
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard/kyc">Настроить</Link>
          </Button>
        </CardContent>
      </Card>

      <h2 className="text-xl font-semibold mb-3">История начислений</h2>

      {rows.length === 0 ? (
        <div
          className="rounded-md border"
          style={{ borderColor: 'var(--line)' }}
        >
          <EmptyState
            title="Пока нет начислений"
            description="Доходы появятся после первого вызова вашей модели через API."
            actionLabel="Мои модели"
            actionHref="/dashboard/models"
          />
        </div>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Период</TableHead>
                <TableHead>Модель</TableHead>
                <TableHead className="text-right">Выручка</TableHead>
                <TableHead className="text-right">Upstream</TableHead>
                <TableHead className="text-right">Маржа</TableHead>
                <TableHead className="text-right">Tier</TableHead>
                <TableHead className="text-right">Ваш share</TableHead>
                <TableHead>Статус</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((e, i) => (
                <TableRow key={`${e.period_month}-${e.model_slug}-${i}`}>
                  <TableCell className="font-mono text-sm">
                    {e.period_month?.slice(0, 7) ?? '—'}
                  </TableCell>
                  <TableCell>{e.model_name ?? e.model_slug ?? '—'}</TableCell>
                  <TableCell className="text-right">{fmt(e.gross_revenue_rub)}</TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {fmt(e.upstream_cost_rub)}
                  </TableCell>
                  <TableCell className="text-right">{fmt(e.margin_rub)}</TableCell>
                  <TableCell className="text-right text-sm">{e.tier_pct}%</TableCell>
                  <TableCell className="text-right font-semibold">
                    {fmt(e.author_share_rub)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        e.status === 'paid'
                          ? ('success' as never)
                          : e.status === 'locked'
                            ? 'default'
                            : 'outline'
                      }
                    >
                      {STATUS_LABEL[e.status] ?? e.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="text-xs text-muted-foreground mt-4">
        НДФЛ 13%/15% удерживается для физлиц (card_ru). Самозанятые получают gross и сами выставляют чек. ИП/ООО — по счёту.
      </p>
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="text-sm text-muted-foreground">{label}</div>
        <div className="text-2xl font-bold mt-1">{value}</div>
        {hint && <div className="text-xs text-muted-foreground mt-1">{hint}</div>}
      </CardContent>
    </Card>
  );
}
