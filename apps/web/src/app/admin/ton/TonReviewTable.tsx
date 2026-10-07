'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import type { TonReviewRequiredEntry } from '@aiag/database';

const TON_ATOMIC = 1_000_000_000n;

function tonAmount(amountAtomic: string): string {
  try {
    const atomic = BigInt(amountAtomic);
    const whole = atomic / TON_ATOMIC;
    const frac = (atomic % TON_ATOMIC).toString().padStart(9, '0').replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : `${whole}`;
  } catch {
    return amountAtomic;
  }
}

export function TonReviewTable({ invoices }: { invoices: TonReviewRequiredEntry[] }) {
  const router = useRouter();
  const [pending, setPending] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function decide(invoice: TonReviewRequiredEntry, action: 'acknowledge_no_credit' | 'retry_settle') {
    if (
      action === 'acknowledge_no_credit' &&
      !window.confirm(
        `Подтвердить: кредиты по инвойсу ${invoice.reference} НЕ начислять (окончательно)? Причина: ${invoice.reviewReason}.`,
      )
    ) {
      return;
    }
    setPending(`${invoice.invoiceId}:${action}`);
    setError(null);
    try {
      const response = await fetch(`/api/admin/ton/review/${invoice.invoiceId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: invoice.eventId, action }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `HTTP ${response.status}`);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'неизвестная ошибка');
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-2">
      {error ? <div className="rounded bg-destructive/10 p-2 text-sm text-destructive">{error}</div> : null}
      <div className="overflow-x-auto rounded border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="p-2">Обновлён</th>
              <th className="p-2">Причина</th>
              <th className="p-2">Сумма (TON)</th>
              <th className="p-2">Сеть</th>
              <th className="p-2">Reference</th>
              <th className="p-2">Tx</th>
              <th className="p-2 text-right">Решение</th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((invoice) => (
              <tr key={invoice.invoiceId} className="border-t align-top">
                <td className="whitespace-nowrap p-2">{new Date(invoice.updatedAt).toLocaleString('ru-RU')}</td>
                <td className="p-2 font-medium">{invoice.reviewReason}</td>
                <td className="whitespace-nowrap p-2">{tonAmount(invoice.amountAtomic)}</td>
                <td className="whitespace-nowrap p-2">{invoice.network}</td>
                <td className="p-2 font-mono text-xs">{invoice.reference}</td>
                <td className="p-2 font-mono text-xs">
                  <a
                    className="underline"
                    href={`https://testnet.tonviewer.com/transaction/${invoice.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {invoice.txHash.slice(0, 10)}…
                  </a>
                </td>
                <td className="whitespace-nowrap p-2 text-right">
                  <button
                    className="mr-2 rounded border px-2 py-1 text-xs disabled:opacity-50"
                    disabled={pending !== null}
                    onClick={() => decide(invoice, 'retry_settle')}
                  >
                    {pending === `${invoice.invoiceId}:retry_settle` ? '…' : 'Retry'}
                  </button>
                  <button
                    className="rounded border px-2 py-1 text-xs disabled:opacity-50"
                    disabled={pending !== null}
                    onClick={() => decide(invoice, 'acknowledge_no_credit')}
                  >
                    {pending === `${invoice.invoiceId}:acknowledge_no_credit` ? '…' : 'No credit'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
