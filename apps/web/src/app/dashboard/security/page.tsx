import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Безопасность — AI-Aggregator' };

export default async function SecurityPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login?callbackUrl=/dashboard/security');
  return (
    <section className="container mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-3xl font-bold tracking-tight mb-2">Безопасность</h1>
      <p className="text-muted-foreground mb-6">
        Пароль, OAuth-привязки и сессии.
      </p>
      <div
        className="rounded-md border p-5 mb-4"
        style={{ borderColor: 'var(--line)' }}
      >
        <h2 className="font-semibold mb-2">Сменить пароль</h2>
        <p className="text-sm text-muted-foreground">
          Используйте{' '}
          <Link href="/forgot-password" className="text-[var(--accent)] hover:underline">
            сброс через email
          </Link>
          . Прямая смена будет добавлена позже.
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        Полный security center появится в следующей итерации.
      </p>
    </section>
  );
}
