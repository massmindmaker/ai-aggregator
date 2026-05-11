'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from '@/components/ui/Sonner';

interface Props {
  collectionId: string;
  currentStatus: string;
}

const STATUSES = {
  draft: { label: 'Опубликовать', next: 'active', cls: 'primary' },
  active: { label: 'Снять', next: 'draft', cls: 'secondary' },
  sold_out: { label: 'В архив', next: 'archived', cls: 'secondary' },
  archived: { label: 'Восстановить', next: 'draft', cls: 'secondary' },
} as const;

export function CollectionStatusActions({ collectionId, currentStatus }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const action = (STATUSES as Record<string, { label: string; next: string; cls: string }>)[
    currentStatus
  ];
  if (!action) return null;

  async function handleClick() {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/nft/collections/${collectionId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: action.next }),
      });
      if (res.ok) {
        toast.success(`Статус → ${action.next}`);
        router.refresh();
      } else {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error || 'Не удалось изменить статус');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setLoading(false);
    }
  }

  const primary = action.cls === 'primary';
  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={loading}
      className="text-xs px-2.5 py-1 rounded-sm font-semibold transition-all hover:-translate-y-px disabled:opacity-50"
      style={
        primary
          ? { background: 'var(--accent)', color: '#000' }
          : { background: 'transparent', color: 'var(--ink)', border: '1px solid var(--line)' }
      }
    >
      {loading ? '…' : action.label}
    </button>
  );
}
