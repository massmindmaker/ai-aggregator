'use client';

import * as React from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { cn } from '@/lib/utils';

interface LeaderboardRow {
  rank: number;
  authorName: string;
  authorUsername: string;
  bestPublic: number;
  bestPrivate: number | null;
  submissionsCount: number;
  firstSubmittedAt: string;
  isCurrentUser: boolean;
}

interface LeaderboardPayload {
  rows: LeaderboardRow[];
  privateRevealed: boolean;
  updatedAt: string;
}

// (MOCK data removed — real /api/contests/[slug]/leaderboard implemented.)

export default function LeaderboardTable({ slug }: { slug: string }) {
  const [data, setData] = React.useState<LeaderboardPayload | null>(() => null);
  const [loading, setLoading] = React.useState(true);

  const fetchBoard = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/contests/${slug}/leaderboard`, {
        cache: 'no-store',
      });
      if (res.ok) {
        const json = (await res.json()) as LeaderboardPayload;
        if (Array.isArray(json?.rows)) {
          setData(json);
          return;
        }
      }
      // Real API exists; on failure show empty rather than fake data.
      setData({ rows: [], privateRevealed: false, updatedAt: new Date().toISOString() });
    } catch {
      setData({ rows: [], privateRevealed: false, updatedAt: new Date().toISOString() });
    } finally {
      setLoading(false);
    }
  }, [slug]);

  React.useEffect(() => {
    fetchBoard();
    const interval = setInterval(fetchBoard, 30_000);
    return () => clearInterval(interval);
  }, [fetchBoard]);

  if (loading || !data) {
    return (
      <div className="text-muted-foreground text-sm">
        Загрузка leaderboard…
      </div>
    );
  }

  if (data.rows.length === 0) {
    return (
      <div className="py-12 text-center text-muted-foreground border rounded-lg">
        Пока нет оценённых submissions.
      </div>
    );
  }

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">#</TableHead>
            <TableHead>Участник</TableHead>
            <TableHead className="text-right">Public</TableHead>
            {data.privateRevealed && (
              <TableHead className="text-right">Private</TableHead>
            )}
            <TableHead className="text-right">Сабмитов</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.rows.map((r) => (
            <TableRow
              key={r.authorUsername}
              className={cn(
                r.isCurrentUser && 'bg-amber-500/10 hover:bg-amber-500/15'
              )}
            >
              <TableCell className="font-medium">{r.rank}</TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <span>{r.authorName}</span>
                  {r.isCurrentUser && (
                    <span className="text-xs text-amber-700 dark:text-amber-400">
                      (вы)
                    </span>
                  )}
                </div>
              </TableCell>
              <TableCell className="text-right font-mono">
                {r.bestPublic.toFixed(4)}
              </TableCell>
              {data.privateRevealed && (
                <TableCell className="text-right font-mono">
                  {r.bestPrivate?.toFixed(4) ?? '—'}
                </TableCell>
              )}
              <TableCell className="text-right text-muted-foreground">
                {r.submissionsCount}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
