import * as React from 'react';
import { requireAdmin } from '@/lib/admin/guard';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { listTonReviewRequired, type TonReviewRequiredEntry } from '@aiag/database';
import { walletDatabase } from '@/lib/ton-wallet/service';
import { TonReviewTable } from './TonReviewTable';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'TON review — AIAG Admin' };

export default async function AdminTonReviewPage() {
  await requireAdmin();
  let invoices: TonReviewRequiredEntry[] = [];
  let loadError: string | null = null;
  try {
    invoices = await listTonReviewRequired(walletDatabase, 200);
  } catch (e) {
    console.error('[admin/ton] review queue failed', e);
    loadError = 'Не удалось загрузить очередь review. Смотри логи сервера.';
  }
  return (
    <div className="space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">TON review-очередь</h1>
        <p className="text-sm text-muted-foreground">
          Инвойсы в статусе review_required: деньги пришли, кредиты не начислены. Разбор — по{' '}
          <a className="underline" href="https://ai-aggregator.ru/admin/ton" target="_blank" rel="noreferrer">
            runbook
          </a>
          : acknowledge = «кредиты не начисляем» (окончательно), retry = воркер переоценит причину на следующем тике.
        </p>
      </header>
      {loadError ? (
        <Card>
          <CardContent className="text-sm text-destructive">{loadError}</CardContent>
        </Card>
      ) : invoices.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Очередь пуста</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Нет инвойсов, ожидающих разбора.
          </CardContent>
        </Card>
      ) : (
        <TonReviewTable invoices={invoices} />
      )}
    </div>
  );
}
