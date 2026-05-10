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
| `/me/submit-model` | 308 → `/dashboard/models/new` (via Next 15 `permanentRedirect()`) |
| `/account/request-human-review` | 308 → `/dashboard/profile/human-review` (or keep public, owner-decision deferred — see "Open questions") |

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

- Three chips at top: User / Author / Participant. All three are always interactive (no muting in v1 — see §10).
- Mode is derived from `?mode=` query first, then from path family as a fallback (so `/dashboard/models` defaults to `author`, `/dashboard/submissions` to `participant`, everything else to `user`). Path-family mapping:
  - `author`: `/dashboard/models`, `/dashboard/earnings`, `/dashboard/payouts`, `/dashboard/kyc`
  - `participant`: `/dashboard/submissions`, `/dashboard/wins`
  - `user`: everything else
- Active mode persists in URL: `/dashboard?mode=author`. The URL query overrides path-family inference (so a user on `/dashboard/keys?mode=author` sees the author sidebar even though `/dashboard/keys` is a user-family page).
- **Chip click navigation:** clicking a mode chip always navigates to `/dashboard?mode=X` (the overview of that mode), never to a sibling page in the new mode. Rationale: the user's current page may not exist in the target mode, and "go to overview" is the safest landing.
- **Default mode (no `?mode=` query, on `/dashboard`):** plain `user`. No auto-detection in v1 (see §10 — explicitly dropped).

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
const mode = (searchParams.mode as Mode | undefined) ?? 'user';
const data = await fetchOverview(session.user.id, mode);
```

`fetchOverview` queries (all use `LEFT JOIN` and coalesce nulls — see "Empty-state contract" below):

- `subscriptions` LEFT JOIN plans → currentPlan (or `'free'` fallback), monthlyCreditsLimit (`null` ⇒ display «нет тарифа»), monthlyCreditsUsed
- `gateway_requests` count where `created_at >= date_trunc('month', now())` and `user_id = me` → API-вызовы
- `models` count where `author_user_id = me` AND `status='live'` → published count
- `models` count of distinct `model_id` referenced in user's `gateway_requests` this month → "active models used by me" (user-mode tile #3)
- Last 5 `gateway_requests` rows for the activity table

Mode-specific tile swaps:

| Tile | mode=user | mode=author | mode=participant |
|------|-----------|-------------|------------------|
| 1st | Кредиты (used / limit) | Заработок этого месяца | Активные конкурсы |
| 2nd | API-вызовы | Вызовы моих моделей | Мои сабмишены |
| 3rd | Активные модели (used by me) | Опубликовано (status='live') | Победы (count where prize_awards.user_id = me) |
| 4th | Тариф | Тариф | Тариф |

**Empty-state contract.** Every tile MUST render without error when its source returns zero rows or null:

- No `subscriptions` row → "Тариф: Free" + 0 used / `−` limit
- 0 `gateway_requests` this month → "0 за месяц" with no delta arrow
- 0 `models` → tile renders "0 опубликовано" + helper link «Загрузить первую модель»
- 0 `contest_submissions` → tile renders "Пока нет сабмишенов" + helper link «Найти конкурс»

The "recent activity" panel below tiles always shows last 5 `gateway_requests` for the user, regardless of mode. Empty-state: «Здесь появятся ваши API-вызовы».

---

## 8. Auth gates

Two boundaries, enforced at layout level (Next 15 RSC pattern):

```ts
// app/dashboard/layout.tsx
const session = await auth();
if (!session?.user) {
  // We can't read the request pathname inside a layout RSC without injecting
  // a custom header from middleware (Next does NOT expose `x-pathname` by
  // default). Avoid that complexity: send the user to /login and rely on the
  // login page reading `usePathname()` on the client to set the next-redirect
  // OR accept always-/dashboard as the post-login target. Simpler default:
  redirect('/login?callbackUrl=/dashboard');
}
```

```ts
// app/admin/layout.tsx (existing — keep)
const session = await auth();
if (!session?.user?.id) redirect('/login?callbackUrl=/admin');
const me = await db.query.users.findFirst({
  where: eq(users.id, session.user.id), // ID, not email — see note
});
if (!me || me.role !== 'admin') redirect('/dashboard');
```

**Anonymous on `/admin/*`.** The first guard above redirects to `/login?callbackUrl=/admin`; on success we re-enter the layout, the role check fires, and a non-admin is bounced to `/dashboard`.

**ID over email lookup.** NextAuth v5 with our jwt callback writes `token.id = user.id` and `session.user.id = token.id` (already done in `auth.ts`). Lookup via `users.id` is exact and provider-agnostic. Email lookup is fine as a fallback but not the primary key.

**No middleware in v1.** Layout-level `auth()` covers both gates. We will add `middleware.ts` only if a future requirement (e.g. capturing the original pathname for `callbackUrl`, or rate-limiting) needs pre-routing logic. The accepted trade-off here: post-login always lands on `/dashboard` (or `/admin`), not the originally-requested deep link. Owner approved this v1 simplification.

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
| 7 | `apps/web/src/app/me/submit-model/page.tsx` | Replace body with `permanentRedirect('/dashboard/models/new')` (Next 15 — emits 308, the closest to "permanent" semantics; bookmarks and any indexed crawler will follow). |
| 8 | `apps/web/src/app/account/request-human-review/page.tsx` | Either `permanentRedirect('/dashboard/profile/human-review')` (creating that page) OR keep as is — see Open question §11.1. |
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
- **Mode auto-detection** based on the user's existing data (was an early candidate). Reasons it's dropped from v1: (a) extra count queries on every layout render; (b) surprise factor — a user who once submitted a contest entry would land in "Participant" mode and not see API-keys without finding the chip; (c) we can revisit once we have real users and data. Default mode in v1 is always `user`.
- **Muted/disabled mode chips** based on data availability — same reasoning. All three chips are always clickable; the mode's overview shows an empty-state CTA when there's nothing to show.
- **Deep-link callbackUrl preservation through `/login`** — for v1 we always redirect to `/dashboard` (or `/admin`) post-login, not back to the requested deep page. Adding middleware to capture pathname is the follow-up.

---

## 11. Open questions

1. **`/account/request-human-review`** — is the human-review request a flow that anonymous users may initiate (e.g. parent of a banned account), or only logged-in users? If anonymous, keep the `/account` path. If only logged-in, migrate to `/dashboard/profile/human-review`.
2. **Mode switcher in URL vs cookie** — URL means a refresh is shareable but a copy-pasted link bakes in someone else's mode preference. The spec uses URL; cookie is a possible follow-up.
3. **Admin → dashboard back-link** — should `/admin/*` layout offer a «Вернуться в кабинет» link? Out of scope; can be added trivially later.

---

## 12. Verification (after implementation)

Core:

- Logged-in owner sees avatar + dropdown in header on every public page.
- `/dashboard` shows real DB-backed numbers (credits, calls, models) — not 750/1200/1234/3.
- Sidebar navigation visible on every `/dashboard/*` page; mode switcher reflects URL.
- Anonymous user visiting `/dashboard` → `/login?callbackUrl=/dashboard`; on success, returns to `/dashboard`.
- Logged-in user on `/pricing` clicking «Сменить на Pro» → `/dashboard/billing?upgrade=pro`, not `/register`.
- `/me/submit-model` returns `308 → /dashboard/models/new`.
- Switching modes via chip click navigates to `/dashboard?mode=X` and re-renders sidebar via soft-navigation (server layout re-runs, no hard reload).
- Admin sees «Админка →» in dashboard sidebar; non-admin does not.

Edge cases (added per spec review):

- **Anonymous on `/admin/*`** → 307 to `/login?callbackUrl=/admin` (per §8). After login, role check redirects non-admin to `/dashboard`.
- **`/pricing` for user with no `subscriptions` row** → all tier CTAs offer "upgrade" (none rendered as "Текущий"); page renders without error.
- **Overview with all-zero data** (new user, 0 models, 0 submissions, no subscription) → all four tiles render their empty-state copy from §7; no thrown errors; recent-activity panel shows the empty-state line.
- **MainNavbar mobile drawer** when logged-in → drawer shows the same avatar+items as desktop dropdown (Dashboard, Профиль, Админка if admin, Выйти), not anonymous «Войти/Регистрация».
- **signOut from avatar dropdown** → calls NextAuth `signOut({ callbackUrl: '/' })` → session cleared → `/`. Header on `/` returns to anonymous variant.
- **Mode chip click from `/dashboard/keys?mode=user`** → clicking "Author" → `/dashboard?mode=author` (overview), NOT `/dashboard/keys?mode=author`.
