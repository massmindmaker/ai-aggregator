'use client';

import * as React from 'react';
import { Button } from '@/components/ui/Button';

interface Props {
  docId: string;
  userId: string;
  kycType: string | null;
}

export function KycRowActions({ docId }: Props) {
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const approve = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/admin/kyc/${docId}/approve`, { method: 'POST' });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setErr(j.error ?? `ERR ${r.status}`);
        setBusy(false);
        return;
      }
      window.location.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'NETWORK_ERROR');
      setBusy(false);
    }
  };

  const reject = async () => {
    const reason = window.prompt('Причина отказа?');
    if (!reason) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/admin/kyc/${docId}/reject`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setErr(j.error ?? `ERR ${r.status}`);
        setBusy(false);
        return;
      }
      window.location.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'NETWORK_ERROR');
      setBusy(false);
    }
  };

  return (
    <div className="flex gap-2 items-center justify-end">
      <Button size="sm" onClick={approve} disabled={busy}>
        Approve
      </Button>
      <Button size="sm" variant="destructive" onClick={reject} disabled={busy}>
        Reject
      </Button>
      {err && <span className="text-xs text-red-400">{err}</span>}
    </div>
  );
}
