'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  slug: string;
  status: string;
}

export function ContestStatusActions({ slug, status }: Props) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  async function changeStatus(next: string) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/contests/${slug}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      if (res.ok) {
        router.refresh();
      } else {
        console.error('[contest status] failed', res.status);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex gap-1">
      {status === 'draft' && (
        <button
          onClick={() => changeStatus('active')}
          disabled={busy}
          className="text-xs px-2 py-1 rounded-sm bg-amber-500 text-black font-medium hover:bg-amber-400 disabled:opacity-50"
        >
          Опубликовать
        </button>
      )}
      {status === 'active' && (
        <button
          onClick={() => changeStatus('closed')}
          disabled={busy}
          className="text-xs px-2 py-1 rounded-sm border hover:bg-muted/40 disabled:opacity-50"
        >
          Закрыть
        </button>
      )}
      {status === 'closed' && (
        <button
          onClick={() => changeStatus('archived')}
          disabled={busy}
          className="text-xs px-2 py-1 rounded-sm border hover:bg-muted/40 disabled:opacity-50"
        >
          В архив
        </button>
      )}
    </span>
  );
}
