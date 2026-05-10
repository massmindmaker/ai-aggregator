// FIXME(spec §9 row 10): MOCK_SUBMISSIONS is hardcoded. Convert to a server
// component reading from `contest_submissions` JOIN `users` before public
// launch. Tracked in docs/superpowers/specs/2026-05-10-dashboard-ia-redesign-design.md §10.
import * as React from 'react';
import Link from 'next/link';
import MainLayout from '@/components/layout/MainLayout';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';

export const metadata = { title: 'Мои submissions — AI-Aggregator' };

type SubStatus =
  | 'uploaded'
  | 'scanning'
  | 'pending_eval'
  | 'evaluating'
  | 'scored'
  | 'failed'
  | 'invalid'
  | 'selected_for_final'
  | 'final'
  | 'winner'
  | 'runner_up';

interface SubmissionRow {
  id: string;
  contestSlug: string;
  contestName: string;
  submittedAt: string;
  status: SubStatus;
  publicScore: number | null;
  privateScore: number | null;
  privateRevealed: boolean;
  rankPublic: number | null;
  isFinal: boolean;
  evalError: string | null;
}

const MOCK_SUBMISSIONS: SubmissionRow[] = [
  {
    id: 's1',
    contestSlug: 'launch-banking-tx',
    contestName: 'Классификация банковских транзакций',
    submittedAt: '2026-04-23T14:12:00Z',
    status: 'scored',
    publicScore: 0.8831,
    privateScore: null,
    privateRevealed: false,
    rankPublic: 5,
    isFinal: true,
    evalError: null,
  },
  {
    id: 's2',
    contestSlug: 'launch-banking-tx',
    contestName: 'Классификация банковских транзакций',
    submittedAt: '2026-04-22T10:02:00Z',
    status: 'scored',
    publicScore: 0.8710,
    privateScore: null,
    privateRevealed: false,
    rankPublic: 9,
    isFinal: false,
    evalError: null,
  },
  {
    id: 's3',
    contestSlug: 'launch-banking-tx',
    contestName: 'Классификация банковских транзакций',
    submittedAt: '2026-04-20T20:30:00Z',
    status: 'failed',
    publicScore: null,
    privateScore: null,
    privateRevealed: false,
    rankPublic: null,
    isFinal: false,
    evalError: 'Schema mismatch: expected column "prediction", got "pred"',
  },
];

const STATUS_META: Record<SubStatus, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning' }> = {
  uploaded: { label: 'Загружено', variant: 'outline' },
  scanning: { label: 'Антивирус', variant: 'outline' },
  pending_eval: { label: 'В очереди', variant: 'outline' },
  evaluating: { label: 'Оценка', variant: 'warning' as any },
  scored: { label: 'Оценено', variant: 'success' as any },
  failed: { label: 'Ошибка', variant: 'destructive' },
  invalid: { label: 'Невалидно', variant: 'destructive' },
  selected_for_final: { label: 'Финалист', variant: 'default' },
  final: { label: 'Финал', variant: 'default' },
  winner: { label: 'Победитель', variant: 'success' as any },
  runner_up: { label: '2 место', variant: 'success' as any },
};

export default function MySubmissionsPage() {
  const rows = MOCK_SUBMISSIONS;

  return (
    <MainLayout>
      <div className="container mx-auto px-4 py-10 max-w-5xl">
        <h1 className="text-3xl font-bold tracking-tight mb-6">
          Мои submissions
        </h1>

        {rows.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground border rounded-lg">
            Пока нет submissions. <Link href="/contests" className="text-primary underline-offset-4 hover:underline">Найти конкурс</Link>.
          </div>
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Конкурс</TableHead>
                  <TableHead>Дата</TableHead>
                  <TableHead>Статус</TableHead>
                  <TableHead className="text-right">Public</TableHead>
                  <TableHead className="text-right">Ранг</TableHead>
                  <TableHead>Действия</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const meta = STATUS_META[r.status];
                  return (
                    <TableRow key={r.id}>
                      <TableCell>
                        <Link
                          href={`/contests/${r.contestSlug}`}
                          className="hover:text-primary"
                        >
                          {r.contestName}
                        </Link>
                        {r.isFinal && (
                          <Badge variant="outline" className="ml-2">
                            final-candidate
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {new Date(r.submittedAt).toLocaleDateString('ru-RU')}
                      </TableCell>
                      <TableCell>
                        <Badge variant={meta.variant}>{meta.label}</Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {r.publicScore?.toFixed(4) ?? '—'}
                      </TableCell>
                      <TableCell className="text-right text-sm">
                        {r.rankPublic ?? '—'}
                      </TableCell>
                      <TableCell>
                        {r.status === 'failed' && r.evalError && (
                          <span
                            className="text-xs text-destructive"
                            title={r.evalError}
                          >
                            {r.evalError.slice(0, 40)}…
                          </span>
                        )}
                        {r.status === 'scored' && !r.isFinal && (
                          <Button variant="ghost" size="sm">
                            В финал
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        <p className="text-xs text-muted-foreground mt-4">
          Private scores отображаются после окончания конкурса. Вы можете
          отметить до 3 submissions как финальных кандидатов — остальные пойдут
          автоматически (топ-3 по public).
        </p>
      </div>
    </MainLayout>
  );
}
