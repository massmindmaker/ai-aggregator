import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { db, sql } from '@/lib/db';
import { users } from '@aiag/database/schema';
import { eq } from '@aiag/database';
import MainLayout from '@/components/layout/MainLayout';
import { Badge } from '@/components/ui/Badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Flagged submissions — AI-Aggregator' };

interface FlagRow {
  id: string;
  contest_slug: string | null;
  contest_name: string | null;
  author_username: string | null;
  author_email: string | null;
  public_score: string | null;
  private_score: string | null;
  created_at: string;
  disqualified: boolean | null;
  overfitting_detected: boolean | null;
  schema_valid: boolean | null;
  eval_error: string | null;
}

function classify(row: FlagRow): { label: string; variant: 'destructive' | 'warning' | 'outline' } {
  if (row.disqualified) return { label: 'Disqualified', variant: 'destructive' };
  if (row.overfitting_detected) return { label: 'Overfit', variant: 'warning' };
  if (row.schema_valid === false) return { label: 'Schema invalid', variant: 'destructive' };
  if (row.eval_error) return { label: 'Eval error', variant: 'destructive' };
  return { label: 'Manual', variant: 'outline' };
}

export default async function AdminFlaggedSubmissionsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login?callbackUrl=/admin/moderation/submissions');
  const me = await db.query.users.findFirst({
    where: eq(users.email, session.user.email!),
  });
  if (!me || me.role !== 'admin') redirect('/dashboard');

  const r = await db.execute(sql`
    SELECT s.id::text AS id,
           c.slug AS contest_slug, c.name AS contest_name,
           u.username AS author_username, u.email AS author_email,
           s.public_score::text AS public_score,
           s.private_score::text AS private_score,
           s.created_at,
           s.disqualified, s.overfitting_detected, s.schema_valid, s.eval_error
    FROM contest_submissions s
    LEFT JOIN contests c ON c.id = s.contest_id
    LEFT JOIN users u ON u.id = s.user_id
    WHERE s.disqualified = true
       OR s.overfitting_detected = true
       OR s.schema_valid = false
       OR s.eval_error IS NOT NULL
    ORDER BY s.created_at DESC
    LIMIT 200
  `);
  const rows = ((r as unknown as { rows?: unknown[] }).rows ?? r) as FlagRow[];

  return (
    <MainLayout>
      <div className="container mx-auto px-4 py-10 max-w-6xl">
        <h1 className="text-3xl font-bold tracking-tight mb-2">
          Flagged submissions
        </h1>
        <p className="text-muted-foreground mb-6">
          Сабмишены, которые eval-runner пометил как overfit, schema-invalid, eval-error либо disqualified.
        </p>

        {rows.length === 0 ? (
          <div className="rounded-lg border bg-card p-12 text-center text-muted-foreground">
            Флагов нет.
          </div>
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Конкурс</TableHead>
                  <TableHead>Автор</TableHead>
                  <TableHead>Причина</TableHead>
                  <TableHead className="text-right">Public</TableHead>
                  <TableHead className="text-right">Private</TableHead>
                  <TableHead>Дата</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((f) => {
                  const meta = classify(f);
                  return (
                    <TableRow key={f.id}>
                      <TableCell>{f.contest_name || f.contest_slug || '—'}</TableCell>
                      <TableCell>
                        {f.author_username ? `@${f.author_username}` : f.author_email || '—'}
                      </TableCell>
                      <TableCell>
                        <Badge variant={meta.variant as never}>{meta.label}</Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {f.public_score != null ? Number(f.public_score).toFixed(4) : '—'}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {f.private_score != null ? Number(f.private_score).toFixed(4) : '—'}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(f.created_at).toLocaleDateString('ru-RU')}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </MainLayout>
  );
}
