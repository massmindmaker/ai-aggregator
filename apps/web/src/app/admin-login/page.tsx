import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { users } from '@aiag/database/schema';
import { eq } from '@aiag/database';
import { ADMIN_COOKIE_NAME, verifyAdminSession } from '@/lib/admin/session';
import AdminLoginForm from './AdminLoginForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Вход в админку — AI-Aggregator' };

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  // If both gates already pass, send the user straight to /admin.
  const session = await auth();
  if (session?.user?.email) {
    const u = await db.query.users.findFirst({
      where: eq(users.email, session.user.email),
    });
    if (u && u.role === 'admin') {
      const c = await cookies();
      const ok = await verifyAdminSession(c.get(ADMIN_COOKIE_NAME)?.value, u.id);
      if (ok) redirect('/admin');
    }
  }

  const params = await searchParams;
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <span className="font-mono font-bold tracking-tight text-[20px]">
            ai<span style={{ color: 'var(--accent)' }}>-</span>aggregator
            <span className="ms-2 text-[11px] uppercase tracking-wider text-muted-foreground">
              admin
            </span>
          </span>
          <h1 className="mt-5 text-xl font-semibold text-foreground">
            Вход в админ-панель
          </h1>
          <p className="mt-2 text-xs text-muted-foreground">
            Дополнительная защита поверх обычного входа. Пароль обязателен — OAuth здесь не доступен.
          </p>
        </div>

        <AdminLoginForm error={params.error ?? null} />

        <p className="text-center text-xs text-muted-foreground mt-6">
          Не админ?{' '}
          <a href="/dashboard" className="text-[var(--accent)] hover:underline">
            Вернуться в кабинет
          </a>
        </p>
      </div>
    </div>
  );
}
