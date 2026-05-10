import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { users } from '@aiag/database/schema';
import { eq } from '@aiag/database';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Профиль — AI-Aggregator' };

export default async function ProfilePage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login?callbackUrl=/dashboard/profile');
  const u = await db.query.users
    .findFirst({
      where: eq(users.id, session.user.id),
      columns: {
        name: true,
        email: true,
        username: true,
        role: true,
        createdAt: true,
      },
    })
    .catch(() => null);

  return (
    <section className="container mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-3xl font-bold tracking-tight mb-2">Профиль</h1>
      <p className="text-muted-foreground mb-6">Базовая информация аккаунта.</p>
      <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
        <dt className="text-muted-foreground">Имя</dt>
        <dd className="sm:col-span-2">{u?.name ?? '—'}</dd>
        <dt className="text-muted-foreground">Email</dt>
        <dd className="sm:col-span-2 font-mono">{u?.email ?? '—'}</dd>
        <dt className="text-muted-foreground">Username</dt>
        <dd className="sm:col-span-2 font-mono">{u?.username ?? '—'}</dd>
        <dt className="text-muted-foreground">Роль</dt>
        <dd className="sm:col-span-2">{u?.role ?? '—'}</dd>
      </dl>
      <p className="mt-8 text-xs text-muted-foreground">
        Редактирование появится в следующей итерации.
      </p>
    </section>
  );
}
