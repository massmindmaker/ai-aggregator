import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { db, sql } from '@/lib/db';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Мои submissions — AI-Aggregator' };

interface Row {
  id: string;
  contest_slug: string | null;
  contest_name: string | null;
  created_at: string;
  status: string;
  public_score: string | null;
  private_score: string | null;
  rank_public: number | null;
  is_final: boolean;
  is_selected: boolean;
  eval_error: string | null;
  disqualified: boolean | null;
  overfitting_detected: boolean | null;
}

const STATUS_META: Record<
  string,
  { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning' }
> = {
  pending: { label: 'Загружено', variant: 'outline' },
  scanning: { label: 'Антивирус', variant: 'outline' },
  evaluating: { label: 'Оценка', variant: 'warning' },
  scored: { label: 'Оценено', variant: 'success' },
  failed: { label: 'Ошибка', variant: 'destructive' },
  invalid: { label: 'Невалидно', variant: 'destructive' },
  final: { label: 'Финал', variant: 'default' },
  winner: { label: 'Победитель', variant: 'success' },
};

export default async function MySubmissionsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login?callbackUrl=/dashboard/submissions');

  let rows: Row[] = [];
  try {
    const r = await db.execute(sql`
      SELECT s.id::text AS id,
             c.slug AS contest_slug, c.name AS contest_name,
             s.created_at::text AS created_at,
             s.status::text AS status,
             s.public_score::text AS public_score,
             s.private_score::text AS private_score,
             s.rank_public, s.is_final, s.is_selected, s.eval_error,
             s.disqualified, s.overfitting_detected
      FROM contest_submissions s
      LEFT JOIN contests c ON c.id = s.contest_id
      WHERE s.user_id = ${session.user.id}::uuid
      ORDER BY s.created_at DESC
      LIMIT 100
    `);
    rows = (((r as unknown as { rows?: unknown[] }).rows ?? r) as Row[]);
  } catch {
    rows = [];
  }

  return (
    <div className="container mx-auto px-4 py-10 max-w-5xl">
      <h1 className="text-3xl font-bold tracking-tight mb-6">Мои submissions</h1>

      {rows.length === 0 ? (
        <div className="rounded-lg border">
          <EmptyState
            illustration="submissions"
            title="Пока нет сабмиссий"
            description="Участвуйте в конкурсах чтобы попасть в лидерборд."
            actionLabel="К конкурсам"
            actionHref="/contests"
          />
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
                <TableHead>Заметки</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const meta = STATUS_META[r.status] ?? STATUS_META.pending;
                return (
                  <TableRow key={r.id}>
                    <TableCell>
                      {r.contest_slug ? (
                        <Link
                          href={`/contests/${r.contest_slug}`}
                          className="hover:text-[var(--accent)]"
                        >
                          {r.contest_name ?? r.contest_slug}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                      {r.is_final && (
                        <Badge variant="outline" className="ml-2">
                          final-candidate
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {r.created_at?.slice(0, 10)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={meta.variant as never}>{meta.label}</Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {r.public_score != null ? Number(r.public_score).toFixed(4) : '—'}
                    </TableCell>
                    <TableCell className="text-right text-sm">{r.rank_public ?? '—'}</TableCell>
                    <TableCell>
                      {r.eval_error && (
                        <span
                          className="text-xs text-destructive"
                          title={r.eval_error}
                        >
                          {r.eval_error.slice(0, 40)}…
                        </span>
                      )}
                      {r.overfitting_detected && (
                        <Badge variant="destructive" className="text-xs ml-1">
                          overfit
                        </Badge>
                      )}
                      {r.disqualified && (
                        <Badge variant="destructive" className="text-xs ml-1">
                          DQ
                        </Badge>
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
        Private scores отображаются после окончания конкурса. Вы можете отметить до 3 submissions как финальных кандидатов — остальные пойдут автоматически (топ-3 по public).
      </p>
    </div>
  );
}
