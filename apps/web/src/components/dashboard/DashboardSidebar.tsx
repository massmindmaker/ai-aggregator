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
  hasAuthored: boolean;
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

const ALWAYS = [
  { href: '/dashboard/profile', label: 'Профиль', icon: User },
  { href: '/dashboard/security', label: 'Безопасность', icon: Lock },
  { href: '/dashboard/referrals', label: 'Реферралы', icon: UsersIcon },
];

const MODE_CHIPS: { mode: Mode; label: string; emoji: string }[] = [
  { mode: 'user', label: 'User', emoji: '👤' },
  { mode: 'author', label: 'Author', emoji: '🎨' },
];

// Shown in place of the Author chip until the user has earned it — a subtle
// link to the action that earns it, not a dead end.
const UNEARNED_AUTHOR_CTA = {
  label: 'Опубликовать модель',
  href: '/dashboard/models/new',
};

function itemsFor(mode: Mode) {
  switch (mode) {
    case 'author':
      return ITEMS_AUTHOR;
    case 'user':
    default:
      return ITEMS_USER;
  }
}

export default function DashboardSidebar({ isAdmin, hasAuthored }: Props) {
  const pathname = usePathname() ?? '/dashboard';
  const searchParams = useSearchParams();
  const mode = resolveMode(searchParams.get('mode') ?? undefined, pathname, {
    hasAuthored,
  });
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close drawer on route change.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname, searchParams]);

  // Lock body scroll while drawer open
  useEffect(() => {
    if (!mobileOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [mobileOpen]);

  // Close on Escape
  useEffect(() => {
    if (!mobileOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMobileOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen]);

  const sidebarBody = (
    <>
      <div className="p-4 flex flex-col gap-1">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
          Режим
        </div>
        <div className="flex flex-col gap-1 mb-3">
          {MODE_CHIPS.map((c) => {
            if (c.mode === 'author' && !hasAuthored) {
              return (
                <Link
                  key={c.mode}
                  href={UNEARNED_AUTHOR_CTA.href}
                  className="flex items-center px-3 py-2 text-[13px] rounded transition-colors text-muted-foreground hover:text-foreground hover:bg-white/[0.04]"
                >
                  {UNEARNED_AUTHOR_CTA.label}
                </Link>
              );
            }
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
    </>
  );

  return (
    <>
      {/* Mobile hamburger — visible < lg */}
      <button
        type="button"
        aria-label="Открыть меню кабинета"
        onClick={() => setMobileOpen(true)}
        className="lg:hidden fixed top-3 left-3 z-40 p-2 rounded-md border bg-[var(--bg-elev)] hover:bg-white/[0.04]"
        style={{ borderColor: 'var(--line)' }}
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Desktop static sidebar */}
      <aside
        className="hidden lg:flex shrink-0 w-60 border-r flex-col"
        style={{ borderColor: 'var(--line)', background: 'var(--bg-elev)' }}
      >
        {sidebarBody}
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div
          className="lg:hidden fixed inset-0 z-50"
          role="dialog"
          aria-modal="true"
          aria-label="Меню кабинета"
        >
          <div
            className="absolute inset-0 bg-black/70 aiag-drawer-overlay"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
          <aside
            className="aiag-drawer-panel-enter absolute inset-y-0 left-0 w-72 border-r flex flex-col"
            style={{ borderColor: 'var(--line)', background: 'var(--bg-elev)' }}
          >
            <button
              type="button"
              aria-label="Закрыть меню"
              onClick={() => setMobileOpen(false)}
              className="absolute top-3 right-3 p-1.5 rounded hover:bg-white/[0.04] z-10"
            >
              <X className="h-5 w-5" />
            </button>
            {sidebarBody}
          </aside>
        </div>
      )}
    </>
  );
}
