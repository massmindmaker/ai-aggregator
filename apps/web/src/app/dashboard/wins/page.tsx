import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { db, sql } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Победы — AI-Aggregator' };

interface Row {
  contest_name: string | null;
  rank: number | null;
  prize_amount: string | null;
  awarded_at: string | null;
}

export default async function WinsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login?callbackUrl=/dashboard/wins');
  let rows: Row[] = [];
  try {
    const r = await db.execute(sql`
      SELECT c.name AS contest_name, p.rank, p.amount::text AS prize_amount,
             p.created_at::text AS awarded_at
      FROM prize_awards p
      LEFT JOIN contests c ON c.id = p.contest_id
      WHERE p.user_id = ${session.user.id}::uuid
      ORDER BY p.created_at DESC
      LIMIT 50
    `);
    rows = (((r as unknown as { rows?: unknown[] }).rows ?? r) as Row[]);
  } catch {
    rows = [];
  }

  return (
    <section className="container mx-auto max-w-4xl px-6 py-10">
      <h1 className="text-3xl font-bold tracking-tight mb-2">Победы</h1>
      <p className="text-muted-foreground mb-6">
        Призовые места в конкурсах AI-Aggregator.
      </p>
      {rows.length === 0 ? (
        <div
          className="rounded-md border p-12 text-center text-muted-foreground"
          style={{ borderColor: 'var(--line)' }}
        >
          Пока ни одной победы — поучаствуйте в{' '}
          <a href="/contests" className="text-[var(--accent)] hover:underline">
            конкурсе
          </a>
          .
        </div>
      ) : (
        <table
          className="w-full text-sm border rounded-md"
          style={{ borderColor: 'var(--line)' }}
        >
          <thead className="text-xs uppercase text-muted-foreground bg-muted/30">
            <tr>
              <th className="px-4 py-3 text-left">Конкурс</th>
              <th className="px-4 py-3">Место</th>
              <th className="px-4 py-3 text-right">Приз</th>
              <th className="px-4 py-3 text-left">Дата</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-t" style={{ borderColor: 'var(--line)' }}>
                <td className="px-4 py-3">{row.contest_name ?? '—'}</td>
                <td className="px-4 py-3 text-center">{row.rank ?? '—'}</td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {row.prize_amount ? `${row.prize_amount} ₽` : '—'}
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {row.awarded_at?.slice(0, 10) ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
