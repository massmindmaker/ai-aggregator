# Dashboard IA Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace MOCK `/dashboard` and auth-blind header with a coherent IA — single `/dashboard` with mode switcher (User/Author/Participant), session-aware MainNavbar with avatar dropdown, real DB-backed overview, auth-aware `/pricing` CTAs, and 308 redirects from legacy paths.

**Architecture:** Layout-level auth gates (no middleware in v1). Mode resolved server-side from `?mode=` query → path-family fallback → default `user`. Mode chip click navigates to `/dashboard?mode=X` (overview, not sibling). Empty-state contract per overview tile so zero-data renders cleanly. `users.id` lookup, not email. `permanentRedirect()` (308) for legacy paths.

**Tech Stack:** Next.js 15 App Router, React Server Components, NextAuth v5, Drizzle ORM, Postgres, Tailwind. No new deps.

**Spec:** `docs/superpowers/specs/2026-05-10-dashboard-ia-redesign-design.md`

**Verification strategy:** Per project memory `feedback_no_local_runtime` — never spin up local dev or unit tests for the web app. Verify each task by:
1. `bun run --cwd apps/web type-check` after touching any TS/TSX (catches typos, signature drift, schema mismatches).
2. After ALL waves committed: deploy + smoke from `§12 Verification` of the spec.

Each task ends in a commit. Build pipeline + post-deploy smoke is the integration test suite.

---

## File map

**Create:**
- `apps/web/src/lib/dashboard/mode.ts` — pure mode resolver (Task 1)
- `apps/web/src/components/UserMenu.tsx` — client avatar dropdown (Task 2)
- `apps/web/src/components/dashboard/DashboardSidebar.tsx` — sidebar + mode chips (Task 4)
- `apps/web/src/app/dashboard/layout.tsx` — auth gate + chrome (Task 5)
- `apps/web/src/lib/dashboard/overview.ts` — `fetchOverview` query helper (Task 6)
- `apps/web/src/app/dashboard/profile/page.tsx` — stub (Task 10)
- `apps/web/src/app/dashboard/security/page.tsx` — stub (Task 10)
- `apps/web/src/app/dashboard/wins/page.tsx` — stub (Task 10)
- `apps/web/src/app/dashboard/kyc/page.tsx` — stub (Task 10)

**Modify:**
- `apps/web/src/components/layout/MainNavbar.tsx` — split server wrapper + client menu (Task 3)
- `apps/web/src/app/dashboard/page.tsx` — replace MOCK with server queries (Task 7)
- `apps/web/src/app/pricing/page.tsx` — server wrapper + auth-aware CTAs (Task 8)
- `apps/web/src/app/me/submit-model/page.tsx` — replace body with `permanentRedirect()` (Task 9)

**Delete:** None (preserve existing routes; migrations are 308 redirects).

---

## Task 1: Mode resolver utility

**Files:**
- Create: `apps/web/src/lib/dashboard/mode.ts`

- [ ] **Step 1: Write the module**

```ts
// apps/web/src/lib/dashboard/mode.ts
//
// Pure mode resolution: ?mode= query > path-family fallback > 'user'.
// Used by the dashboard layout (server) to pick the active sidebar tab and
// by the sidebar (client) to highlight the active chip. Keeping it free of
// React / Next imports so it's trivially testable and reusable.

export type Mode = 'user' | 'author' | 'participant';

export const MODES: readonly Mode[] = ['user', 'author', 'participant'] as const;

const AUTHOR_PREFIXES = ['/dashboard/models', '/dashboard/earnings', '/dashboard/payouts', '/dashboard/kyc'];
const PARTICIPANT_PREFIXES = ['/dashboard/submissions', '/dashboard/wins'];

export function inferModeFromPath(pathname: string): Mode {
  if (AUTHOR_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'))) return 'author';
  if (PARTICIPANT_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'))) return 'participant';
  return 'user';
}

export function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value);
}

/** Resolve the active mode given query + path. Query wins over path. */
export function resolveMode(query: string | string[] | undefined, pathname: string): Mode {
  const q = Array.isArray(query) ? query[0] : query;
  if (isMode(q)) return q;
  return inferModeFromPath(pathname);
}
```

- [ ] **Step 2: Type-check**

```bash
bun run --cwd apps/web type-check
```

Expected: `tsc --noEmit` returns 0. If errors, fix before commit.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/dashboard/mode.ts
git commit -m "feat(dashboard): add mode resolver utility (query > path > user)"
```

---

## Task 2: UserMenu client component

**Files:**
- Create: `apps/web/src/components/UserMenu.tsx`

- [ ] **Step 1: Write the component**

```tsx
// apps/web/src/components/UserMenu.tsx
'use client';

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { signOut } from 'next-auth/react';
import { LayoutDashboard, User, Shield, LogOut, ChevronDown } from 'lucide-react';

interface Props {
  name: string | null;
  email: string;
  image: string | null;
  isAdmin: boolean;
}

