'use client';

import * as React from 'react';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { FormWizard, WizardStep } from '@/components/ui/FormWizard';

type ContestInitial = {
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

export function ContestForm({ initial }: { initial?: ContestInitial }) {
  // Edit mode keeps the classic single-form UI (admins iterate quickly).
  if (initial) {
    return <ContestFormClassic initial={initial} />;
  }
  return <ContestFormWizard />;
}

function ContestFormWizard() {
  const [slug, setSlug] = React.useState('');
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [totalPrizePool, setTotalPrizePool] = React.useState('');
  const [evalMetric, setEvalMetric] = React.useState('');
  const [datasetUrl, setDatasetUrl] = React.useState('');
  const [startsAt, setStartsAt] = React.useState('');
  const [endsAt, setEndsAt] = React.useState('');
  const [sponsorId, setSponsorId] = React.useState('');

  async function onSubmit() {
    const body = {
      slug,
      name,
      description,
      total_prize_pool: totalPrizePool,
      eval_metric: evalMetric,
      dataset_url: datasetUrl,
      starts_at: startsAt,
      ends_at: endsAt,
      sponsor_id: sponsorId,
    };
    const r = await fetch('/api/admin/contests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(j.error ?? `Ошибка ${r.status}`);
    }
    const createdSlug = j.contest?.slug ?? j.slug ?? slug;
    window.location.href = `/admin/contests/${createdSlug}`;
  }

  return (
    <FormWizard
      onSubmit={onSubmit}
      submitLabel="Создать контест"
      hint="Заполните шаги по очереди — данные сохранятся одним запросом."
    >
      <WizardStep
        title="Основное"
        validate={() => {
          if (!slug.trim()) return 'Укажите слаг';
          if (!name.trim()) return 'Укажите название';
          return true;
        }}
      >
        <div className="space-y-4">
          <div>
            <label className="text-xs uppercase text-muted-foreground">Слаг</label>
            <Input value={slug} onChange={(e) => setSlug(e.target.value)} required />
          </div>
          <div>
            <label className="text-xs uppercase text-muted-foreground">Название</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div>
            <label className="text-xs uppercase text-muted-foreground">Описание</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full border rounded-md px-3 py-2 bg-background text-sm min-h-[80px]"
            />
          </div>
        </div>
      </WizardStep>

      <WizardStep title="Тайминг и приз">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs uppercase text-muted-foreground">Начало</label>
              <Input
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs uppercase text-muted-foreground">Конец</label>
              <Input
                type="datetime-local"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs uppercase text-muted-foreground">Призовой ₽</label>
              <Input
                type="number"
                step="0.01"
                value={totalPrizePool}
                onChange={(e) => setTotalPrizePool(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs uppercase text-muted-foreground">Eval metric</label>
              <Input
                value={evalMetric}
                onChange={(e) => setEvalMetric(e.target.value)}
                placeholder="accuracy / mse / f1"
              />
            </div>
          </div>
        </div>
      </WizardStep>

      <WizardStep title="Метаданные">
        <div className="space-y-4">
          <div>
            <label className="text-xs uppercase text-muted-foreground">Dataset URL</label>
            <Input
              value={datasetUrl}
              onChange={(e) => setDatasetUrl(e.target.value)}
              placeholder="https://..."
            />
          </div>
          <div>
            <label className="text-xs uppercase text-muted-foreground">Спонсор (org id, опционально)</label>
            <Input value={sponsorId} onChange={(e) => setSponsorId(e.target.value)} />
          </div>
        </div>
      </WizardStep>
    </FormWizard>
  );
}

function ContestFormClassic({ initial }: { initial: ContestInitial }) {
  const [busy, setBusy] = React.useState(false);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    try {
      const fd = new FormData(e.currentTarget);
      const body = Object.fromEntries(fd.entries());
      const slug = initial.slug;
      const r = await fetch(`/api/admin/contests/${slug}`, {
        method: 'PATCH',
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
        <Input name="slug" defaultValue={initial.slug} required disabled />
      </div>
      <div>
        <label className="text-xs uppercase text-muted-foreground">Название</label>
        <Input name="name" defaultValue={initial.name} required />
      </div>
      <div>
        <label className="text-xs uppercase text-muted-foreground">Описание</label>
        <textarea
          name="description"
          defaultValue={initial.description}
          className="w-full border rounded-md px-3 py-2 bg-background text-sm min-h-[80px]"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs uppercase text-muted-foreground">Призовой ₽</label>
          <Input name="total_prize_pool" type="number" step="0.01" defaultValue={initial.total_prize_pool} />
        </div>
        <div>
          <label className="text-xs uppercase text-muted-foreground">Eval metric</label>
          <Input name="eval_metric" defaultValue={initial.eval_metric} placeholder="accuracy / mse / f1" />
        </div>
      </div>
      <div>
        <label className="text-xs uppercase text-muted-foreground">Dataset URL</label>
        <Input name="dataset_url" defaultValue={initial.dataset_url} placeholder="https://..." />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs uppercase text-muted-foreground">Начало</label>
          <Input name="starts_at" type="datetime-local" defaultValue={initial.starts_at} />
        </div>
        <div>
          <label className="text-xs uppercase text-muted-foreground">Конец</label>
          <Input name="ends_at" type="datetime-local" defaultValue={initial.ends_at} />
        </div>
      </div>
      <div>
        <label className="text-xs uppercase text-muted-foreground">Спонсор (org id, опционально)</label>
        <Input name="sponsor_id" defaultValue={initial.sponsor_id} />
      </div>
      <Button type="submit" disabled={busy}>
        Сохранить
      </Button>
    </form>
  );
}
