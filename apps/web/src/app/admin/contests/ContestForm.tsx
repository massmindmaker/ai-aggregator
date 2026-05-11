'use client';

import * as React from 'react';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';

export function ContestForm({
  initial,
}: {
  initial?: {
    slug: string;
    name: string;
    description?: string;
    dataset_url?: string;
    eval_metric?: string;
    total_prize_pool?: string;
    starts_at?: string;
    ends_at?: string;
    sponsor_id?: string;
  };
}) {
  const [busy, setBusy] = React.useState(false);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    try {
      const fd = new FormData(e.currentTarget);
      const body = Object.fromEntries(fd.entries());
      const slug = (initial?.slug ?? body.slug) as string;
      const url = initial ? `/api/admin/contests/${slug}` : '/api/admin/contests';
      const r = await fetch(url, {
        method: initial ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        alert(`Ошибка: ${j.error ?? r.status}`);
      } else {
        const createdSlug = j.contest?.slug ?? j.slug ?? slug;
        window.location.href = `/admin/contests/${createdSlug}`;
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <label className="text-xs uppercase text-muted-foreground">Слаг</label>
        <Input name="slug" defaultValue={initial?.slug} required disabled={!!initial} />
      </div>
      <div>
        <label className="text-xs uppercase text-muted-foreground">Название</label>
        <Input name="name" defaultValue={initial?.name} required />
      </div>
      <div>
        <label className="text-xs uppercase text-muted-foreground">Описание</label>
        <textarea
          name="description"
          defaultValue={initial?.description}
          className="w-full border rounded-md px-3 py-2 bg-background text-sm min-h-[80px]"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs uppercase text-muted-foreground">Призовой ₽</label>
          <Input name="total_prize_pool" type="number" step="0.01" defaultValue={initial?.total_prize_pool} />
        </div>
        <div>
          <label className="text-xs uppercase text-muted-foreground">Eval metric</label>
          <Input name="eval_metric" defaultValue={initial?.eval_metric} placeholder="accuracy / mse / f1" />
        </div>
      </div>
      <div>
        <label className="text-xs uppercase text-muted-foreground">Dataset URL</label>
        <Input name="dataset_url" defaultValue={initial?.dataset_url} placeholder="https://..." />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs uppercase text-muted-foreground">Начало</label>
          <Input name="starts_at" type="datetime-local" defaultValue={initial?.starts_at} />
        </div>
        <div>
          <label className="text-xs uppercase text-muted-foreground">Конец</label>
          <Input name="ends_at" type="datetime-local" defaultValue={initial?.ends_at} />
        </div>
      </div>
      <div>
        <label className="text-xs uppercase text-muted-foreground">Спонсор (org id, опционально)</label>
        <Input name="sponsor_id" defaultValue={initial?.sponsor_id} />
      </div>
      <Button type="submit" disabled={busy}>
        {initial ? 'Сохранить' : 'Создать'}
      </Button>
    </form>
  );
}
