---
title: Dashboard IA Redesign — User Workflows Unification
date: 2026-05-10
status: design (approved by owner)
authors: [Claude Opus 4.7, owner]
supersedes: []
---

# Dashboard IA Redesign — User Workflows Unification

## Background

The aggregator's frontend grew accreted across phases without an IA review. Three concrete symptoms surfaced:

1. **Header is auth-blind.** `MainNavbar.tsx` is a static client component — it always renders «Войти / Регистрация», even for the logged-in owner. Confuses every authenticated session.
2. **`/dashboard/page.tsx` is hardcoded MOCK.** A `'use client'` page with `const stats = { credits: { used: 750, total: 1200 } }` and a `recentCalls` array literal. No session lookup, no DB query — every visitor sees the same fake numbers.
3. **No `/dashboard/layout.tsx`.** No sidebar, no nav between `keys/billing/usage/models/...` — clicking «API-ключи» feels like a context-loss instead of a section switch. `/admin/*` does have a layout; the asymmetry is jarring.
4. **Parallel paths for the same task.** `/me/submit-model/` and `/dashboard/models/new` both submit a model. `/account/request-human-review/` is a third orphan tree.
5. **`/pricing` CTA is auth-blind.** Hardcoded `ctaHref` always sends to `/register` or `/login`, so a logged-in user picking «Сменить тариф» gets a registration screen.

Owner asked for a single coherent IA across all user-facing flows. Scope spans three sub-projects (A — IA + auth-aware nav, B — author flow, C — contest participant flow); owner chose to design all three together.

## Goals

- Single IA: one canonical URL space, one nav model, one mental model of «my account».
- Auth-aware UI: header and pricing know whether visitor is logged in.
- Real data: dashboard overview reads DB, not literals.
- Role flexibility: a single user can be API consumer + model author + contest participant simultaneously without switching accounts.

## Non-goals (this iteration)

- Onboarding wizard — owner decided NextAuth `pages.newUser` stays unset; first OAuth visit lands on `/dashboard` directly.
- Email notifications on model approve/reject — separate spec.
- Rich Webhooks UI — current `/dashboard/webhooks` stays as is.
- Encrypting `models.metadata.auth_token` — owner-acknowledged debt, separate.
- Migrating every MOCK page in one shot — overview + sidebar are P0; the rest follow.

---

## 1. Roles and access matrix

A single user may hold multiple roles simultaneously. Roles are derived, not toggled — they only filter what the UI shows.

| Role | How it's earned | URL space granted |
|------|-----------------|-------------------|
| **Anonymous** | Default | Marketing pages, marketplace browse, contests browse, docs, pricing, `/login`, `/register` |
| **User** | Any login (OAuth or credentials) | `/dashboard?mode=user` (default visible mode) |
| **Author** | At least one row in `models WHERE author_user_id = me` | `/dashboard?mode=author` is offered in switcher |
| **Participant** | At least one row in `contest_submissions WHERE user_id = me` | `/dashboard?mode=participant` is offered in switcher |
| **Admin** | `users.role = 'admin'` in DB | `/admin/*` plus visible "Админка" link in dashboard sidebar header |

`mode` is a UI filter living in the URL query. It is not authorization — every logged-in user can switch into any mode whose preconditions they meet. Auth gates only enforce two boundaries: `/dashboard/*` requires a session; `/admin/*` requires `role='admin'`.

---

## 2. URL space (consolidated)

Public:

```
/                          landing
/marketplace               browse models (public)
/marketplace/[slug]        model detail (public)
/contests                  list contests
/contests/[slug]           contest detail
/contests/[slug]/leaderboard
/docs                      documentation
/pricing                   pricing tiers (auth-aware CTAs)
/business                  B2B page
/login /register /logout
/forgot-password /reset-password
```

Dashboard (single space, mode-aware):

