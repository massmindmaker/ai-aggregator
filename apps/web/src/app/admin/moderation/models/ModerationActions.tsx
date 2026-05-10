'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';

export default function ModerationActions({
  modelId,
  slug,
}: {
  modelId: string;
  slug: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);

  async function handleApprove() {
    setBusy('approve');
    try {
      const r = await fetch(`/api/admin/models/${modelId}/approve`, { method: 'POST' });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        alert(`Approve не прошёл: ${body.error || r.status}`);
        return;
      }
      startTransition(() => router.refresh());
    } finally {
      setBusy(null);
    }
  }

  async function handleReject() {
    const reason = window.prompt(`Причина отказа для "${slug}":`);
    if (!reason || !reason.trim()) return;
    setBusy('reject');
    try {
      const r = await fetch(`/api/admin/models/${modelId}/reject`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        alert(`Reject не прошёл: ${body.error || r.status}`);
        return;
      }
      startTransition(() => router.refresh());
    } finally {
      setBusy(null);
    }
  }

  const disabled = pending || busy !== null;

  return (
    <div className="flex gap-1">
      <Button
        size="sm"
        variant="default"
        disabled={disabled}
        onClick={handleApprove}
      >
        {busy === 'approve' ? '…' : 'Approve'}
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={handleReject}
      >
        {busy === 'reject' ? '…' : 'Reject'}
      </Button>
    </div>
  );
}
