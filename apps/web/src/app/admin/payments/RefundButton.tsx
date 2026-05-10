'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';

export default function RefundButton({
  paymentId,
  providerPaymentId,
  amount,
}: {
  paymentId: string;
  providerPaymentId: string;
  amount: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [refunding, setRefunding] = useState(false);

  async function handleRefund() {
    if (!confirm(`Вернуть ${amount.toLocaleString('ru-RU')} ₽ за платёж ${paymentId.slice(0, 8)}?`))
      return;
    setRefunding(true);
    try {
      const res = await fetch('/api/admin/payments/refund', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentId,
          provider: 'tinkoff',
          providerPaymentId,
          amount,
          reason: 'admin_manual_refund',
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        alert(`Ошибка возврата: ${b.error || res.status}`);
        return;
      }
      startTransition(() => router.refresh());
    } finally {
      setRefunding(false);
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending || refunding}
      onClick={handleRefund}
    >
      <RotateCcw className="me-1 h-3 w-3" />
      {refunding ? 'Возврат…' : 'Возврат'}
    </Button>
  );
}
