'use client';

import { useEffect, useState, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import {
  Home,
  Boxes,
  Settings,
  Users,
  Building,
  Activity,
  CreditCard,
  Key,
  BarChart,
  Webhook,
  Shield,
  Code,
  Play,
  Receipt,
  GitBranch,
  Globe,
  FileText,
  Search,
  ArrowRight,
  type LucideIcon,
} from 'lucide-react';

interface Command {
  id: string;
  label: string;
  description?: string;
  icon: LucideIcon;
  href?: string;
  onSelect?: () => void;
  /** Группа для секционирования */
  group: 'navigation' | 'admin' | 'account' | 'actions' | 'docs';
  /** Дополнительные ключевые слова для search */
  keywords?: string[];
}

const COMMANDS: Command[] = [
  // Navigation
  { id: 'home', label: 'Главная', icon: Home, href: '/', group: 'navigation', keywords: ['домой'] },
  { id: 'marketplace', label: 'Маркетплейс моделей', icon: Boxes, href: '/marketplace', group: 'navigation', keywords: ['модели', 'каталог'] },
  { id: 'playground', label: 'Песочница', icon: Play, href: '/playground', group: 'navigation' },
  { id: 'pricing', label: 'Тарифы', icon: CreditCard, href: '/pricing', group: 'navigation', keywords: ['цены'] },
  { id: 'docs', label: 'Документация', icon: FileText, href: '/docs', group: 'docs' },
  // 'business' (/business) HIDDEN 2026-07-17 — see MainNavbar.tsx.

  // Account
  { id: 'dashboard', label: 'Личный кабинет', icon: Activity, href: '/dashboard', group: 'account' },
  { id: 'keys', label: 'API-ключи', icon: Key, href: '/dashboard/keys', group: 'account' },
  { id: 'billing', label: 'Биллинг', icon: Receipt, href: '/dashboard/billing', group: 'account', keywords: ['оплата'] },
  { id: 'earnings', label: 'Заработок', icon: BarChart, href: '/dashboard/earnings', group: 'account' },
  { id: 'models-mine', label: 'Мои модели', icon: Boxes, href: '/dashboard/models', group: 'account' },
  { id: 'webhooks', label: 'Webhooks', icon: Webhook, href: '/dashboard/webhooks', group: 'account' },
  { id: 'security', label: 'Безопасность', icon: Shield, href: '/dashboard/security', group: 'account' },

  // Admin
  { id: 'admin', label: 'Admin Dashboard', icon: Activity, href: '/admin', group: 'admin' },
  { id: 'admin-users', label: 'Пользователи (admin)', icon: Users, href: '/admin/users', group: 'admin' },
  { id: 'admin-orgs', label: 'Организации', icon: Building, href: '/admin/orgs', group: 'admin' },
  { id: 'admin-models', label: 'Модели (admin)', icon: Boxes, href: '/admin/models', group: 'admin' },
  { id: 'admin-jobs', label: 'Async-задачи', icon: GitBranch, href: '/admin/jobs', group: 'admin', keywords: ['queue', 'очередь'] },
  { id: 'admin-worker', label: 'Worker статус', icon: Activity, href: '/admin/worker', group: 'admin' },
  { id: 'admin-routing', label: 'Роутинг', icon: GitBranch, href: '/admin/routing', group: 'admin' },
  { id: 'admin-upstreams', label: 'Аплинки', icon: Globe, href: '/admin/upstreams', group: 'admin', keywords: ['провайдеры'] },
  { id: 'admin-requests', label: 'Запросы', icon: Code, href: '/admin/requests', group: 'admin' },
  { id: 'admin-kyc', label: 'KYC очередь', icon: Shield, href: '/admin/kyc-queue', group: 'admin' },
  { id: 'admin-payments', label: 'Платежи (admin)', icon: CreditCard, href: '/admin/payments', group: 'admin' },
  { id: 'admin-payouts', label: 'Выплаты (admin)', icon: CreditCard, href: '/admin/payouts', group: 'admin' },
  { id: 'admin-promos', label: 'Промокоды', icon: Receipt, href: '/admin/promos', group: 'admin' },
  { id: 'admin-settings', label: 'Настройки (admin)', icon: Settings, href: '/admin/settings', group: 'admin' },

  // Actions (quick create / external)
  { id: 'new-model', label: 'Создать модель', icon: Boxes, href: '/dashboard/models/new', group: 'actions' },
];

const GROUP_LABELS: Record<Command['group'], string> = {
  navigation: 'Навигация',
  account: 'Аккаунт',
  admin: 'Админ',
  actions: 'Создать',
  docs: 'Документы',
};

function score(cmd: Command, query: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const label = cmd.label.toLowerCase();
  const desc = (cmd.description ?? '').toLowerCase();
  const kw = (cmd.keywords ?? []).join(' ').toLowerCase();

  if (label.startsWith(q)) return 100;
  if (label.includes(q)) return 80;
  if (desc.includes(q)) return 50;
  if (kw.includes(q)) return 40;

  // Fuzzy: каждая буква query содержится по порядку?
  let qi = 0;
  for (const c of label) {
    if (c === q[qi]) qi++;
    if (qi === q.length) return 20;
  }
  return 0;
}

export function CommandPalette() {
  const router = useRouter();
  const { data: session } = useSession();
  // Admin routes must not be discoverable by non-admins (UI = reality). Server
  // guards already block access; this stops the palette leaking the admin map.
  // Defaults to hidden while the session is still loading.
  const isAdmin =
    (session?.user as { role?: string } | undefined)?.role === 'admin';
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const visible = COMMANDS.filter((c) => isAdmin || c.group !== 'admin');
    return visible
      .map((c) => ({ cmd: c, s: score(c, query) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.cmd)
      .slice(0, 30);
  }, [query, isAdmin]);

  // Group filtered list
  const grouped = useMemo(() => {
    const map = new Map<Command['group'], Command[]>();
    for (const c of filtered) {
      if (!map.has(c.group)) map.set(c.group, []);
      map.get(c.group)!.push(c);
    }
    return Array.from(map.entries());
  }, [filtered]);

  // Keyboard shortcut
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isMac = navigator.platform.toLowerCase().includes('mac');
      const cmdOrCtrl = isMac ? e.metaKey : e.ctrlKey;
      if (cmdOrCtrl && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      if (!open) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, filtered.length - 1));
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = filtered[active];
        if (cmd) runCommand(cmd);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active, filtered]);

  // External open trigger (e.g. navbar button)
  useEffect(() => {
    function onOpen() {
      setOpen(true);
    }
    window.addEventListener('aiag-command-palette-open', onOpen);
    return () => window.removeEventListener('aiag-command-palette-open', onOpen);
  }, []);

  // Focus input on open + lock scroll
  useEffect(() => {
    if (!open) return;
    setTimeout(() => inputRef.current?.focus(), 10);
    setQuery('');
    setActive(0);
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  function runCommand(cmd: Command) {
    setOpen(false);
    if (cmd.onSelect) cmd.onSelect();
    else if (cmd.href) router.push(cmd.href);
  }

  if (!open) return null;

  let flatIdx = -1;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center pt-[10vh] px-4"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="absolute inset-0 bg-black/70 aiag-drawer-overlay"
        onClick={() => setOpen(false)}
      />
      <div
        className="relative w-full max-w-xl rounded-xl border shadow-2xl overflow-hidden aiag-grid-bg-sm"
        style={{ background: 'var(--bg-elev)', borderColor: 'var(--line)' }}
      >
        {/* Search */}
        <div
          className="flex items-center gap-3 px-4 py-3 border-b"
          style={{ borderColor: 'var(--line)' }}
        >
          <Search className="w-4 h-4 opacity-50" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            placeholder="Поиск страниц и действий…"
            className="flex-1 bg-transparent border-none outline-none text-sm"
          />
          <kbd
            className="text-[10px] font-mono px-1.5 py-0.5 rounded border opacity-60"
            style={{ borderColor: 'var(--line)' }}
          >
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-[60vh] overflow-y-auto py-2">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm opacity-50">
              Ничего не найдено
            </div>
          ) : (
            grouped.map(([group, cmds]) => (
              <div key={group} className="mb-2">
                <div className="px-4 py-1 text-[10px] uppercase tracking-[0.12em] opacity-40 font-semibold">
                  {GROUP_LABELS[group]}
                </div>
                {cmds.map((c) => {
                  flatIdx++;
                  const isActive = flatIdx === active;
                  const Icon = c.icon;
                  const currentIdx = flatIdx;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onMouseEnter={() => setActive(currentIdx)}
                      onClick={() => runCommand(c)}
                      className={`w-full flex items-center gap-3 px-4 py-2 text-left text-sm transition-colors ${
                        isActive
                          ? 'bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]'
                          : ''
                      }`}
                    >
                      <Icon className="w-4 h-4 opacity-70" />
                      <span className="flex-1">{c.label}</span>
                      {isActive && <ArrowRight className="w-3.5 h-3.5 opacity-60" />}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div
          className="border-t px-4 py-2 flex items-center justify-between text-[11px] opacity-50"
          style={{ borderColor: 'var(--line)' }}
        >
          <span>↑↓ навигация · Enter — открыть</span>
          <span>⌘K / Ctrl+K — открыть/закрыть</span>
        </div>
      </div>
    </div>
  );
}
