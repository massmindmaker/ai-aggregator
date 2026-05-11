import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { users } from '@aiag/database/schema';
import { eq } from '@aiag/database';
import DashboardSidebar from '@/components/dashboard/DashboardSidebar';
import MainNavbar from '@/components/layout/MainNavbar';

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user?.id) {
    // No middleware in v1: we can't capture the original pathname here without
    // injecting x-pathname in middleware. Always-/dashboard post-login is the
    // documented v1 trade-off (see spec §8).
    redirect('/login?callbackUrl=/dashboard');
  }

  const me = await db.query.users
    .findFirst({
      where: eq(users.id, session.user.id),
      columns: { role: true },
    })
    .catch(() => null);
  const isAdmin = me?.role === 'admin';

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <MainNavbar />
      <div className="flex-1 flex">
        <DashboardSidebar isAdmin={isAdmin} />
        <main className="aiag-grid-bg-sm flex-1 min-w-0 overflow-x-hidden">{children}</main>
      </div>
    </div>
  );
}
