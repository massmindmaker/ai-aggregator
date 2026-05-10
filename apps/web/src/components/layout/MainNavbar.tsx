import Link from 'next/link';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { users } from '@aiag/database/schema';
import { eq } from '@aiag/database';
import UserMenu from '@/components/UserMenu';
import MainNavbarMobile from './MainNavbarMobile';

const mainMenu = [
  { title: 'Маркетплейс', href: '/marketplace' },
  { title: 'Конкурсы', href: '/contests' },
  { title: 'Документация', href: '/docs' },
  { title: 'Тарифы', href: '/pricing' },
  { title: 'Для бизнеса', href: '/business' },
];

export default async function MainNavbar() {
  const session = await auth();
  let isAdmin = false;
  if (session?.user?.id) {
    const me = await db.query.users
      .findFirst({
        where: eq(users.id, session.user.id),
        columns: { role: true },
      })
      .catch(() => null);
    isAdmin = me?.role === 'admin';
  }

  const right = session?.user ? (
    <UserMenu
      name={session.user.name ?? null}
      email={session.user.email ?? ''}
      image={session.user.image ?? null}
      isAdmin={isAdmin}
    />
  ) : (
    <>
      <Link
        href="/login"
        className="inline-flex items-center px-4 py-2 text-[13px] font-semibold rounded-[2px] border transition-colors hover:bg-white/[0.04]"
        style={{ borderColor: 'var(--line)', color: 'var(--ink)' }}
      >
        Войти
      </Link>
      <Link
        href="/register"
        className="inline-flex items-center px-4 py-2 text-[13px] font-semibold rounded-[2px] border transition-all hover:-translate-y-px"
        style={{
          background: 'var(--accent)',
          color: '#000',
          borderColor: 'var(--accent)',
        }}
      >
        Регистрация
      </Link>
    </>
  );

  return (
    <header
      className="sticky top-0 z-50 w-full border-b backdrop-blur-md"
      style={{ background: 'rgba(10,10,11,0.72)', borderColor: 'var(--line)' }}
    >
      <div className="flex items-center justify-between px-5 md:px-12 py-4">
        <Link
          href="/"
          className="font-mono font-bold tracking-tight text-[15px] select-none text-foreground"
        >
          ai<span style={{ color: 'var(--accent)' }}>-</span>aggregator
        </Link>

        <nav className="hidden lg:flex items-center gap-7 text-[13px]">
          {mainMenu.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="navlink relative py-1.5 transition-colors text-muted-foreground hover:text-foreground"
            >
              {item.title}
            </Link>
          ))}
        </nav>

        <div className="hidden lg:flex items-center gap-2.5">{right}</div>

        <MainNavbarMobile
          menu={mainMenu}
          loggedIn={Boolean(session?.user)}
          name={session?.user?.name ?? null}
          email={session?.user?.email ?? ''}
          isAdmin={isAdmin}
        />
      </div>
    </header>
  );
}
