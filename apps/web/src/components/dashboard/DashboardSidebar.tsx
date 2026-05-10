'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import {
  LayoutDashboard,
  Key,
  BarChart3,
  CreditCard,
  Webhook,
  Boxes,
  Wallet,
  Banknote,
  ShieldCheck,
  Trophy,
  Inbox,
  User,
  Lock,
  Users as UsersIcon,
  ShieldAlert,
  Menu,
  X,
} from 'lucide-react';
import { resolveMode, type Mode } from '@/lib/dashboard/mode';
import { cn } from '@/lib/utils';

interface Props {
  isAdmin: boolean;
}

const ITEMS_USER = [
  { href: '/dashboard', label: 'Обзор', icon: LayoutDashboard, exact: true },
  { href: '/dashboard/keys', label: 'API-ключи', icon: Key },
  { href: '/dashboard/usage', label: 'Использование', icon: BarChart3 },
  { href: '/dashboard/billing', label: 'Биллинг', icon: CreditCard },
  { href: '/dashboard/webhooks', label: 'Webhooks', icon: Webhook },
];

const ITEMS_AUTHOR = [
  { href: '/dashboard?mode=author', label: 'Обзор', icon: LayoutDashboard, exact: true },
  { href: '/dashboard/models', label: 'Мои модели', icon: Boxes },
  { href: '/dashboard/earnings', label: 'Заработок', icon: Wallet },
  { href: '/dashboard/payouts', label: 'Выплаты', icon: Banknote },
  { href: '/dashboard/kyc', label: 'KYC', icon: ShieldCheck },
];

const ITEMS_PARTICIPANT = [
  { href: '/dashboard?mode=participant', label: 'Обзор', icon: LayoutDashboard, exact: true },
  { href: '/dashboard/submissions', label: 'Мои сабмишены', icon: Inbox },
  { href: '/dashboard/wins', label: 'Победы', icon: Trophy },
  { href: '/contests', label: 'Конкурсы', icon: Boxes },
];

const ALWAYS = [
  { href: '/dashboard/profile', label: 'Профиль', icon: User },
  { href: '/dashboard/security', label: 'Безопасность', icon: Lock },
  { href: '/dashboard/referrals', label: 'Реферралы', icon: UsersIcon },
];

const MODE_CHIPS: { mode: Mode; label: string; emoji: string }[] = [
  { mode: 'user', label: 'User', emoji: '👤' },
  { mode: 'author', label: 'Author', emoji: '🎨' },
  { mode: 'participant', label: 'Participant', emoji: '🏆' },
];

function itemsFor(mode: Mode) {
  switch (mode) {
    case 'author':
      return ITEMS_AUTHOR;
    case 'participant':
      return ITEMS_PARTICIPANT;
    case 'user':
    default:
      return ITEMS_USER;
  }
}

export default function DashboardSidebar({ isAdmin }: Props) {
  const pathname = usePathname() ?? '/dashboard';
  const searchParams = useSearchParams();
  const mode = resolveMode(searchParams.get('mode') ?? undefined, pathname);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close drawer on route change.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname, searchParams]);

  return (
    <>
      {/* Mobile hamburger — fixed top-left, visible < lg */}
      <button
        type="button"
        aria-label="Открыть меню кабинета"
        onClick={() => setMobileOpen(true)}
        className="lg:hidden fixed top-3 left-3 z-40 p-2 rounded-md border bg-[var(--bg-elev)] hover:bg-white/[0.04]"
        style={{ borderColor: 'var(--line)' }}
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="lg:hidden fixed inset-0 z-40 bg-black/70"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={cn(
          'shrink-0 border-r flex flex-col',
          // Desktop: classic sidebar inline
          'lg:static lg:w-60 lg:translate-x-0',
          // Mobile: slide-over drawer
          'fixed inset-y-0 left-0 z-50 w-72 transition-transform duration-200 ease-out',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        )}
        style={{ borderColor: 'var(--line)', background: 'var(--bg-elev)' }}
      >
        <button
          type="button"
          aria-label="Закрыть меню"
          onClick={() => setMobileOpen(false)}
          className="lg:hidden absolute top-3 right-3 p-1.5 rounded hover:bg-white/[0.04]"
        >
          <X className="h-5 w-5" />
        </button>
      <div className="p-4 flex flex-col gap-1">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
          Режим
        </div>
        <div className="flex flex-col gap-1 mb-3">
          {MODE_CHIPS.map((c) => {
            const active = mode === c.mode;
            return (
              <Link
                key={c.mode}
                href={`/dashboard?mode=${c.mode}`}
                className={cn(
                  'flex items-center gap-2 px-3 py-2 text-[13px] rounded-md border transition-colors',
                  active
                    ? 'border-[var(--accent)] bg-[rgba(245,158,11,0.08)] text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-white/[0.04]'
                )}
              >
                <span>{c.emoji}</span>
                <span className="font-medium">{c.label}</span>
              </Link>
            );
          })}
        </div>
      </div>

      <nav className="px-2 pb-3 flex flex-col gap-0.5">
        {itemsFor(mode).map((item) => {
          const baseHref = item.href.split('?')[0];
          const active = item.exact
            ? pathname === '/dashboard' && (mode !== 'user' || true)
              ? pathname === baseHref
              : false
            : pathname === baseHref || pathname.startsWith(baseHref + '/');
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-2 px-3 py-2 text-[13px] rounded transition-colors',
                active
                  ? 'bg-white/[0.06] text-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-white/[0.04]'
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="border-t my-1" style={{ borderColor: 'var(--line)' }} />

      <nav className="px-2 py-2 flex flex-col gap-0.5">
        {ALWAYS.map((item) => {
          const active = pathname === item.href;
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-2 px-3 py-2 text-[13px] rounded transition-colors',
                active
                  ? 'bg-white/[0.06] text-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-white/[0.04]'
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span>{item.label}</span>
            </Link>
          );
        })}
        {isAdmin && (
          <Link
            href="/admin"
            className="mt-1 flex items-center gap-2 px-3 py-2 text-[13px] rounded border transition-colors hover:bg-white/[0.04]"
            style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}
          >
            <ShieldAlert className="h-4 w-4 shrink-0" />
            <span>Админка →</span>
          </Link>
        )}
      </nav>
      </aside>
    </>
  );
}
