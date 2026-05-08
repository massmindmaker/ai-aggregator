'use client';
import * as React from 'react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';

interface Props {
  modelId: string;
  modelSlug: string;
  status: string;
  frozenReason: string | null;
  depublishedReason: string | null;
}

export function ModelStatusActions({
  modelId,
  modelSlug,
  status,
  frozenReason,
  depublishedReason,
}: Props) {
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const freeze = async () => {
    const reason = window.prompt(
      `Причина заморозки модели ${modelSlug}? (видна в audit_log)`
    );
    if (!reason) return;
    setBusy(true);
    setErr(null);
    const r = await fetch(`/api/admin/models/${modelId}/freeze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    if (!r.ok) {
      let msg = 'ERR';
      try {
        const body = await r.json();
        msg = body?.error ?? msg;
      } catch {
        /* non-json body */
      }
      setErr(msg);
      setBusy(false);
      return;
    }
    window.location.reload();
  };

  const depublish = async () => {
    const reason = window.prompt(
      `Причина деплабликации модели ${modelSlug}? (необратимо)`
    );
    if (!reason) return;
    if (
      !window.confirm(
        `Подтвердить деплабликацию ${modelSlug}? Pending earnings останутся pending до resolution.`
      )
    )
      return;
    setBusy(true);
    setErr(null);
    const r = await fetch(`/api/admin/models/${modelId}/depublish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    if (!r.ok) {
      let msg = 'ERR';
      try {
        const body = await r.json();
        msg = body?.error ?? msg;
      } catch {
        /* non-json body */
      }
      setErr(msg);
      setBusy(false);
      return;
    }
    window.location.reload();
  };

  const canFreeze = status === 'live';
  const canDepublish = status === 'live' || status === 'frozen';

  return (
    <div className="space-y-3 border border-border rounded-md p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm">Текущий статус:</span>
        <Badge
          variant={
            status === 'live'
              ? 'success'
              : status === 'frozen'
              ? 'warning'
              : 'destructive'
          }
        >
          {status}
        </Badge>
      </div>
      {frozenReason && (
        <p className="text-xs text-amber-400">Причина заморозки: {frozenReason}</p>
      )}
      {depublishedReason && (
        <p className="text-xs text-red-400">
          Причина деплабликации: {depublishedReason}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={freeze}
          disabled={!canFreeze || busy}
        >
          Freeze (503)
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={depublish}
          disabled={!canDepublish || busy}
        >
          Depublish
        </Button>
      </div>
      {err && <p className="text-xs text-red-400">{err}</p>}
    </div>
  );
}
