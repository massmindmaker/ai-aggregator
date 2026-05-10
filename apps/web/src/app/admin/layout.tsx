import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { auth } from '@/auth';
import { db, eq } from '@/lib/db';
import { users } from '@aiag/database/schema';
import AdminSidebar from '@/components/admin/AdminSidebar';
import { verifyAdminSession } from '@/lib/admin/session';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Two gates: (1) authenticated user with role=admin, (2) admin-session
  // cookie set via the dedicated /admin-login flow. Without the cookie a
  // logged-in admin is redirected to /admin-login (NOT /dashboard) so the
  // step-up is explicit.
  const session = await auth();
  if (!session?.user?.email) redirect('/admin-login');

  const u = await db.query.users.findFirst({
    where: eq(users.email, session.user.email),
  });
  if (!u || u.role !== 'admin') redirect('/dashboard');

  const cookieStore = await cookies();
  const adminCookie = cookieStore.get('aiag_admin_session')?.value;
  const adminSessionOk = await verifyAdminSession(adminCookie, u.id);
  if (!adminSessionOk) redirect('/admin-login');

  return (
    <div className="min-h-screen flex bg-background">
      <AdminSidebar email={session.user.email} />
      <main className="flex-1 min-w-0 overflow-x-hidden">{children}</main>
    </div>
  );
}