```
/dashboard                            overview (mode-aware)
/dashboard?mode=user|author|participant   switcher state (URL-persisted)

# Mode "user" — API consumer
/dashboard/keys
/dashboard/usage
/dashboard/billing
/dashboard/webhooks

# Mode "author"
/dashboard/models
/dashboard/models/new
/dashboard/models/[id]
/dashboard/earnings
/dashboard/payouts
/dashboard/kyc

# Mode "participant"
/dashboard/submissions
/dashboard/wins

# Always visible (under mode block)
/dashboard/profile
/dashboard/security
/dashboard/referrals
```

Admin (separate space, unchanged):

```
/admin/*       (existing routes; gated by users.role='admin')
```

Migrations (delete or 301-redirect):

| Old | New |
|-----|-----|
| `/me/submit-model` | 301 → `/dashboard/models/new` |
| `/account/request-human-review` | 301 → `/dashboard/profile/human-review` (or keep public, owner-decision deferred — see "Open questions") |

`/onboarding` does not exist and will not be created. The earlier NextAuth `pages.newUser: '/onboarding'` was removed — first-login redirects to `/dashboard` directly.

---

## 3. Layouts

| Tree | Layout | Responsibilities |
|------|--------|------------------|
| `/`, `(marketing)/*`, `pricing`, `docs`, `business` | `app/layout.tsx` (root) + `MainNavbar` | Session-aware header + footer |
| `(auth)/*` | `app/(auth)/layout.tsx` | Plain logo, no nav — keeps focus on the form |
| `/dashboard/**` | **NEW** `app/dashboard/layout.tsx` | Server-side `await auth()` gate; renders `<DashboardSidebar>` + `<DashboardHeader>` (avatar dropdown) around children |
| `/admin/**` | existing `app/admin/layout.tsx` | Existing role check + admin sidebar; not changed |

The dashboard layout is the most consequential piece. It owns:

- `await auth()` — `redirect('/login?callbackUrl=' + encodeURIComponent(pathname))` if no session
- Lookup current user's role + counts (models count, submissions count) for sidebar visibility flags
- Renders `<DashboardSidebar>` (client) — see §4
- Renders shared header above sidebar+content with avatar dropdown

---

## 4. DashboardSidebar component

```
┌──────────────────────────────────────────────┐
│  ai-aggregator           Header (avatar ▼)   │  ← shared header (session)
├──────────────────┬───────────────────────────┤
│                  │                           │
│  ╭──────────╮    │                           │
│  │ 👤 User  │    │                           │  ← Mode switcher
│  │ 🎨 Author│    │   {children}              │     (3 chips, URL-persisted)
│  │ 🏆 Part. │    │                           │
│  ╰──────────╯    │                           │
│                  │                           │
│  Обзор           │                           │
│  ─────────       │                           │
│  Mode-specific   │                           │
│  links           │                           │  ← Items per active mode
│                  │                           │
│  Профиль         │                           │  ← Always visible
│  Безопасность    │                           │
│  Реферралы       │                           │
│  [Админка →]     │                           │  ← Only if admin
└──────────────────┴───────────────────────────┘
```

**Mode switcher behavior:**

- Three chips at top: User / Author / Participant
- A mode is "available" if the user has any data in it (`models.count > 0` for author; `contest_submissions.count > 0` for participant). Unavailable modes show as muted with a tooltip («Появится после первой подачи модели» / «...первого сабмишена»). Clicking an unavailable mode still navigates — it just lands on the mode's "empty state" CTA.
- Active mode persists in URL: `/dashboard?mode=author`. The URL is the source of truth.
- Default mode resolution (server, in `dashboard/layout.tsx`):
  1. If `?mode=` query is present and valid → use it.
  2. Else if `models.count > 0` → `author`
  3. Else if `contest_submissions.count > 0` → `participant`
  4. Else → `user`

**Sidebar items per mode:**

| User | Author | Participant |
|------|--------|-------------|
| Обзор | Обзор | Обзор |
| API-ключи | Мои модели | Мои сабмишены |
| Использование | Заработок | Победы |
| Биллинг | Выплаты | Конкурсы |
| Webhooks | KYC | |

