'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Activity,
  Network,
  Briefcase,
  Boxes,
  Plug,
  Users,
  Building2,
  Trophy,
  ShieldCheck,
  CreditCard,
  Banknote,
  Tag,
  Share2,
  ScanSearch,
  ScrollText,
  Webhook,
  Settings,
  Cpu,
  Menu,
  X,
  ChevronDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
}

interface NavSection {
  heading: string;
  items: NavItem[];
}

// Structure mirrors brain/Projects/AIAG/Wireframes/admin/overview.html —
// vertical sidebar grouped by domain (Operations / Catalog / People / Finance /
// Infrastructure / System) instead of a flat 16-item horizontal nav.
const SECTIONS: NavSection[] = [
  {
    heading: 'Operations',
    items: [
      { href: '/admin', label: 'Обзор', icon: LayoutDashboard },
      { href: '/admin/requests', label: 'Запросы', icon: Activity },
      { href: '/admin/routing', label: 'Роутинг', icon: Network },
      { href: '/admin/jobs', label: 'Джобы', icon: Briefcase },
      { href: '/admin/worker', label: 'Worker', icon: Cpu },
    ],
  },
  {
    heading: 'Catalog',
    items: [
      { href: '/admin/models', label: 'Модели', icon: Boxes },
      { href: '/admin/upstreams', label: 'Аплинки', icon: Plug },
      { href: '/admin/contests', label: 'Контесты', icon: Trophy },
    ],
  },
  {
    heading: 'People',
    items: [
      { href: '/admin/users', label: 'Юзеры', icon: Users },
      { href: '/admin/orgs', label: 'Орги', icon: Building2 },
      { href: '/admin/kyc-queue', label: 'KYC очередь', icon: ShieldCheck },
    ],
  },
  {
    heading: 'Finance',
    items: [
      { href: '/admin/payments', label: 'Платежи', icon: CreditCard },
      { href: '/admin/payouts', label: 'Выплаты', icon: Banknote },
      { href: '/admin/promos', label: 'Промокоды', icon: Tag },
      { href: '/admin/referrals', label: 'Реферралы', icon: Share2 },
    ],
  },
  {
    heading: 'Moderation',
    items: [
      { href: '/admin/moderation/models', label: 'Модели', icon: ScanSearch },
      { href: '/admin/moderation/submissions', label: 'Сабмишены', icon: ScanSearch },
      { href: '/admin/audit', label: 'Аудит', icon: ScrollText },
      { href: '/admin/cohorts', label: 'Когорты', icon: Activity },
    ],
  },
  {
    heading: 'System',
    items: [
      { href: '/admin/webhooks', label: 'Webhooks', icon: Webhook },
      { href: '/admin/settings', label: 'Настройки', icon: Settings },
    ],
  },
];

interface Props {
  email: string;
}

const STORAGE_KEY = 'aiag-admin-sidebar-collapsed';

export default function AdminSidebar({ email }: Props) {
  const pathname = usePathname() ?? '/admin';
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setCollapsed(JSON.parse(saved));
    } catch {}
  }, []);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  function toggleSection(heading: string) {
    setCollapsed((prev) => {
      const next = { ...prev, [heading]: !prev[heading] };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }

  return (
    <>
      <button
        type="button"
        aria-label="Открыть admin-меню"
        onClick={() => setMobileOpen(true)}
        className="lg:hidden fixed top-3 left-3 z-40 p-2 rounded-md border bg-[var(--bg-elev)] hover:bg-white/[0.04]"
        style={{ borderColor: 'var(--line)' }}
      >
        <Menu className="h-5 w-5" />
      </button>

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
          'lg:static lg:w-60 lg:translate-x-0',
          'fixed inset-y-0 left-0 z-50 w-72 transition-transform duration-200 ease-out',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        )}
        style={{ borderColor: 'var(--line)', background: 'var(--bg-elev)' }}
      >
      <button
        type="button"
        aria-label="Закрыть меню"
        onClick={() => setMobileOpen(false)}
        className="lg:hidden absolute top-3 right-3 p-1.5 rounded hover:bg-white/[0.04] z-10"
      >
        <X className="h-5 w-5" />
      </button>
      <div
        className="px-4 py-4 border-b"
        style={{ borderColor: 'var(--line)' }}
      >
        <Link href="/admin" className="font-mono font-bold text-[14px] tracking-tight">
          ai<span style={{ color: 'var(--accent)' }}>-</span>aggregator
          <span className="ms-2 text-[11px] uppercase tracking-wider text-muted-foreground">
            admin
          </span>
        </Link>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-3 flex flex-col gap-1">
        {SECTIONS.map((section) => {
          const isCollapsed = !!collapsed[section.heading];
          const hasActive = section.items.some(
            (item) =>
              pathname === item.href ||
              (item.href !== '/admin' && pathname.startsWith(item.href + '/'))
          );
          return (
            <div key={section.heading} className="flex flex-col">
              <button
                type="button"
                onClick={() => toggleSection(section.heading)}
                className={cn(
                  'flex items-center justify-between px-3 py-1.5 rounded',
                  'text-[10px] uppercase tracking-wider font-semibold',
                  'hover:bg-white/[0.04] transition-colors cursor-pointer select-none',
                  hasActive && isCollapsed
                    ? 'text-[var(--accent)]'
                    : 'text-muted-foreground'
                )}
              >
                <span>{section.heading}</span>
                <ChevronDown
                  className={cn(
                    'h-3 w-3 transition-transform duration-150',
                    isCollapsed ? '-rotate-90' : 'rotate-0'
                  )}
                />
              </button>
              {!isCollapsed && (
                <div className="flex flex-col gap-0.5 mt-0.5">
                  {section.items.map((item) => {
                    const active =
                      pathname === item.href ||
                      (item.href !== '/admin' && pathname.startsWith(item.href + '/'));
                    const Icon = item.icon;
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        className={cn(
                          'flex items-center gap-2 px-3 py-2 text-[13px] rounded transition-colors',
                          active
                            ? 'bg-[rgba(245,158,11,0.08)] text-foreground border-l-2 border-l-[var(--accent)]'
                            : 'text-muted-foreground hover:text-foreground hover:bg-white/[0.04] border-l-2 border-l-transparent'
                        )}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        <span>{item.label}</span>
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div
        className="px-4 py-3 border-t text-[11px] text-muted-foreground truncate"
        style={{ borderColor: 'var(--line)' }}
        title={email}
      >
        {email}
      </div>
      </aside>
    </>
  );
}
