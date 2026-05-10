'use client';

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

  return (
    <aside
      className="w-60 shrink-0 border-r"
      style={{ borderColor: 'var(--line)', background: 'var(--bg-elev)' }}
    >
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
  );
}
