'use client';

import * as React from 'react';
import { Button } from '@/components/ui/Button';

export function OrgRowActions({ orgId, status }: { orgId: string; status: string }) {
  const [busy, setBusy] = React.useState(false);

  const call = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/orgs/${orgId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert(`Ошибка: ${j.error ?? r.status}`);
      } else window.location.reload();
    } finally {
      setBusy(false);
    }
  };

  const onTopup = async () => {
    // HIGH-3 fix: organizations.payg_credits is BIGINT MICRO-credits
    // (1 credit = 1000 micro = 1¢), not ₽ — see api/admin/orgs/[id]/route.ts.
    // The prompt now takes whole CREDITS explicitly; the route converts to
    // micro server-side.
    const raw = prompt('Сумма пополнения PAYG (кредиты, 1 кредит = 1¢):');
    if (!raw) return;
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount === 0) return;
    const reason = prompt('Причина (для аудита):') ?? '';
    await call({ op: 'topupPayg', amountCredits: amount, reason });
  };

  const onSuspend = async () => {
    if (status === 'suspended') {
      await call({ op: 'unsuspend' });
    } else {
      const reason = prompt('Причина приостановки:') ?? '';
      await call({ op: 'suspend', reason });
    }
  };

  return (
    <div className="flex gap-1 justify-end">
      <Button size="sm" variant="outline" disabled={busy} onClick={onTopup}>
        +кр
      </Button>
      <Button
        size="sm"
        variant={status === 'suspended' ? 'outline' : 'destructive'}
        disabled={busy}
        onClick={onSuspend}
      >
        {status === 'suspended' ? 'Активировать' : 'Приостановить'}
      </Button>
    </div>
  );
}
