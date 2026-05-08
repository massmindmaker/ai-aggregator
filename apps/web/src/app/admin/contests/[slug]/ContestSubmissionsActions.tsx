'use client';

import * as React from 'react';
import { Button } from '@/components/ui/Button';
import { PublishSubmissionModal } from './PublishSubmissionModal';

export function ContestSubmissionsActions({
  slug,
  submissionId,
  rank,
  finalRank,
  participantEmail,
  suggestedSlug,
}: {
  slug: string;
  submissionId: string;
  rank: number;
  finalRank: number | null;
  participantEmail: string | null;
  suggestedSlug: string;
}) {
  const [busy, setBusy] = React.useState(false);
  const setWinner = async (place: number) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/contests/${slug}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'setWinner', submissionId, rank: place }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert(`Ошибка: ${j.error ?? r.status}`);
      } else window.location.reload();
    } finally {
      setBusy(false);
    }
  };

  const effectiveRank = finalRank ?? rank;
  const canPublish = effectiveRank !== null && effectiveRank <= 3;

  return (
    <div className="flex gap-1 justify-end items-center">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => setWinner(1)}>
        🥇
      </Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => setWinner(2)}>
        🥈
      </Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => setWinner(3)}>
        🥉
      </Button>
      {canPublish ? (
        <PublishSubmissionModal
          slug={slug}
          submissionId={submissionId}
          finalRank={effectiveRank}
          participantEmail={participantEmail}
          suggestedSlug={suggestedSlug}
        />
      ) : null}
    </div>
  );
}