**Always-visible block** (rendered under the mode block, separated by a divider): Профиль, Безопасность, Реферралы. If the session user has `role='admin'`, append a styled "Админка →" link to `/admin`.

---

## 5. Auth-aware MainNavbar

Current `MainNavbar` is fully static. Replace with a server wrapper that reads the session and renders one of two right-side blocks. The existing menu (Маркетплейс / Конкурсы / Документация / Тарифы / Для бизнеса) and the wordmark stay.

**Anonymous** (right side):

```
[ Войти ]  [ Регистрация ]
```

(unchanged from today)

**Logged-in** (right side):

```
[ avatar  Имя ▼ ]
```

Dropdown contents:

- Перейти в Dashboard → `/dashboard`
- Профиль → `/dashboard/profile`
- Админка → `/admin` (only if `role='admin'`)
- Выйти → calls `signOut()` then redirects to `/`

The avatar uses `users.image` if present, else initials of `users.name`. Mobile drawer mirrors the same logic.

Implementation note: NextAuth's `auth()` is server-only. Realize MainNavbar as a Server Component that imports a client `<UserMenu>` for the dropdown interactions; pass session shape as a prop.

---

## 6. /pricing CTAs are auth-aware

Replace hardcoded `ctaHref` per tier with a derivation:

```ts
function ctaForTier(
  tier: Tier,
  session: Session | null,
  currentPlanId: string | null,
): { label: string; href: string | null } {
  if (tier.isContact) {
    return { label: 'Связаться', href: '/business?topic=enterprise' };
  }
  if (!session) {
    return {
      label: 'Зарегистрироваться',
      href: `/register?callbackUrl=${encodeURIComponent('/pricing')}`,
    };
  }
  if (currentPlanId === tier.id) {
    return { label: 'Текущий тариф', href: null }; // disabled
  }
  return {
    label: tier.id === 'free' ? 'Перейти на Free' : `Сменить на ${tier.name}`,
    href: `/dashboard/billing?upgrade=${tier.id}`,
  };
}
```

Implementation: `/pricing` becomes a thin server wrapper that calls `auth()` + queries `subscriptions` for the current plan, then renders the existing client UI with derived CTAs. After clicking, `/dashboard/billing?upgrade=X` is responsible for showing the payment modal — wiring is out of scope for this spec (treat as existing behaviour).

---

## 7. /dashboard overview replaces MOCK

A server component reading from DB. Mode-aware shape:

```ts
// pseudocode
const session = await auth();
const mode = resolveMode(searchParams.mode, ...counts);
const data = await fetchOverview(session.user.id, mode);
```

`fetchOverview` queries:

- `subscriptions` JOIN plans → currentPlan, monthlyCreditsLimit, monthlyCreditsUsed
- `gateway_requests` count where created_at >= start_of_month
- `models` count where author_user_id = me
- Last 5 `gateway_requests` rows for the activity table

Mode-specific tile swaps:

| Tile | mode=user | mode=author | mode=participant |
|------|-----------|-------------|------------------|
| 1st | Кредиты | Заработок этого месяца | Активные конкурсы |
| 2nd | API-вызовы | Вызовы моих моделей | Мои сабмишены |
| 3rd | Активные модели (used by me) | Опубликовано | Победы (счётчик) |
| 4th | Тариф | Тариф | Тариф |

The "recent activity" panel below tiles always shows last 5 gateway_requests for the user (calls they made), regardless of mode.

---

## 8. Auth gates

Two boundaries, enforced at layout level (Next 14 RSC pattern):

```ts
// app/dashboard/layout.tsx
const session = await auth();
if (!session?.user) {
  redirect(`/login?callbackUrl=${encodeURIComponent(headers().get('x-pathname') ?? '/dashboard')}`);
}
```

```ts
// app/admin/layout.tsx (existing — keep)
const session = await auth();
const me = session && (await db.query.users.findFirst({ where: eq(users.email, session.user.email!) }));
if (!me || me.role !== 'admin') redirect('/dashboard');
```

