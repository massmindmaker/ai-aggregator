'use client';

import * as React from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/RadioGroup';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/Dialog';

type Props = {
  slug: string;
  submissionId: string;
  finalRank: number;
  participantEmail: string | null;
  suggestedSlug: string;
};

const HOSTING_OPTIONS: ReadonlyArray<{ value: 'cloud_api_wrap' | 'hosted_on_aiag' | 'self_hosted_by_author'; label: string }> = [
  { value: 'cloud_api_wrap', label: 'Cloud-API wrap' },
  { value: 'hosted_on_aiag', label: 'Hosted on AIAG' },
  { value: 'self_hosted_by_author', label: 'Self-hosted by автор' },
];

export function PublishSubmissionModal({
  slug,
  submissionId,
  finalRank,
  participantEmail,
  suggestedSlug,
}: Props) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [modelSlug, setModelSlug] = React.useState(suggestedSlug);
  const [displayName, setDisplayName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [hostingStrategy, setHostingStrategy] =
    React.useState<'cloud_api_wrap' | 'hosted_on_aiag' | 'self_hosted_by_author'>('cloud_api_wrap');
  const [costRubOverride, setCostRubOverride] = React.useState('');
  const [tagsCsv, setTagsCsv] = React.useState(`🏆 contest-winner,from-contest-${slug}`);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!/^[a-z0-9-]{3,80}$/.test(modelSlug)) {
      setError('Slug должен соответствовать ^[a-z0-9-]{3,80}$');
      return;
    }
    if (!displayName.trim()) {
      setError('Display name обязателен');
      return;
    }

    setBusy(true);
    try {
      const r = await fetch(`/api/admin/contests/${slug}/publish-submission`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          submission_id: submissionId,
          model_slug: modelSlug,
          display_name: displayName.trim(),
          description: description.trim() || null,
          hosting_strategy: hostingStrategy,
          cost_rub_override: costRubOverride === '' ? null : Number(costRubOverride),
          tags: tagsCsv
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(String(json.error ?? `HTTP ${r.status}`));
        return;
      }
      window.location.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="default">
          Опубликовать
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Опубликовать как marketplace-модель</DialogTitle>
          <DialogDescription>
            Top-{finalRank} из {participantEmail ?? 'неизвестного автора'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="model_slug">Slug модели</Label>
            <Input
              id="model_slug"
              name="model_slug"
              value={modelSlug}
              onChange={(e) => setModelSlug(e.target.value)}
              pattern="^[a-z0-9-]{3,80}$"
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="display_name">Название</Label>
            <Input
              id="display_name"
              name="display_name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={100}
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="description">Описание</Label>
            <textarea
              id="description"
              name="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              rows={3}
              className="flex w-full rounded-md border border-border bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Hosting strategy</Label>
            <RadioGroup
              value={hostingStrategy}
              onValueChange={(v) =>
                setHostingStrategy(v as 'cloud_api_wrap' | 'hosted_on_aiag' | 'self_hosted_by_author')
              }
              name="hosting_strategy"
            >
              {HOSTING_OPTIONS.map((opt) => (
                <div key={opt.value} className="flex items-center gap-2">
                  <RadioGroupItem id={`hs-${opt.value}`} value={opt.value} />
                  <Label htmlFor={`hs-${opt.value}`} className="font-normal cursor-pointer">
                    {opt.label}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cost_rub_override">Цена override (₽), опционально</Label>
            <Input
              id="cost_rub_override"
              name="cost_rub_override"
              type="number"
              step="0.01"
              value={costRubOverride}
              onChange={(e) => setCostRubOverride(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="tags_csv">Теги (через запятую)</Label>
            <Input
              id="tags_csv"
              name="tags_csv"
              value={tagsCsv}
              onChange={(e) => setTagsCsv(e.target.value)}
            />
          </div>

          <p className="text-xs text-muted-foreground">tier preview TODO</p>

          {error && <p className="text-red-400 text-sm">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Отмена
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Публикуется…' : 'Опубликовать как marketplace-модель'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
