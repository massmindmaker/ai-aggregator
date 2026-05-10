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
import ModerationActions from './ModerationActions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Модерация моделей — AI-Aggregator' };

interface PendingRow {
  id: string;
  slug: string;
  display_name: string | null;
  hosting_strategy: string;
  metadata: {
    endpoint_url?: string;
    pricing_hint_per_request_rub?: number | null;
    tier_pct?: number;
    exclusive?: boolean;
    hosted_by_intent?: 'platform' | 'author';
    submitted_at?: string;
  };
  created_at: string;
  author_email: string | null;
  author_username: string | null;
}

export default async function AdminModelsModerationPage() {
  const session = await auth();
  if (!session?.user) redirect('/login?callbackUrl=/admin/moderation/models');
  const me = await db.query.users.findFirst({
    where: eq(users.email, session.user.email!),
  });
  if (!me || me.role !== 'admin') redirect('/dashboard');

  const r = await db.execute(sql`
    SELECT m.id::text AS id, m.slug, m.display_name, m.hosting_strategy,
           m.metadata, m.created_at,
           u.email AS author_email, u.username AS author_username
    FROM models m
    LEFT JOIN users u ON u.id = m.author_user_id
    WHERE m.status = 'draft' AND m.metadata->>'review_state' = 'pending'
    ORDER BY m.created_at ASC
    LIMIT 200
  `);
  const rows = ((r as unknown as { rows?: unknown[] }).rows ?? r) as PendingRow[];

  return (
    <MainLayout>
      <div className="container mx-auto px-4 py-10 max-w-6xl">
        <h1 className="text-3xl font-bold tracking-tight mb-2">
          Модели на модерацию
        </h1>
        <p className="text-muted-foreground mb-6">
          Заявки авторов в очереди. Approve переведёт модель в <code>live</code> и сделает доступной в маркетплейсе.
          Reject требует причину — она вернётся автору в depublished_reason.
        </p>

        {rows.length === 0 ? (
          <div className="rounded-lg border bg-card p-12 text-center text-muted-foreground">
            Очередь пуста — все заявки разобраны.
          </div>
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Модель</TableHead>
                  <TableHead>Автор</TableHead>
                  <TableHead>Хостинг</TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead>Цена</TableHead>
                  <TableHead>Дата</TableHead>
                  <TableHead>Действия</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell>
                      <div className="font-medium">{m.display_name || m.slug}</div>
                      <div className="text-xs text-muted-foreground font-mono truncate max-w-[18rem]">
                        {m.metadata?.endpoint_url || '—'}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">
                      {m.author_username ? `@${m.author_username}` : m.author_email || '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {m.hosting_strategy === 'self_hosted_by_author' ? 'self-host' : 'cloud-wrap'}
                      </Badge>
                      {m.metadata?.exclusive && (
                        <Badge variant="default" className="ml-1">
                          exclusive
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>{m.metadata?.tier_pct ?? '—'}%</TableCell>
                    <TableCell className="text-sm">
                      {m.metadata?.pricing_hint_per_request_rub != null
                        ? `${m.metadata.pricing_hint_per_request_rub} ₽`
                        : '—'}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(m.created_at).toLocaleDateString('ru-RU')}
                    </TableCell>
                    <TableCell>
                      <ModerationActions modelId={m.id} slug={m.slug} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </MainLayout>
  );
}