A `middleware.ts` is **not** strictly required if every layout enforces its own gate — Next 14 + RSC handles redirects cleanly from layouts. Add middleware only if we ever need to short-circuit before route resolution (e.g. heavy auth checks for many leaf pages). Out of scope here.

---

## 9. File-level migration plan

| # | File | Action |
|---|------|--------|
| 1 | `apps/web/src/components/layout/MainNavbar.tsx` | Convert to server component (or split into `MainNavbar.tsx` server + `<UserMenu>` client). Read `auth()`, render anon/logged variants. |
| 2 | `apps/web/src/app/dashboard/layout.tsx` | **CREATE.** `await auth()` gate; resolve mode; query counts; render sidebar + header + children. |
| 3 | `apps/web/src/components/dashboard/DashboardSidebar.tsx` | **CREATE.** Mode switcher chips + dynamic items + always-visible block. Client component (uses `usePathname` + Link). |
| 4 | `apps/web/src/components/dashboard/UserMenu.tsx` | **CREATE.** Avatar dropdown (used by both MainNavbar and DashboardHeader). |
| 5 | `apps/web/src/app/dashboard/page.tsx` | Rewrite as server component, real queries, mode-aware tiles. Drop `'use client'`. |
| 6 | `apps/web/src/app/pricing/page.tsx` | Wrap in server component for session + currentPlan; derive CTAs via `ctaForTier`. |
| 7 | `apps/web/src/app/me/submit-model/page.tsx` | Replace body with `redirect('/dashboard/models/new')`. |
| 8 | `apps/web/src/app/account/request-human-review/page.tsx` | Either redirect to `/dashboard/profile/human-review` (creating that page) OR keep as is — owner-decision deferred. |
| 9 | `apps/web/src/app/dashboard/{wins,kyc,profile,security}/page.tsx` | **CREATE** as honest empty-state stubs (real schema queries, even if results are zero). No MOCK arrays. |
| 10 | `apps/web/src/app/dashboard/{billing,earnings,referrals,submissions,usage,keys}/page.tsx` | Audit each — many are `'use client'` with hardcoded data per the prior session's review. Convert to server components reading DB or mark explicitly with `// FIXME: still MOCK` if the table doesn't exist yet. |

---

## 10. Out of scope (explicit)

- Onboarding wizard / first-login dialog.
- Email notifications (approve/reject author models, contest results).
- Webhooks UI rebuild.
- KEK encryption of `models.metadata.auth_token` (debt acknowledged elsewhere).
- Rebuilding `/dashboard/webhooks` rich UI.
- Implementing payment modal at `/dashboard/billing?upgrade=...` (assume existing behaviour will satisfy the redirect; if not, separate spec).

---

## 11. Open questions

1. **`/account/request-human-review`** — is the human-review request a flow that anonymous users may initiate (e.g. parent of a banned account), or only logged-in users? If anonymous, keep the `/account` path. If only logged-in, migrate to `/dashboard/profile/human-review`.
2. **Mode switcher in URL vs cookie** — URL means a refresh is shareable but a copy-pasted link bakes in someone else's mode preference. The spec uses URL; cookie is a possible follow-up.
3. **Admin → dashboard back-link** — should `/admin/*` layout offer a «Вернуться в кабинет» link? Out of scope; can be added trivially later.

---

## 12. Verification (after implementation)

- Logged-in owner sees avatar + dropdown in header on every public page.
- `/dashboard` shows real DB-backed numbers (credits, calls, models) — not 750/1200/1234/3.
- Sidebar navigation visible on every `/dashboard/*` page; mode switcher reflects URL.
- Anonymous user visiting `/dashboard` → `/login?callbackUrl=/dashboard`; on success, returns to `/dashboard`.
- Logged-in user on `/pricing` clicking «Сменить на Pro» → `/dashboard/billing?upgrade=pro`, not `/register`.
- `/me/submit-model` returns `301 → /dashboard/models/new`.
- Switching modes preserves URL state and updates sidebar items without a full reload (client navigation).
- Admin sees «Админка →» in dashboard sidebar; non-admin does not.