function initials(name: string | null, email: string): string {
  const src = (name || email).trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function UserMenu({ name, email, image, isAdmin }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  const display = name || email.split('@')[0];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 px-3 py-2 text-[13px] font-medium rounded-[2px] border border-[var(--line)] hover:bg-white/[0.04] transition-colors"
      >
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image} alt="" className="h-6 w-6 rounded-full" />
        ) : (
          <span className="h-6 w-6 rounded-full bg-[var(--accent)] text-black font-bold text-[11px] inline-flex items-center justify-center">
            {initials(name, email)}
          </span>
        )}
        <span className="hidden md:inline truncate max-w-[140px]">{display}</span>
        <ChevronDown className="h-3.5 w-3.5 opacity-60" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-56 border rounded-md shadow-lg z-50 overflow-hidden"
          style={{ background: 'var(--bg-elev)', borderColor: 'var(--line)' }}
        >
          <Link
            href="/dashboard"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-white/[0.04]"
          >
            <LayoutDashboard className="h-4 w-4" /> Перейти в Dashboard
          </Link>
          <Link
            href="/dashboard/profile"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-white/[0.04]"
          >
            <User className="h-4 w-4" /> Профиль
          </Link>
          {isAdmin && (
            <Link
              href="/admin"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 px-3 py-2 text-[13px] text-[var(--accent)] hover:bg-white/[0.04]"
            >
              <Shield className="h-4 w-4" /> Админка
            </Link>
          )}
          <button
            type="button"
            onClick={() => signOut({ callbackUrl: '/' })}
            className="w-full text-left flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-white/[0.04] border-t"
            style={{ borderColor: 'var(--line)' }}
          >
            <LogOut className="h-4 w-4" /> Выйти
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
bun run --cwd apps/web type-check
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/UserMenu.tsx
git commit -m "feat(ui): add UserMenu — avatar dropdown with admin link + signOut"
```

---

## Task 3: MainNavbar — session-aware

**Files:**
- Modify: `apps/web/src/components/layout/MainNavbar.tsx`

The current file is `'use client'` and renders «Войти / Регистрация» unconditionally. We split into a server outer that calls `auth()` + a thin client inner for the existing mobile drawer.

- [ ] **Step 1: Replace MainNavbar.tsx with server+client split**

```tsx
// apps/web/src/components/layout/MainNavbar.tsx
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
    const me = await db.query.users.findFirst({
      where: eq(users.id, session.user.id),
      columns: { role: true },
    });
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
    <div className="hidden lg:flex items-center gap-2.5">
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
        style={{ background: 'var(--accent)', color: '#000', borderColor: 'var(--accent)' }}
      >
        Регистрация
      </Link>
    </div>
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
```

- [ ] **Step 2: Create the mobile drawer client subcomponent**

Create new file `apps/web/src/components/layout/MainNavbarMobile.tsx`:

```tsx
// apps/web/src/components/layout/MainNavbarMobile.tsx
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { signOut } from 'next-auth/react';
import { Menu, X, LogOut, LayoutDashboard, Shield, User as UserIcon } from 'lucide-react';

interface Props {
  menu: { title: string; href: string }[];
  loggedIn: boolean;
  name: string | null;
  email: string;
  isAdmin: boolean;
}

export default function MainNavbarMobile({ menu, loggedIn, name, email, isAdmin }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        aria-label="Открыть меню"
        className="lg:hidden p-2 rounded-md hover:bg-white/[0.04] transition-colors"
        onClick={() => setOpen(true)}
      >
        <Menu className="h-5 w-5" />
      </button>

      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/70" onClick={() => setOpen(false)} />
          <aside
            className="absolute inset-y-0 end-0 w-72 border-s shadow-xl flex flex-col"
            style={{ background: 'var(--bg-elev)', borderColor: 'var(--line)' }}
          >
            <div className="flex items-center justify-between p-4 border-b" style={{ borderColor: 'var(--line)' }}>
              <span className="font-mono font-bold text-sm">
                ai<span style={{ color: 'var(--accent)' }}>-</span>aggregator
              </span>
              <button type="button" aria-label="Закрыть меню" className="p-2 rounded-md hover:bg-white/[0.04]" onClick={() => setOpen(false)}>
                <X className="h-5 w-5" />
              </button>
            </div>
            <ul className="flex flex-col p-2 flex-1">
              {menu.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} onClick={() => setOpen(false)} className="block px-4 py-3 text-sm hover:bg-white/[0.04] rounded">
                    {item.title}
                  </Link>
                </li>
              ))}
            </ul>
            <div className="p-4 border-t flex flex-col gap-2" style={{ borderColor: 'var(--line)' }}>
              {loggedIn ? (
                <>
                  <div className="px-1 pb-2 text-xs text-muted-foreground truncate">{name || email}</div>
                  <Link href="/dashboard" onClick={() => setOpen(false)} className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-[2px] border" style={{ borderColor: 'var(--line)' }}>
                    <LayoutDashboard className="h-4 w-4" /> Dashboard
                  </Link>
                  <Link href="/dashboard/profile" onClick={() => setOpen(false)} className="inline-flex items-center gap-2 px-4 py-2.5 text-sm rounded-[2px] border" style={{ borderColor: 'var(--line)' }}>
                    <UserIcon className="h-4 w-4" /> Профиль
                  </Link>
                  {isAdmin && (
                    <Link href="/admin" onClick={() => setOpen(false)} className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-[2px] border" style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}>
                      <Shield className="h-4 w-4" /> Админка
                    </Link>
                  )}
                  <button type="button" onClick={() => signOut({ callbackUrl: '/' })} className="inline-flex items-center gap-2 px-4 py-2.5 text-sm rounded-[2px] border text-left" style={{ borderColor: 'var(--line)' }}>
                    <LogOut className="h-4 w-4" /> Выйти
                  </button>
                </>
              ) : (
                <>
                  <Link href="/login" onClick={() => setOpen(false)} className="inline-flex justify-center items-center px-4 py-2.5 text-sm font-semibold rounded-[2px] border" style={{ borderColor: 'var(--line)' }}>
                    Войти
                  </Link>
                  <Link href="/register" onClick={() => setOpen(false)} className="inline-flex justify-center items-center px-4 py-2.5 text-sm font-semibold rounded-[2px]" style={{ background: 'var(--accent)', color: '#000' }}>
                    Регистрация
                  </Link>
                </>
              )}
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 3: Type-check**

