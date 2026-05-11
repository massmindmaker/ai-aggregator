'use client';

import * as React from 'react';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Sonner';

export function PromoRowActions({ id, active }: { id: string; active: boolean }) {
  const [busy, setBusy] = React.useState(false);
  const toggle = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/promos/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ active: !active }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        toast.error(`Ошибка: ${j.error ?? r.status}`);
      } else {
        toast.success(active ? 'Промокод отключён' : 'Промокод включён');
        window.location.reload();
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" variant="outline" disabled={busy} onClick={toggle}>
      {active ? 'Отключить' : 'Включить'}
    </Button>
  );
}
