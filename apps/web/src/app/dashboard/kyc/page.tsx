import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { db, sql } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'KYC — AI-Aggregator' };

interface KycRow {
  kyc_status: string | null;
  kyc_type: string | null;
  tax_id: string | null;
}

export default async function KycPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login?callbackUrl=/dashboard/kyc');
  let u: KycRow | undefined;
  try {
    const r = await db.execute(sql`
      SELECT kyc_status, kyc_type, tax_id FROM users
      WHERE id = ${session.user.id}::uuid LIMIT 1
    `);
    u = (((r as unknown as { rows?: unknown[] }).rows ?? r) as KycRow[])[0];
  } catch {
    u = undefined;
  }

  return (
    <section className="container mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-3xl font-bold tracking-tight mb-2">KYC</h1>
      <p className="text-muted-foreground mb-6">
        Подтверждение личности нужно для выплат с баланса.
      </p>
      <dl
        className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm rounded-md border p-5"
        style={{ borderColor: 'var(--line)' }}
      >
        <dt className="text-muted-foreground">Статус</dt>
        <dd className="sm:col-span-2 font-mono">
          {u?.kyc_status ?? 'не пройдено'}
        </dd>
        <dt className="text-muted-foreground">Тип</dt>
        <dd className="sm:col-span-2">{u?.kyc_type ?? '—'}</dd>
        <dt className="text-muted-foreground">ИНН / Tax ID</dt>
        <dd className="sm:col-span-2 font-mono">{u?.tax_id ?? '—'}</dd>
      </dl>
      <p className="mt-6 text-xs text-muted-foreground">
        Загрузка документов появится после подключения S3 (REQ-INF-011).
      </p>
    </section>
  );
}
