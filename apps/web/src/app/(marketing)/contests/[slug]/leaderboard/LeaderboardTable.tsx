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

// MVP: mocked response — real endpoint reads Redis cache (7s TTL) from
// the leaderboard aggregate query (Plan 07 §8.2).
const MOCK_BY_SLUG: Record<string, LeaderboardPayload> = {
  'launch-banking-tx': mockData(false),
  'ru-doc-summarization': mockData(false),
  'ru-ner-medical': mockData(true),
};

function mockData(privateRevealed: boolean): LeaderboardPayload {
  const names = [
    ['Ирина К.', 'irina-k'],
    ['Алексей М.', 'alexey-m'],
    ['Вы', 'me'],
    ['Дарья П.', 'darya-p'],
    ['Maxim Sh.', 'maxim-sh'],
    ['team_bayes', 'team-bayes'],
    ['Pavel N.', 'pavel-n'],
    ['sofiia', 'sofiia'],
  ];
  const rows: LeaderboardRow[] = names.map(([name, username], i) => ({
    rank: i + 1,
    authorName: name,
    authorUsername: username,
    bestPublic: Number((0.942 - i * 0.011).toFixed(4)),
    bestPrivate: privateRevealed
      ? Number((0.939 - i * 0.012).toFixed(4))
      : null,
    submissionsCount: 15 - i,
    firstSubmittedAt: '2026-04-16T12:00:00Z',
    isCurrentUser: username === 'me',
  }));
  return {
    rows,
    privateRevealed,
    updatedAt: new Date().toISOString(),
  };
}

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
