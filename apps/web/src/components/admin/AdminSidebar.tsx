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
  ShieldCheck,
  CreditCard,
  Banknote,
  Coins,
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
import { AiagLogo } from '@/components/ui/AiagLogo';

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
      { href: '/admin/ton', label: 'TON review', icon: Coins },
      { href: '/admin/payouts', label: 'Выплаты', icon: Banknote },
      { href: '/admin/promos', label: 'Промокоды', icon: Tag },
      { href: '/admin/referrals', label: 'Реферралы', icon: Share2 },
    ],
  },
  {
    heading: 'Moderation',
    items: [
      { href: '/admin/moderation/models', label: 'Модели', icon: ScanSearch },
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

  // Lock body scroll while mobile drawer is open
  useEffect(() => {
    if (!mobileOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
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

  function toggleSection(heading: string) {
    setCollapsed((prev) => {
      const next = { ...prev, [heading]: !prev[heading] };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }

  const sidebarBody = (
    <>
      <div
        className="px-4 py-4 border-b"
        style={{ borderColor: 'var(--line)' }}
      >
        <Link href="/admin" className="flex items-center gap-2">
          <AiagLogo height={22} animated />
          <span
            className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded"
            style={{ background: 'rgba(245,158,11,0.15)', color: 'var(--accent)' }}
          >
            ADMIN
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
                  'flex items-center justify-between px-3 py-1.5 mt-3 rounded',
                  'hover:bg-white/[0.03] transition-colors cursor-pointer select-none'
                )}
              >
                <span className="flex items-center gap-2">
                  <span
                    className="w-1 h-1 rounded-full"
                    style={{
                      background: 'var(--accent)',
                      opacity: hasActive && isCollapsed ? 0.9 : 0.4,
                    }}
                  />
                  <span
                    className={cn(
                      'text-[10px] uppercase tracking-[0.12em] font-semibold',
                      hasActive && isCollapsed ? 'text-[var(--accent)] opacity-100' : 'opacity-40'
                    )}
                  >
                    {section.heading}
                  </span>
                </span>
                <ChevronDown
                  className={cn(
                    'h-3 w-3 transition-transform duration-150 opacity-40',
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
                          'flex items-center gap-3 px-3 py-2 text-[13px] rounded-sm transition-all relative',
                          'hover:bg-white/[0.03] hover:translate-x-0.5',
                          active
                            ? 'bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] text-[var(--ink)] before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2 before:w-[2px] before:h-5 before:bg-[var(--accent)] before:rounded-r-full'
                            : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
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
    </>
  );

  return (
    <>
      {/* Mobile hamburger — visible < lg */}
      <button
        type="button"
        aria-label="Открыть admin-меню"
        onClick={() => setMobileOpen(true)}
        className="lg:hidden fixed top-3 left-3 z-40 p-2 rounded-md border bg-[var(--bg-elev)] hover:bg-white/[0.04]"
        style={{ borderColor: 'var(--line)' }}
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Desktop static sidebar */}
      <aside
        className="aiag-grid-bg-sm hidden lg:flex shrink-0 w-60 border-r flex-col"
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
          aria-label="Admin навигация"
        >
          <div
            className="absolute inset-0 bg-black/70 aiag-drawer-overlay"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
          <aside
            className="aiag-grid-bg-sm aiag-drawer-panel-enter absolute inset-y-0 left-0 w-72 border-r flex flex-col"
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
