'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { Menu, X } from 'lucide-react';
import UserMenu from '@/components/UserMenu';
import { AiagLogo } from '@/components/ui/AiagLogo';

const mainMenu = [
  { title: 'Маркетплейс', href: '/marketplace' },
  { title: 'Конкурсы', href: '/contests' },
  { title: 'Документация', href: '/docs' },
  { title: 'Тарифы', href: '/pricing' },
  { title: 'Для бизнеса', href: '/business' },
];

/**
 * Pixel-match navbar per home.html mockup.
 * Sticky, blurred dark, mono "ai-aggregator" wordmark with amber dash.
 *
 * Client component on purpose: pulls session via useSession (no DB), so that
 * any 'use client' page (e.g. dashboard/billing, pricing/PricingClient) can
 * import MainLayout without leaking pg into the client bundle.
 */
const MainNavbar = () => {
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === 'admin';
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <header
      className="sticky top-0 z-50 w-full border-b backdrop-blur-md"
      style={{ background: 'rgba(10,10,11,0.72)', borderColor: 'var(--line)' }}
    >
      <div className="flex items-center justify-between px-5 md:px-12 py-4">
        <Link href="/" className="flex items-center select-none">
          <AiagLogo height={22} animated />
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

        <div className="hidden lg:flex items-center gap-2.5">
          <button
            type="button"
            onClick={() =>
              window.dispatchEvent(new CustomEvent('aiag-command-palette-open'))
            }
            className="hidden lg:inline-flex items-center gap-2 px-3 py-1.5 text-xs rounded-md border opacity-60 hover:opacity-100 transition-opacity"
            style={{ borderColor: 'var(--line)' }}
            aria-label="Открыть команды"
          >
            <span>Поиск</span>
            <kbd className="font-mono">⌘K</kbd>
          </button>
          {session?.user ? (
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
          )}
        </div>

        <button
          type="button"
          aria-label="Открыть меню"
          className="lg:hidden p-2 rounded-md hover:bg-white/[0.04] transition-colors"
          onClick={() => setDrawerOpen(true)}
        >
          <Menu className="h-5 w-5" />
        </button>
      </div>

      {drawerOpen && (
        <div
          className="fixed inset-0 z-50 lg:hidden"
          role="dialog"
          aria-modal="true"
        >
          <div
            className="absolute inset-0 bg-black/70"
            onClick={() => setDrawerOpen(false)}
          />
          <aside
            className="absolute inset-y-0 end-0 w-72 border-s shadow-xl flex flex-col"
            style={{ background: 'var(--bg-elev)', borderColor: 'var(--line)' }}
          >
            <div
              className="flex items-center justify-between p-4 border-b"
              style={{ borderColor: 'var(--line)' }}
            >
              <span className="font-mono font-bold text-sm">
                ai<span style={{ color: 'var(--accent)' }}>-</span>aggregator
              </span>
              <button
                type="button"
                aria-label="Закрыть меню"
                className="p-2 rounded-md hover:bg-white/[0.04] transition-colors"
                onClick={() => setDrawerOpen(false)}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <ul className="flex flex-col p-2 flex-1">
              {mainMenu.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setDrawerOpen(false)}
                    className="block px-4 py-3 text-sm hover:bg-white/[0.04] rounded"
                  >
                    {item.title}
                  </Link>
                </li>
              ))}
            </ul>
            <div
              className="p-4 border-t flex flex-col gap-2"
              style={{ borderColor: 'var(--line)' }}
            >
              {session?.user ? (
                <>
                  <div className="px-1 pb-1 text-xs text-muted-foreground truncate">
                    {session.user.name || session.user.email}
                  </div>
                  <Link
                    href="/dashboard"
                    onClick={() => setDrawerOpen(false)}
                    className="inline-flex justify-center items-center px-4 py-2.5 text-sm font-semibold rounded-[2px] border"
                    style={{ borderColor: 'var(--line)' }}
                  >
                    Dashboard
                  </Link>
                  <Link
                    href="/dashboard/profile"
                    onClick={() => setDrawerOpen(false)}
                    className="inline-flex justify-center items-center px-4 py-2.5 text-sm rounded-[2px] border"
                    style={{ borderColor: 'var(--line)' }}
                  >
                    Профиль
                  </Link>
                  {isAdmin && (
                    <Link
                      href="/admin"
                      onClick={() => setDrawerOpen(false)}
                      className="inline-flex justify-center items-center px-4 py-2.5 text-sm font-semibold rounded-[2px] border"
                      style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}
                    >
                      Админка
                    </Link>
                  )}
                </>
              ) : (
                <>
                  <Link
                    href="/login"
                    onClick={() => setDrawerOpen(false)}
                    className="inline-flex justify-center items-center px-4 py-2.5 text-sm font-semibold rounded-[2px] border"
                    style={{ borderColor: 'var(--line)' }}
                  >
                    Войти
                  </Link>
                  <Link
                    href="/register"
                    onClick={() => setDrawerOpen(false)}
                    className="inline-flex justify-center items-center px-4 py-2.5 text-sm font-semibold rounded-[2px]"
                    style={{ background: 'var(--accent)', color: '#000' }}
                  >
                    Регистрация
                  </Link>
                </>
              )}
            </div>
          </aside>
        </div>
      )}
    </header>
  );
};

export default MainNavbar;
