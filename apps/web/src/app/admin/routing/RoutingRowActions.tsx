'use client';

import * as React from 'react';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Sonner';
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';

interface TestResult {
  ok: boolean;
  status?: number;
  latency_ms?: number;
  error?: string | null;
  sample?: string | null;
}

export function RoutingRowActions({
  id,
  enabled,
  markup,
}: {
  id: string;
  enabled: boolean;
  markup: number;
}) {
  const [busy, setBusy] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [result, setResult] = React.useState<TestResult | null>(null);
  const [open, setOpen] = React.useState(false);

  const call = async (path: string, method: string, body?: Record<string, unknown>) => {
    setBusy(true);
    try {
      const r = await fetch(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast.error(`Ошибка: ${j.error ?? r.status}`);
      } else {
        window.location.reload();
      }
    } finally {
      setBusy(false);
    }
  };

  const onTest = async () => {
    setTesting(true);
    setOpen(true);
    setResult(null);
    try {
      const r = await fetch(`/api/admin/routing/${id}/test`, { method: 'POST' });
      const j = (await r.json().catch(() => ({}))) as TestResult & { error?: string };
      if (!r.ok) {
        toast.error(`Тест провален: ${j.error ?? r.status}`);
        setResult({ ok: false, error: j.error ?? String(r.status) });
        return;
      }
      setResult(j);
      if (j.ok) {
        toast.success(`Тест ОК · ${j.latency_ms ?? '?'} ms`);
      } else {
        toast.error(`Тест FAIL${j.error ? ` · ${j.error}` : ''}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown';
      toast.error(`Ошибка сети: ${msg}`);
      setResult({ ok: false, error: msg });
    } finally {
      setTesting(false);
    }
  };

  const onToggle = () =>
    call(`/api/admin/routing/${id}`, 'PATCH', { op: 'toggle', enabled: !enabled });

  const onMarkup = async () => {
    const raw = prompt('Markup multiplier (e.g. 1.25):', String(markup));
    if (raw == null) return;
    const v = Number(raw);
    if (!Number.isFinite(v) || v <= 0) return;
    await call(`/api/admin/routing/${id}`, 'PATCH', { op: 'setMarkup', markup: v });
  };

  const onDelete = async () => {
    if (!confirm('Удалить маршрут?')) return;
    await call(`/api/admin/routing/${id}`, 'DELETE');
  };

  return (
    <div>
      <div className="flex gap-1 justify-end">
        <Button size="sm" variant="outline" disabled={busy || testing} onClick={onTest}>
          {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Тест'}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onMarkup}>
          ×
        </Button>
        <Button
          size="sm"
          variant={enabled ? 'destructive' : 'default'}
          disabled={busy}
          onClick={onToggle}
        >
          {enabled ? 'Выкл' : 'Вкл'}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onDelete}>
          ✕
        </Button>
      </div>

      {open && (
        <div className="mt-2 p-3 rounded border bg-muted/30 text-left">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 pt-0.5">
              {testing ? (
                <Loader2 className="h-4 w-4 animate-spin opacity-60" />
              ) : result?.ok ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              ) : (
                <XCircle className="h-4 w-4 text-red-500" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-xs flex-wrap">
                <span
                  className={`font-mono px-1.5 py-0.5 rounded ${
                    result?.ok
                      ? 'bg-emerald-500/15 text-emerald-400'
                      : 'bg-red-500/15 text-red-400'
                  }`}
                >
                  {testing ? '…' : result?.ok ? 'OK' : 'FAIL'}
                </span>
                {result?.latency_ms != null && (
                  <span className="text-muted-foreground">
                    {result.latency_ms} ms
                  </span>
                )}
                {result?.error && (
                  <span className="text-red-400 truncate">{result.error}</span>
                )}
              </div>
              {result?.sample && (
                <pre className="mt-2 text-[10px] font-mono whitespace-pre-wrap break-all bg-background/60 rounded p-2 max-h-40 overflow-auto border">
                  {result.sample}
                </pre>
              )}
            </div>
            <button
              onClick={() => setOpen(false)}
              className="text-xs text-muted-foreground hover:text-foreground px-2"
              aria-label="Закрыть"
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
