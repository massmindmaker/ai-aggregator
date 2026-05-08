import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/auth';
import { db, eq } from '@/lib/db';
import { users } from '@aiag/database/schema';

export const dynamic = 'force-dynamic';

const NAV: { href: string; label: string }[] = [
  { href: '/admin', label: 'Обзор' },
  { href: '/admin/requests', label: 'Запросы' },
  { href: '/admin/routing', label: 'Роутинг' },
  { href: '/admin/jobs', label: 'Джобы' },
  { href: '/admin/users', label: 'Юзеры' },
  { href: '/admin/orgs', label: 'Орги' },
  { href: '/admin/models', label: 'Модели' },
  { href: '/admin/upstreams', label: 'Аплинки' },
  { href: '/admin/contests', label: 'Контесты' },
  { href: '/admin/payouts', label: 'Выплаты' },
  { href: '/admin/kyc-queue', label: 'KYC очередь' },
  { href: '/admin/payments', label: 'Платежи' },
  { href: '/admin/moderation/models', label: 'Модерация' },
  { href: '/admin/audit', label: 'Аудит' },
  { href: '/admin/webhooks', label: 'Вебхуки' },
  { href: '/admin/settings', label: 'Настройки' },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user?.email) redirect('/login?next=/admin');

  const u = await db.query.users.findFirst({
    where: eq(users.email, session.user.email),
  });
  if (!u || u.role !== 'admin') redirect('/dashboard');

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <nav className="border-b bg-card sticky top-0 z-30">
        <div className="container mx-auto px-4 py-3 flex items-center gap-4 text-sm flex-wrap">
          <Link href="/admin" className="font-semibold text-amber-500">
            AIAG · Admin
          </Link>
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="hover:text-amber-400 text-muted-foreground">
              {n.label}
            </Link>
          ))}
          <span className="ml-auto text-muted-foreground">{session.user.email}</span>
        </div>
      </nav>
      {children}
    </div>
  );
}
