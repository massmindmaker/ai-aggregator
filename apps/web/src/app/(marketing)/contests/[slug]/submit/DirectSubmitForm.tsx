'use client';

import * as React from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';

const MAX_SIZE = 50 * 1024 * 1024; // 50 MB

export default function DirectSubmitForm({ slug }: { slug: string }) {
  const [file, setFile] = React.useState<File | null>(null);
  const [description, setDescription] = React.useState('');
  const [status, setStatus] = React.useState<'idle' | 'uploading' | 'done' | 'error'>('idle');
  const [error, setError] = React.useState<string | null>(null);
  const [submissionId, setSubmissionId] = React.useState<string | null>(null);

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null);
    const f = e.target.files?.[0];
    if (!f) {
      setFile(null);
      return;
    }
    if (f.size > MAX_SIZE) {
      setError('Файл больше 50 MB');
      return;
    }
    setFile(f);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setError(null);
    setStatus('uploading');

    try {
      const fd = new FormData();
      fd.append('submission', file);
      if (description.trim()) {
        fd.append('description', description.trim());
      }

      const res = await fetch(`/api/contests/${slug}/submit`, {
        method: 'POST',
        body: fd,
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(
          (data as { error?: { message?: string } })?.error?.message ||
            'Не удалось отправить submission'
        );
      }

      setSubmissionId((data as { submissionId?: string }).submissionId ?? null);
      setStatus('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
      setStatus('error');
    }
  }

  if (status === 'done') {
    return (
      <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800 space-y-1">
        <p className="font-medium inline-flex items-center gap-2">
          <svg className="aiag-check-svg inline-block" width="24" height="24" viewBox="0 0 32 32" aria-hidden="true">
            <path d="M7 16 L13 22 L25 10" />
          </svg>
          Submission принят!
        </p>
        {submissionId && (
          <p className="text-xs text-green-700">ID: {submissionId}</p>
        )}
        <p className="text-xs text-green-700">
          Результат появится в leaderboard после оценки.
        </p>
      </div>
    );
  }

  const busy = status === 'uploading';

  return (
    <form onSubmit={handleSubmit} className="space-y-4 aiag-stagger">
      <div>
        <label className="text-sm font-medium mb-2 block">
          Файл (до 50 MB)
        </label>
        <Input
          type="file"
          onChange={onFileChange}
          disabled={busy}
        />
        {file && (
          <div className="text-xs text-muted-foreground mt-1">
            {file.name} • {(file.size / 1_048_576).toFixed(2)} MB
          </div>
        )}
      </div>

      <div>
        <label className="text-sm font-medium mb-2 block" htmlFor="direct-sub-desc">
          Комментарий (необязательно)
        </label>
        <textarea
          id="direct-sub-desc"
          className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Например: XGBoost baseline"
          disabled={busy}
        />
      </div>

      {error && (
        <div className="text-sm text-destructive" role="alert">
          {error}
        </div>
      )}

      <Button type="submit" disabled={!file || busy} className="w-full">
        {busy ? 'Отправляем…' : 'Отправить submission'}
      </Button>
    </form>
  );
}
