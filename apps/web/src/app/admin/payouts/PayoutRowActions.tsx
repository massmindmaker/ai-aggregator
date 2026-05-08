'use client';

import * as React from 'react';
import { Button } from '@/components/ui/Button';

/**
 * Phase 14-04 — per-row admin actions for payouts queue.
 *
 * Auto-approve fast-path: amount ≤ AUTO_APPROVE_CAP_RUB AND user.kyc_status === 'verified'.
 * Above the cap or unverified KYC → admin must confirm manually (window.confirm).
 */

interface Props {
  id: string;
  amountRub: number;
  kycStatus: string;
  kycType: string | null;
  status: string;
}

const AUTO_APPROVE_CAP_RUB = 20000;

export function PayoutRowActions({
  id,
  amountRub,
  kycStatus,
  kycType,
  status,
}: Props) {
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  if (status !== 'requested') {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  const fastPath =
    amountRub <= AUTO_APPROVE_CAP_RUB && kycStatus === 'verified';

  const approve = async () => {
    if (!fastPath) {
      const ok = window.confirm(
        `Сумма ${amountRub} ₽ превышает auto-cap или KYC ≠ verified ` +
          `(текущий: ${kycStatus}/${kycType ?? '—'}).\nApprove вручную?`
      );
      if (!ok) return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/admin/payouts/${id}/approve`, {
        method: 'POST',
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setErr(j.error ?? `HTTP ${r.status}`);
        setBusy(false);
        return;
      }
      window.location.reload();
    } catch (e) {
      setErr((e as Error).message ?? 'NETWORK_ERROR');
      setBusy(false);
    }
  };

  const reject = async () => {
    const reason = window.prompt('Причина отказа?');
    if (!reason || !reason.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/admin/payouts/${id}/reject`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setErr(j.error ?? `HTTP ${r.status}`);
        setBusy(false);
        return;
      }
      window.location.reload();
    } catch (e) {
      setErr((e as Error).message ?? 'NETWORK_ERROR');
      setBusy(false);
    }
  };

  return (
    <div className="flex gap-2 items-center">
      <Button
        size="sm"
        onClick={approve}
        disabled={busy}
        variant={fastPath ? 'default' : 'outline'}
        title={
          fastPath
            ? 'Auto-approve fast-path'
            : 'Manual approve — confirmation required'
        }
      >
        {fastPath ? 'Auto-approve' : 'Approve'}
      </Button>
      <Button
        size="sm"
        onClick={reject}
        disabled={busy}
        variant="destructive"
      >
        Reject
      </Button>
      {err && <span className="text-xs text-red-400">{err}</span>}
    </div>
  );
}
