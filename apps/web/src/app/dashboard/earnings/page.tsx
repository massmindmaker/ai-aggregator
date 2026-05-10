// FIXME(spec §9 row 10): MOCK_EARNINGS is hardcoded. Convert to a server
// component reading from `author_earnings` table before public launch. Tracked
// in docs/superpowers/specs/2026-05-10-dashboard-ia-redesign-design.md §10.
import * as React from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { formatPrice } from '@aiag/shared';

export const metadata = { title: 'Мои доходы — AI-Aggregator' };

interface EarningRow {
  month: string;
  modelName: string;
  modelSlug: string;
  grossRevenueRub: number;
  upstreamCostRub: number;
  marginRub: number;
  tierPct: number;
  authorShareRub: number;
  status: 'accruing' | 'locked' | 'paid';
}

const MOCK_EARNINGS: EarningRow[] = [
  {
    month: '2026-03',
    modelName: 'MedNER RU v2',
    modelSlug: 'medner-ru-v2',
    grossRevenueRub: 45_200,
    upstreamCostRub: 12_800,
    marginRub: 32_400,
    tierPct: 70,
    authorShareRub: 22_680,
    status: 'paid',
  },
  {
    month: '2026-04',
    modelName: 'MedNER RU v2',
    modelSlug: 'medner-ru-v2',
    grossRevenueRub: 58_900,
    upstreamCostRub: 14_200,
    marginRub: 44_700,
    tierPct: 70,
    authorShareRub: 31_290,
    status: 'accruing',
  },
];

const totalAccruing = MOCK_EARNINGS.filter((e) => e.status === 'accruing').reduce(
  (a, b) => a + b.authorShareRub,
  0
);
const totalPaid = MOCK_EARNINGS.filter((e) => e.status === 'paid').reduce(
  (a, b) => a + b.authorShareRub,
  0
);

export default function EarningsPage() {
  return (
    <>
      <div className="container mx-auto px-4 py-10 max-w-5xl">
        <h1 className="text-3xl font-bold tracking-tight mb-6">
          Мои доходы
        </h1>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <StatCard
            label="Накоплено (к выплате)"
            value={formatPrice(totalAccruing)}
            hint="Будет зафиксировано 2-го числа следующего месяца"
          />
          <StatCard
            label="Выплачено всего"
            value={formatPrice(totalPaid)}
          />
          <StatCard
            label="Текущий revshare tier"
            value="70% (baseline)"
            hint="75% при суммарной выручке >100k ₽ 3 мес подряд"
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
              <a href="/dashboard/earnings/payout-method">
                Настроить метод выплаты
              </a>
            </Button>
          </CardContent>
        </Card>

        <h2 className="text-xl font-semibold mb-3">История начислений</h2>

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
              {MOCK_EARNINGS.map((e) => (
                <TableRow key={`${e.month}-${e.modelSlug}`}>
                  <TableCell className="font-mono text-sm">{e.month}</TableCell>
                  <TableCell>{e.modelName}</TableCell>
                  <TableCell className="text-right">
                    {formatPrice(e.grossRevenueRub)}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {formatPrice(e.upstreamCostRub)}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatPrice(e.marginRub)}
                  </TableCell>
                  <TableCell className="text-right text-sm">
                    {e.tierPct}%
                  </TableCell>
                  <TableCell className="text-right font-semibold">
                    {formatPrice(e.authorShareRub)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        e.status === 'paid'
                          ? ('success' as any)
                          : e.status === 'locked'
                            ? 'default'
                            : 'outline'
                      }
                    >
                      {e.status === 'paid'
                        ? 'Выплачено'
                        : e.status === 'locked'
                          ? 'Зафиксировано'
                          : 'Начисляется'}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <p className="text-xs text-muted-foreground mt-4">
          НДФЛ 13%/15% удерживается для физлиц (card_ru). Самозанятые получают
          gross и сами выставляют чек. ИП/ООО — по счёту.
        </p>
      </div>
    </>
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
        {hint && (
          <div className="text-xs text-muted-foreground mt-1">{hint}</div>
        )}
      </CardContent>
    </Card>
  );
}