```bash
bun run --cwd apps/web type-check
```

Expected: 0 errors. If `auth()` import fails on a client component anywhere, that's a sign the import boundary is wrong — fix before continuing.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/layout/MainNavbar.tsx apps/web/src/components/layout/MainNavbarMobile.tsx
git commit -m "feat(nav): session-aware MainNavbar with avatar dropdown + mobile drawer parity"
```

---

## Task 4: DashboardSidebar component

**Files:**
- Create: `apps/web/src/components/dashboard/DashboardSidebar.tsx`

- [ ] **Step 1: Write the component**

```tsx
// apps/web/src/components/dashboard/DashboardSidebar.tsx
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
    case 'author': return ITEMS_AUTHOR;
    case 'participant': return ITEMS_PARTICIPANT;
    case 'user':
    default: return ITEMS_USER;
  }
}

export default function DashboardSidebar({ isAdmin }: Props) {
  const pathname = usePathname() ?? '/dashboard';
  const searchParams = useSearchParams();
  const mode = resolveMode(searchParams.get('mode') ?? undefined, pathname);

  return (
    <aside className="w-60 shrink-0 border-r" style={{ borderColor: 'var(--line)', background: 'var(--bg-elev)' }}>
      <div className="p-4 flex flex-col gap-1">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Режим</div>
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
          const active = item.exact
            ? pathname === '/dashboard' || pathname === item.href.split('?')[0]
            : pathname === item.href || pathname.startsWith(item.href + '/');
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-2 px-3 py-2 text-[13px] rounded transition-colors',
                active ? 'bg-white/[0.06] text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-white/[0.04]'
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
                active ? 'bg-white/[0.06] text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-white/[0.04]'
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
```

- [ ] **Step 2: Type-check**

```bash
bun run --cwd apps/web type-check
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/dashboard/DashboardSidebar.tsx
git commit -m "feat(dashboard): DashboardSidebar with mode chips, dynamic items, admin link"
```

---

## Task 5: Dashboard layout (auth gate + chrome)

**Files:**
- Create: `apps/web/src/app/dashboard/layout.tsx`

- [ ] **Step 1: Write the layout**

```tsx
// apps/web/src/app/dashboard/layout.tsx
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { users } from '@aiag/database/schema';
import { eq } from '@aiag/database';
import DashboardSidebar from '@/components/dashboard/DashboardSidebar';
import MainNavbar from '@/components/layout/MainNavbar';

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user?.id) {
    // No middleware in v1: we can't capture the original pathname here without
    // injecting x-pathname in middleware. Always-/dashboard post-login is the
    // documented v1 trade-off (see spec §8).
    redirect('/login?callbackUrl=/dashboard');
  }

  const me = await db.query.users.findFirst({
    where: eq(users.id, session.user.id),
    columns: { role: true },
  });
  const isAdmin = me?.role === 'admin';

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <MainNavbar />
      <div className="flex-1 flex">
        <DashboardSidebar isAdmin={isAdmin} />
        <main className="flex-1 min-w-0 overflow-x-hidden">{children}</main>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
bun run --cwd apps/web type-check
```

If `db.query.users` complains about column types or relations not being configured, fall back to `db.execute(sql\`SELECT role FROM users WHERE id = ${session.user.id}::uuid LIMIT 1\`)` and parse rows — this is the pattern other admin routes use.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/dashboard/layout.tsx
git commit -m "feat(dashboard): layout with auth gate, sidebar, MainNavbar header"
```

---

## Task 6: Overview query helper

**Files:**
- Create: `apps/web/src/lib/dashboard/overview.ts`

- [ ] **Step 1: Write the helper**

```ts
// apps/web/src/lib/dashboard/overview.ts
import { db, sql } from '@/lib/db';
import type { Mode } from '@/lib/dashboard/mode';

export interface OverviewTile {
  label: string;
  value: string;
  sublabel?: string;
  href?: string;
  cta?: string;
}

export interface RecentCall {
  id: string;
  created_at: string;
  model: string | null;
  endpoint: string | null;
  tokens: number | null;
  status: string | null;
}

export interface Overview {
  tiles: OverviewTile[];
  recent: RecentCall[];
  planName: string;
}

interface CountRow { c: string }
interface SubRow { plan_name: string | null; credits_limit: string | null; credits_used: string | null }

async function fetchCount(query: ReturnType<typeof sql>): Promise<number> {
  const r = await db.execute(query);
  const rows = ((r as unknown as { rows?: unknown[] }).rows ?? r) as CountRow[];
  return rows[0] ? Number(rows[0].c) : 0;
}

export async function fetchOverview(userId: string, mode: Mode): Promise<Overview> {
  // Subscription / plan — LEFT JOIN, may be null.
  // The schema for credits/usage may vary; we coalesce defensively.
  const subRes = await db.execute(sql`
    SELECT
      COALESCE(s.plan_name, 'Free') AS plan_name,
      s.credits_limit::text AS credits_limit,
      s.credits_used::text AS credits_used
    FROM users u
    LEFT JOIN subscriptions s ON s.user_id = u.id AND s.status = 'active'
    WHERE u.id = ${userId}::uuid
    LIMIT 1
  `);
  const sub = (((subRes as unknown as { rows?: unknown[] }).rows ?? subRes) as SubRow[])[0]
    ?? { plan_name: 'Free', credits_limit: null, credits_used: null };

  // API calls this month — gateway_requests (table name may differ; adapt if needed).
  const apiCalls = await fetchCount(sql`
    SELECT count(*)::text AS c
    FROM gateway_requests
    WHERE user_id = ${userId}::uuid
      AND created_at >= date_trunc('month', NOW())
  `).catch(() => 0);

  const myModelsLive = await fetchCount(sql`
    SELECT count(*)::text AS c FROM models
    WHERE author_user_id = ${userId}::uuid AND status = 'live'
  `);

  const mySubmissions = await fetchCount(sql`
    SELECT count(*)::text AS c FROM contest_submissions
    WHERE user_id = ${userId}::uuid
  `).catch(() => 0);

  const myWins = await fetchCount(sql`
    SELECT count(*)::text AS c FROM prize_awards
    WHERE user_id = ${userId}::uuid
  `).catch(() => 0);

  const recentRes = await db.execute(sql`
    SELECT id::text, created_at::text, model, endpoint, tokens, status
    FROM gateway_requests
    WHERE user_id = ${userId}::uuid
    ORDER BY created_at DESC
    LIMIT 5
  `).catch(() => ({ rows: [] }));
  const recent = (((recentRes as unknown as { rows?: unknown[] }).rows ?? recentRes) as RecentCall[]);

  const planName = sub.plan_name ?? 'Free';
  const limit = sub.credits_limit ? Number(sub.credits_limit) : null;
  const used = sub.credits_used ? Number(sub.credits_used) : 0;

  let tiles: OverviewTile[];
  if (mode === 'author') {
    tiles = [
      { label: 'Заработок (мес)', value: '— ₽', sublabel: 'появится после первой выплаты' },
      { label: 'Вызовы моих моделей', value: '—', sublabel: 'появится после live-модели' },
      {
        label: 'Опубликовано',
        value: String(myModelsLive),
        sublabel: myModelsLive === 0 ? 'нет live-моделей' : undefined,
        cta: myModelsLive === 0 ? 'Загрузить модель' : undefined,
        href: myModelsLive === 0 ? '/dashboard/models/new' : '/dashboard/models',
      },
      { label: 'Тариф', value: planName },
    ];
  } else if (mode === 'participant') {
    tiles = [
      { label: 'Активные конкурсы', value: '—', sublabel: 'обновится после участия' },
      {
        label: 'Мои сабмишены',
        value: String(mySubmissions),
        href: mySubmissions === 0 ? '/contests' : '/dashboard/submissions',
        cta: mySubmissions === 0 ? 'Найти конкурс' : undefined,
      },
      { label: 'Победы', value: String(myWins) },
      { label: 'Тариф', value: planName },
    ];
  } else {
    tiles = [
      {
        label: 'Кредиты',
        value: limit != null ? `${used} / ${limit}` : `${used}`,
        sublabel: limit != null ? 'в этом месяце' : 'нет тарифа',
      },
      {
        label: 'API-вызовы',
        value: String(apiCalls),
        sublabel: 'за этот месяц',
      },
      {
        label: 'Активные модели',
        value: '—',
        sublabel: 'модели вы используете',
      },
      { label: 'Тариф', value: planName },
    ];
  }

  return { tiles, recent, planName };
}
```

- [ ] **Step 2: Type-check**

```bash
bun run --cwd apps/web type-check
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/dashboard/overview.ts
git commit -m "feat(dashboard): fetchOverview helper with empty-state-safe queries"
```

---

## Task 7: Dashboard overview page (replace MOCK)

**Files:**
- Modify: `apps/web/src/app/dashboard/page.tsx` (full rewrite)

- [ ] **Step 1: Replace contents**

```tsx
// apps/web/src/app/dashboard/page.tsx
import Link from 'next/link';
import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { resolveMode } from '@/lib/dashboard/mode';
import { fetchOverview } from '@/lib/dashboard/overview';
import { Card, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';

export const dynamic = 'force-dynamic';

interface SearchParams { mode?: string }

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await auth();
  // Layout already gates, but be defensive: in case this page is rendered
  // outside the layout in any tooling, redirect rather than crash.
  if (!session?.user?.id) redirect('/login?callbackUrl=/dashboard');

  const params = await searchParams;
  const mode = resolveMode(params.mode, '/dashboard');
  const data = await fetchOverview(session.user.id, mode);

  return (
    <section className="container mx-auto max-w-7xl px-6 py-10">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Личный кабинет</h1>
          <p className="mt-1 text-muted-foreground text-sm">
            Обзор расходов, баланса и последних запросов
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/dashboard/keys"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-[13px] rounded-md border hover:bg-white/[0.04]"
            style={{ borderColor: 'var(--line)' }}
          >
            🔑 API-ключи
          </Link>
          <Link
            href="/dashboard/billing"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-[13px] rounded-md font-semibold"
            style={{ background: 'var(--accent)', color: '#000' }}
          >
            + Пополнить
          </Link>
        </div>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {data.tiles.map((t, i) => (
          <Card key={i}>
            <CardContent className="p-5 flex flex-col gap-1.5">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">{t.label}</div>
              <div className="text-3xl font-bold tabular-nums">{t.value}</div>
              {t.sublabel && (
                <div className="text-xs text-muted-foreground">{t.sublabel}</div>
              )}
              {t.cta && t.href && (
                <Link href={t.href} className="text-xs text-[var(--accent)] mt-1 hover:underline">
                  {t.cta} →
                </Link>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: 'var(--line)' }}>
            <h2 className="text-lg font-semibold">Последние API-вызовы</h2>
          </div>
          {data.recent.length === 0 ? (
            <div className="px-5 py-12 text-center text-sm text-muted-foreground">
              Здесь появятся ваши API-вызовы.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-muted-foreground bg-muted/30">
                <tr>
                  <th className="px-5 py-3 text-left">Время</th>
                  <th className="px-5 py-3 text-left">Модель</th>
                  <th className="px-5 py-3 text-left">Endpoint</th>
                  <th className="px-5 py-3 text-right">Токены</th>
                  <th className="px-5 py-3 text-left">Статус</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((r) => (
                  <tr key={r.id} className="border-t" style={{ borderColor: 'var(--line)' }}>
                    <td className="px-5 py-3 whitespace-nowrap font-mono text-xs text-muted-foreground">
                      {r.created_at?.slice(0, 19).replace('T', ' ') ?? ''}
                    </td>
                    <td className="px-5 py-3 font-mono text-xs">{r.model ?? '—'}</td>
                    <td className="px-5 py-3 font-mono text-xs text-muted-foreground">{r.endpoint ?? '—'}</td>
                    <td className="px-5 py-3 text-right tabular-nums">{r.tokens ?? '—'}</td>
                    <td className="px-5 py-3">
                      <Badge variant={r.status === 'success' || r.status === 'ok' ? 'success' as never : 'destructive' as never}>
                        {r.status ?? '—'}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
bun run --cwd apps/web type-check
```

If `gateway_requests` table doesn't actually exist (the helper has `.catch(() => 0)`), the tile shows `0`. That's the contract — the tile must not throw.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/dashboard/page.tsx
git commit -m "feat(dashboard): server overview with real DB queries — drops 750/1200 MOCK"
```

---

## Task 8: Pricing — auth-aware CTAs

**Files:**
- Move: existing `apps/web/src/app/pricing/page.tsx` → `apps/web/src/app/pricing/PricingClient.tsx`
- Create new: `apps/web/src/app/pricing/page.tsx` (server wrapper)

The current file is `'use client'`. We split it into a server outer that reads session + current plan, and a client inner that takes derived CTAs as a prop.

- [ ] **Step 1: Read current file structure**

```bash
wc -l apps/web/src/app/pricing/page.tsx
sed -n '1,80p' apps/web/src/app/pricing/page.tsx
```

Expected output: `'use client'` directive at line 1, a `Tier` interface, a `tiers: Tier[]` array, and a default export that maps tiers and renders `<Link href={tier.ctaHref}>...</Link>`. Note the existing `Tier` shape exactly — the new wrapper must re-use it.

- [ ] **Step 2a: Move existing file to PricingClient.tsx (rename only)**

```bash
git mv apps/web/src/app/pricing/page.tsx apps/web/src/app/pricing/PricingClient.tsx
```

Then in `PricingClient.tsx`:
- Rename the default export from `PricingPage` (or whatever it is) to `PricingClient`. Keep `'use client'` directive.
- Add a `Props` interface and accept `{ session, currentPlanId }` from the server wrapper:

```tsx
interface PricingClientProps {
  isLoggedIn: boolean;
  currentPlanId: string | null;
}

export default function PricingClient({ isLoggedIn, currentPlanId }: PricingClientProps) {
  // …existing body…
}
```

- Replace the existing `tier.ctaHref` reads with a derivation. At the top of the component (above the JSX) add:

```ts
function ctaForTier(tier: Tier): { label: string; href: string | null } {
  if (tier.isContact) return { label: 'Связаться', href: '/business?topic=enterprise' };
  if (!isLoggedIn) {
    return {
      label: 'Зарегистрироваться',
      href: `/register?callbackUrl=${encodeURIComponent('/pricing')}`,
    };
  }
  if (currentPlanId === tier.id) return { label: 'Текущий тариф', href: null };
  const verb = tier.id === 'free' ? 'Перейти на Free' : `Сменить на ${tier.name}`;
  return { label: verb, href: `/dashboard/billing?upgrade=${tier.id}` };
}
```

- In the JSX where the tier card renders its CTA, replace `<Link href={tier.ctaHref}>{tier.cta}</Link>` (or the equivalent button) with:

```tsx
{(() => {
  const cta = ctaForTier(tier);
  if (!cta.href) {
    return (
      <Button disabled className="w-full opacity-60 cursor-default">
        {cta.label}
      </Button>
    );
  }
  return (
    <Link href={cta.href}>
      <Button className="w-full">{cta.label}</Button>
    </Link>
  );
})()}
```

Make sure this edit covers BOTH spots if the tier card is rendered twice (header CTA and footer CTA in the same tier).

- [ ] **Step 2b: Create new page.tsx server wrapper**

```tsx
// apps/web/src/app/pricing/page.tsx
import { auth } from '@/auth';
import { db, sql } from '@/lib/db';
import PricingClient from './PricingClient';

export const dynamic = 'force-dynamic';

interface PlanRow { plan_name: string | null }

async function currentPlanId(userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  const r = await db.execute(sql`
    SELECT plan_name FROM subscriptions
    WHERE user_id = ${userId}::uuid AND status = 'active'
    ORDER BY created_at DESC LIMIT 1
  `).catch(() => ({ rows: [] }));
  const rows = (((r as unknown as { rows?: unknown[] }).rows ?? r) as PlanRow[]);
  return rows[0]?.plan_name ?? null;
}

export default async function PricingPage() {
  const session = await auth();
  const planId = await currentPlanId(session?.user?.id);
  return <PricingClient isLoggedIn={Boolean(session?.user)} currentPlanId={planId} />;
}
```

- [ ] **Step 2c: Verify both files**

```bash
ls apps/web/src/app/pricing/
# Expected: page.tsx (server) + PricingClient.tsx (client)
head -3 apps/web/src/app/pricing/PricingClient.tsx
# First non-empty line MUST be: 'use client';
head -3 apps/web/src/app/pricing/page.tsx
# First non-empty line should be: import { auth } from '@/auth'; (server, no 'use client')
```

```tsx
// apps/web/src/app/pricing/page.tsx
import { auth } from '@/auth';
import { db, sql } from '@/lib/db';
import PricingClient from './PricingClient';

export const dynamic = 'force-dynamic';

interface PlanRow { plan_name: string | null }

async function currentPlanId(userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  const r = await db.execute(sql`
    SELECT plan_name FROM subscriptions
    WHERE user_id = ${userId}::uuid AND status = 'active'
    ORDER BY created_at DESC LIMIT 1
  `).catch(() => ({ rows: [] }));
  const rows = (((r as unknown as { rows?: unknown[] }).rows ?? r) as PlanRow[]);
  return rows[0]?.plan_name ?? null;
}

export interface DerivedCta {
  label: string;
  href: string | null; // null → disabled
}

export default async function PricingPage() {
  const session = await auth();
  const plan = await currentPlanId(session?.user?.id);
  return <PricingClient session={session} currentPlanId={plan} />;
}
```

`PricingClient.tsx` is the existing client component renamed. Inside it, replace per-tier `ctaHref` lookup with:

```ts
function ctaForTier(tier: Tier, loggedIn: boolean, currentPlanId: string | null): DerivedCta {
  if (tier.isContact) return { label: 'Связаться', href: '/business?topic=enterprise' };
  if (!loggedIn) {
    return { label: 'Зарегистрироваться', href: `/register?callbackUrl=${encodeURIComponent('/pricing')}` };
  }
  if (currentPlanId === tier.id) return { label: 'Текущий тариф', href: null };
  const verb = tier.id === 'free' ? 'Перейти на Free' : `Сменить на ${tier.name}`;
  return { label: verb, href: `/dashboard/billing?upgrade=${tier.id}` };
}
```

In the JSX, replace the existing `<Link href={tier.ctaHref}>` button with derivation-aware rendering: if `cta.href === null`, render a disabled button with the label.

- [ ] **Step 3: Type-check**

```bash
bun run --cwd apps/web type-check
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/pricing/
git commit -m "feat(pricing): server wrapper + auth-aware CTAs (no more /register for logged-in users)"
```

---

## Task 9: Legacy redirects (308)

**Files:**
- Modify: `apps/web/src/app/me/submit-model/page.tsx`

- [ ] **Step 1: Replace body**

```tsx
// apps/web/src/app/me/submit-model/page.tsx
import { permanentRedirect } from 'next/navigation';

export default function MeSubmitModelLegacy() {
  permanentRedirect('/dashboard/models/new');
}
```

- [ ] **Step 2: Type-check**

```bash
bun run --cwd apps/web type-check
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/me/submit-model/page.tsx
git commit -m "refactor(me): /me/submit-model now 308 → /dashboard/models/new"
```

> **BLOCKER — spec §11.1 unresolved.** The spec lists `/account/request-human-review` as an open question — owner needs to choose: keep public (for parents-of-banned-users flow) or migrate to `/dashboard/profile/human-review`. The plan defers it (page untouched) so this task does NOT redirect it. **Before final merge to master, confirm with owner.** If owner chooses migrate-to-dashboard, add follow-up commit replacing the page body with `permanentRedirect('/dashboard/profile/human-review')` and create that page.

---

## Task 10: Stub pages (profile, security, wins, kyc)

These pages must exist so sidebar links don't 404. Each is a thin server component with a real header and an honest empty state — no MOCK arrays.

**Files:**
- Create: `apps/web/src/app/dashboard/profile/page.tsx`
- Create: `apps/web/src/app/dashboard/security/page.tsx`
- Create: `apps/web/src/app/dashboard/wins/page.tsx`
- Create: `apps/web/src/app/dashboard/kyc/page.tsx`

- [ ] **Step 1: profile/page.tsx**

```tsx
import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { users } from '@aiag/database/schema';
import { eq } from '@aiag/database';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Профиль — AI-Aggregator' };

export default async function ProfilePage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login?callbackUrl=/dashboard/profile');
  const u = await db.query.users.findFirst({
    where: eq(users.id, session.user.id),
    columns: { name: true, email: true, username: true, role: true, createdAt: true },
  });

  return (
    <section className="container mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-3xl font-bold tracking-tight mb-2">Профиль</h1>
      <p className="text-muted-foreground mb-6">Базовая информация аккаунта.</p>
      <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
        <dt className="text-muted-foreground">Имя</dt>
        <dd className="sm:col-span-2">{u?.name ?? '—'}</dd>
        <dt className="text-muted-foreground">Email</dt>
        <dd className="sm:col-span-2 font-mono">{u?.email ?? '—'}</dd>
        <dt className="text-muted-foreground">Username</dt>
        <dd className="sm:col-span-2 font-mono">{u?.username ?? '—'}</dd>
        <dt className="text-muted-foreground">Роль</dt>
        <dd className="sm:col-span-2">{u?.role ?? '—'}</dd>
      </dl>
      <p className="mt-8 text-xs text-muted-foreground">
        Редактирование появится в следующей итерации.
      </p>
    </section>
  );
}
```

- [ ] **Step 2: security/page.tsx**

```tsx
import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Безопасность — AI-Aggregator' };

export default async function SecurityPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login?callbackUrl=/dashboard/security');
  return (
    <section className="container mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-3xl font-bold tracking-tight mb-2">Безопасность</h1>
      <p className="text-muted-foreground mb-6">Пароль, OAuth-привязки и сессии.</p>
      <div className="rounded-md border p-5 mb-4" style={{ borderColor: 'var(--line)' }}>
        <h2 className="font-semibold mb-2">Сменить пароль</h2>
        <p className="text-sm text-muted-foreground">
          Используйте <Link href="/forgot-password" className="text-[var(--accent)] hover:underline">сброс через email</Link>.
          Прямая смена будет добавлена позже.
        </p>
      </div>
      <p className="text-xs text-muted-foreground">Полный security center появится в следующей итерации.</p>
    </section>
  );
}
```

- [ ] **Step 3: wins/page.tsx**

```tsx
import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { db, sql } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Победы — AI-Aggregator' };

interface Row { contest_name: string | null; rank: number | null; prize_amount: string | null; awarded_at: string | null }

export default async function WinsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login?callbackUrl=/dashboard/wins');
  const r = await db.execute(sql`
    SELECT c.name AS contest_name, p.rank, p.amount::text AS prize_amount, p.created_at::text AS awarded_at
    FROM prize_awards p
    LEFT JOIN contests c ON c.id = p.contest_id
    WHERE p.user_id = ${session.user.id}::uuid
    ORDER BY p.created_at DESC
    LIMIT 50
  `).catch(() => ({ rows: [] }));
  const rows = (((r as unknown as { rows?: unknown[] }).rows ?? r) as Row[]);

  return (
    <section className="container mx-auto max-w-4xl px-6 py-10">
      <h1 className="text-3xl font-bold tracking-tight mb-2">Победы</h1>
      <p className="text-muted-foreground mb-6">Призовые места в конкурсах AI-Aggregator.</p>
      {rows.length === 0 ? (
        <div className="rounded-md border p-12 text-center text-muted-foreground" style={{ borderColor: 'var(--line)' }}>
          Пока ни одной победы — поучаствуйте в <a href="/contests" className="text-[var(--accent)] hover:underline">конкурсе</a>.
        </div>
      ) : (
        <table className="w-full text-sm border rounded-md" style={{ borderColor: 'var(--line)' }}>
          <thead className="text-xs uppercase text-muted-foreground bg-muted/30">
            <tr><th className="px-4 py-3 text-left">Конкурс</th><th className="px-4 py-3">Место</th><th className="px-4 py-3 text-right">Приз</th><th className="px-4 py-3 text-left">Дата</th></tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-t" style={{ borderColor: 'var(--line)' }}>
                <td className="px-4 py-3">{row.contest_name ?? '—'}</td>
                <td className="px-4 py-3 text-center">{row.rank ?? '—'}</td>
                <td className="px-4 py-3 text-right tabular-nums">{row.prize_amount ? `${row.prize_amount} ₽` : '—'}</td>
                <td className="px-4 py-3 text-xs text-muted-foreground">{row.awarded_at?.slice(0, 10) ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
```

- [ ] **Step 4: kyc/page.tsx**

```tsx
import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { db, sql } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'KYC — AI-Aggregator' };

interface KycRow { kyc_status: string | null; kyc_type: string | null; tax_id: string | null }

export default async function KycPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login?callbackUrl=/dashboard/kyc');
  const r = await db.execute(sql`
    SELECT kyc_status, kyc_type, tax_id FROM users WHERE id = ${session.user.id}::uuid LIMIT 1
  `).catch(() => ({ rows: [] }));
  const u = (((r as unknown as { rows?: unknown[] }).rows ?? r) as KycRow[])[0];

  return (
    <section className="container mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-3xl font-bold tracking-tight mb-2">KYC</h1>
      <p className="text-muted-foreground mb-6">Подтверждение личности нужно для выплат с baланса.</p>
      <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm rounded-md border p-5" style={{ borderColor: 'var(--line)' }}>
        <dt className="text-muted-foreground">Статус</dt>
        <dd className="sm:col-span-2 font-mono">{u?.kyc_status ?? 'не пройдено'}</dd>
        <dt className="text-muted-foreground">Тип</dt>
        <dd className="sm:col-span-2">{u?.kyc_type ?? '—'}</dd>
        <dt className="text-muted-foreground">ИНН / Tax ID</dt>
        <dd className="sm:col-span-2 font-mono">{u?.tax_id ?? '—'}</dd>
      </dl>
      <p className="mt-6 text-xs text-muted-foreground">Загрузка документов появится после подключения S3 (REQ-INF-011).</p>
    </section>
  );
}
```

- [ ] **Step 5: Type-check**

```bash
bun run --cwd apps/web type-check
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/dashboard/profile/page.tsx apps/web/src/app/dashboard/security/page.tsx apps/web/src/app/dashboard/wins/page.tsx apps/web/src/app/dashboard/kyc/page.tsx
git commit -m "feat(dashboard): stub pages for profile/security/wins/kyc with real queries"
```

---

## Task 10b: FIXME-tag the legacy MOCK pages

Per spec §9 row 10 — pages `billing/earnings/referrals/submissions/usage/keys` are NOT being converted in this plan, but spec demands at minimum a FIXME header so a future iteration knows where to look. This task adds a one-line FIXME comment at the top of each that has hardcoded data.

**Files (audit + add FIXME if MOCK):**
- `apps/web/src/app/dashboard/billing/page.tsx`
- `apps/web/src/app/dashboard/earnings/page.tsx`
- `apps/web/src/app/dashboard/keys/page.tsx`
- `apps/web/src/app/dashboard/referrals/page.tsx`
- `apps/web/src/app/dashboard/submissions/page.tsx`
- `apps/web/src/app/dashboard/usage/page.tsx`

- [ ] **Step 1: Grep for hardcoded data in each**

```bash
for f in apps/web/src/app/dashboard/{billing,earnings,keys,referrals,submissions,usage}/page.tsx; do
  echo "=== $f ==="
  grep -nE "MOCK|hardcoded|^const \w+ = (\[|\{)" "$f" | head -3 || echo "(clean)"
done
```

- [ ] **Step 2: For each page that has MOCK arrays/objects, prepend a FIXME comment**

```ts
// FIXME(spec §9 row 10): this page renders hardcoded data. Convert to a
// server component reading from DB before public launch. Tracked in
// docs/superpowers/specs/2026-05-10-dashboard-ia-redesign-design.md §10.
```

If the file is already a server component reading real data — skip it (no FIXME needed). The grep above tells you which ones to touch.

- [ ] **Step 3: Type-check + commit**

```bash
bun run --cwd apps/web type-check
git add apps/web/src/app/dashboard/
git commit -m "chore(dashboard): FIXME-tag legacy MOCK pages per spec §9 row 10"
```

---

## Task 11: Deploy + smoke

**Files:** None (verification only).

- [ ] **Step 1: Push everything**

```bash
git push origin master
```

- [ ] **Step 2: Trigger production deploy**

```bash
gh workflow run "Deploy to Production (bare-metal VPS)" --ref master
```

- [ ] **Step 3: Wait for deploy**

```bash
sleep 6
RUN=$(gh run list --workflow="Deploy to Production (bare-metal VPS)" --limit 1 --json databaseId --jq '.[0].databaseId')
echo "Run: $RUN"
gh run watch $RUN --exit-status
```

Expected: both `build` and `deploy` jobs return `success`. If `build` fails, read the log, fix the type/import error, commit, repeat.

- [ ] **Step 4: Smoke (per spec §12)**

```bash
ssh aiag-vps 'echo "=== anonymous → /dashboard ==="
curl -sko /dev/null -w "%{http_code}\n" -m 5 http://127.0.0.1:3000/dashboard

echo "=== anonymous → /admin ==="
curl -sko /dev/null -w "%{http_code}\n" -m 5 http://127.0.0.1:3000/admin

echo "=== /me/submit-model 308 ==="
curl -sko /dev/null -w "%{http_code} → %{redirect_url}\n" -m 5 http://127.0.0.1:3000/me/submit-model

echo "=== /pricing renders ==="
curl -sko /dev/null -w "%{http_code}\n" -m 5 http://127.0.0.1:3000/pricing

echo "=== /onboarding still 404 ==="
curl -sko /dev/null -w "%{http_code}\n" -m 5 http://127.0.0.1:3000/onboarding

echo "=== /dashboard?mode=author 307 (anon) ==="
curl -sko /dev/null -w "%{http_code}\n" -m 5 "http://127.0.0.1:3000/dashboard?mode=author"

echo "=== /dashboard/profile, /security, /wins, /kyc render (anon → 307) ==="
for p in /dashboard/profile /dashboard/security /dashboard/wins /dashboard/kyc; do
  CODE=$(curl -sko /dev/null -w "%{http_code}" -m 5 "http://127.0.0.1:3000$p")
  echo "$p → $CODE"
done

echo "=== pm2 ==="
sudo -u aiag pm2 list 2>&1 | head -8'
```

Expected:
- `/dashboard` → `307` (anonymous, redirected to login)
- `/admin` → `307` (anonymous gate fires; redirects to `/login?callbackUrl=/admin`)
- `/me/submit-model` → `308` to `/dashboard/models/new`
- `/pricing` → `200`
- `/onboarding` → `404` (harmless — no redirect from auth.ts anymore)
- `/dashboard?mode=author` → `307` (anonymous gate fires before mode resolution)
- `/dashboard/{profile,security,wins,kyc}` → `307` each
- pm2 web/gateway/worker all `online`

- [ ] **Step 5: Owner manual smoke (open in browser)**

Owner verifies via browser:
- Logged in: see avatar dropdown in header on `/`, `/marketplace`, `/pricing`
- `/dashboard` shows real numbers (not 750/1200/1234/3); plan = «Free» if no subscription
- Sidebar visible on every `/dashboard/*` route; mode chip click navigates to `/dashboard?mode=X`
- **Soft-navigation on chip click:** open DevTools Network → click a mode chip → only an RSC payload request appears, no full document re-fetch. (Spec §12 «soft-nav re-runs the layout».)
- **Mobile drawer parity:** open in narrow viewport → tap menu → drawer shows avatar block with Dashboard / Профиль / Админка / Выйти (NOT Войти/Регистрация) when logged-in.
- **signOut flow:** click «Выйти» in dropdown → lands on `/`, header reverts to anonymous variant immediately.
- `/pricing` shows «Сменить на ...» buttons (not «Регистрация») when logged in. For a user with no subscription row, all tier CTAs offer "Сменить" / "Перейти" — none rendered as «Текущий тариф».
- `/me/submit-model` redirects to `/dashboard/models/new`.
- Admin sees «Админка →» in sidebar; clicks it, lands in `/admin`.

If any verification fails, open an issue and fix in a follow-up task. The plan is complete when the smoke commands return the expected codes.

---

## Notes for the executor

- @superpowers:verification-before-completion — before claiming a task complete, the type-check command MUST have returned 0 errors. No "I'm sure it compiles" — run it.
- @superpowers:subagent-driven-development — if dispatching subagents, isolate each task fully (file paths + spec section + verify step).
- Do NOT introduce a `middleware.ts` in this plan. Spec §8 explicitly defers it.
- Do NOT touch `/admin/*` files — separate space, out of scope.
- Do NOT touch `/dashboard/billing`, `/dashboard/earnings`, `/dashboard/keys`, `/dashboard/usage`, `/dashboard/submissions`, `/dashboard/referrals` page files — they may contain MOCK but are explicitly out-of-scope per spec §10 (their P0 conversion is for a follow-up plan; they will at least be reachable via the new sidebar).
- If type-check fails for `db.query.users` patterns — fall back to raw `db.execute(sql\`...\`)` which is the project's prevailing pattern (see `/api/admin/models/[id]/depublish/route.ts` for an example).
