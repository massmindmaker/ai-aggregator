# TMA Redesign A (каркас + Маркет-персонажи + Дэшборд/Кошелёк/Аккаунт) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перестроить TMA в один продукт под дизайнборд: 5-таб навигация без дублей, витрина карточек-персонажей (charCard), и разнесённые Дэшборд/Кошелёк/Аккаунт — на существующем бэкенде.

**Architecture:** Чистый Next.js 14 App Router фронтенд-редизайн. Новый BottomNav (5 табов) + новые роуты `/dashboard` `/wallet` `/account`; `/agents` становится инбоксом, старый хаб переезжает в `/dashboard`; `/market` становится витриной агентов из существующего templates-API. Новый компонент charCard. Без новых таблиц/money-path.

**Tech Stack:** Next 14.2.33, React, TypeScript, tma-* CSS-токены (globals.css), существующие API `/api/tma/*`.

**Спека:** `docs/superpowers/specs/2026-06-12-tma-redesign-A-shell-market-design.md`. **Дизайн-канон:** `docs/wireframes/design-board.html` (charCard, экраны 03/05).

## ⚠️ Verification под проект (no-local-runtime)
Тест-раннера/локального дев нет (см. CLAUDE.md). Замена «failing test → pass»:
- **typecheck:** `cd apps/tg-miniapp && bun run typecheck` → 0 ошибок (ОБЯЗАТЕЛЬНО каждый таск).
- **grep-verify:** точечные grep по факту (классы/строки на месте, старых дублей нет).
- **prod-verify:** после деплоя — `aiag-deploy` recipe (CI build → ручной `pm2 restart tma` от root с `set -a;. .env`), затем curl health + grep бандла. Деплой — раз в конце (Task 9), не на каждый таск.
- Коммиты — на каждый таск (frequent commits).

## File Structure (что трогаем)
```
apps/tg-miniapp/
  src/components/
    BottomNav.tsx        [Modify] 3→5 табов
    CharCard.tsx         [Create] полная карточка-персонаж (вынос из AgentCard)
    AgentCard.tsx        [Modify] стать тонкой обёрткой над CharCard ИЛИ оставить для инбокса
  app/
    agents/page.tsx      [Modify] хаб → мессенджер-инбокс
    dashboard/page.tsx   [Create] = старый хаб (перенос содержимого agents/page.tsx)
    market/page.tsx      [Modify] каталог моделей → витрина агентов (templates API)
    wallet/page.tsx      [Create] = из profile (баланс+topup-ссылка+леджер+кошельки)
    account/page.tsx     [Create] = профиль+тариф+доход+согласия+выход
    profile/page.tsx     [Modify] → редирект на /wallet (или удалить, ссылки перенаправить)
    templates/page.tsx   [Modify] → редирект на /market
    skills/page.tsx      [Modify] → операторский сегмент (заглушка «для операторов»)
    globals.css          [Modify] классы charCard (.cc-*) + inbox (.inbox-*)
  app/api/tma/agents/route.ts [Modify] добавить last-run превью для инбокса (если нет)
```
**Граница ответственности:** CharCard = только карточка (вход: пропсы, выход: разметка). BottomNav = только навигация. Каждый page = один экран.

---

### Task 1: BottomNav — 5 табов

**Files:**
- Modify: `apps/tg-miniapp/src/components/BottomNav.tsx`

- [ ] **Step 1: Прочитать текущий BottomNav** (узнать форму Item, icon-стиль, active-логику с полем `match`).
Run: `cat apps/tg-miniapp/src/components/BottomNav.tsx`

- [ ] **Step 2: Переписать список табов на 5.** Сохранить существующий outline-SVG стиль иконок и `active = (it.match ?? [it.href]).some(...)`.

```tsx
const ITEMS: { href: string; label: string; icon: string; match?: string[] }[] = [
  { href: '/agents',    label: 'Агенты',   icon: '<path d=".."/>', match: ['/agents'] },
  { href: '/market',    label: 'Маркет',   icon: '<path d=".."/>', match: ['/market'] },
  { href: '/dashboard', label: 'Дэшборд',  icon: '<path d=".."/>', match: ['/dashboard'] },
  { href: '/wallet',    label: 'Кошелёк',  icon: '<path d=".."/>', match: ['/wallet'] },
  { href: '/account',   label: 'Аккаунт',  icon: '<path d=".."/>', match: ['/account'] },
];
```
Иконки взять из существующего набора (ICONS в `agents/page.tsx` HubIcon — скопировать пути d: chat-bubble для Агенты, grid/cards для Маркет, chart для Дэшборд, wallet для Кошелёк, user для Аккаунт). 5 иконок outline 24×24, без emoji.

- [ ] **Step 3: typecheck.** Run: `cd apps/tg-miniapp && bun run typecheck` → 0.
- [ ] **Step 4: grep-verify.** Run: `grep -c "href:" apps/tg-miniapp/src/components/BottomNav.tsx` → 5.
- [ ] **Step 5: Commit.**
```bash
git add apps/tg-miniapp/src/components/BottomNav.tsx
git commit -m "feat(redesign-A): BottomNav 5 табов (Агенты/Маркет/Дэшборд/Кошелёк/Аккаунт)"
```

---

### Task 2: Перенести старый хаб в `/dashboard`

**Files:**
- Create: `apps/tg-miniapp/app/dashboard/page.tsx`
- Modify: `apps/tg-miniapp/app/agents/page.tsx` (временно опустошить под инбокс — реальный инбокс в Task 5)

- [ ] **Step 1: Скопировать текущий `agents/page.tsx` в `dashboard/page.tsx`.**
Run: `cp apps/tg-miniapp/app/agents/page.tsx apps/tg-miniapp/app/dashboard/page.tsx`

- [ ] **Step 2: В `dashboard/page.tsx`** переименовать экспорт-функцию `AgentsHubPage`→`DashboardPage`; шорткаты сетки, которые вели на `/templates`/`/skills`, перенаправить: «Шаблоны»→`/market`, «Скиллы» убрать (операторская), «История»→`/wallet`, «Доход»→`/account`. Лента «Шаблоны недели» оставить (скрыта при 0). Это «командный центр» (обзор), но операции с деньгами не дублируем — кнопка «Пополнить» ведёт на `/wallet`.

- [ ] **Step 3: typecheck** → 0.
- [ ] **Step 4: Commit.**
```bash
git add apps/tg-miniapp/app/dashboard/page.tsx
git commit -m "feat(redesign-A): старый хаб → /dashboard (командный центр)"
```

---

### Task 3: CharCard — полная карточка-персонаж

**Files:**
- Create: `apps/tg-miniapp/src/components/CharCard.tsx`
- Modify: `apps/tg-miniapp/app/globals.css` (классы `.cc-*` в конец)

- [ ] **Step 1: Прочитать дизайнборд charCard** (компоновка/классы) и текущий AgentCard (hueFor, holo, портрет/видео).
Run: `grep -n "charCard\|ctrait\|cstats\|cname\|crole\|mbadge" docs/wireframes/design-board.html | head`

- [ ] **Step 2: Создать CharCard.tsx.** Пропсы (интерфейс — фиксируем имена, используются в Task 4/5):

```tsx
export interface CharCardProps {
  href: string;
  hue: number;
  name: string | null;
  portraitImage?: string | null;   // как в AgentCard
  portraitVideo?: string | null;
  modelBadge?: string | null;      // "GPT-5.5"
  role?: string | null;            // "Контент-редактор"
  author?: string | null;          // "@ainews" | "официальный"
  trait?: string | null;           // строка-характер (ctrait) — ОБЯЗАТЕЛЬНО рендерить если есть
  live?: boolean;                  // live-дот
  stats?: { runs?: string; rating?: string; price?: string }; // mono, демо метить отдельно (demo?: boolean)
  demoStats?: boolean;
  actionLabel?: string;            // "Арендовать · 150 кр/мес" | "Использовать"
  onAction?: () => void;           // если нет — карточка просто Link
  compact?: boolean;               // вариант для инбокса
}
```
Разметка: портрет (как в AgentCard: video/img/монограмма + holo `::before/::after` уже в globals) + live-дот (`.cc-live` пульс) → `.cc-name` + `.cc-badge` → `.cc-role` + автор → `.cc-trait` (характер) → `.cc-stats` (runs·★·price, mono, демо-метка) → `.cc-action` (амбер-кнопка, если actionLabel). Числа — `var(--font-mono)`/класс `tma-mono`.

- [ ] **Step 3: Классы `.cc-*` в globals.css** на токенах (без hex): `.cc-name`, `.cc-badge`, `.cc-role`, `.cc-author`, `.cc-trait` (color var(--ink-muted), italic-нет, line-clamp 2), `.cc-stats`/`.cc-stat`/`.cc-stat-v` (mono tabular-nums), `.cc-live` (@keyframes использовать существующий aiag-pulse-dot), `.cc-action`, `.cc-demo` (мелкая метка «демо» var(--ink-faint)). Переиспользовать существующие holo-классы портрета.

- [ ] **Step 4: typecheck** → 0.
- [ ] **Step 5: grep-verify.** Run: `grep -c "cc-trait\|cc-stats" apps/tg-miniapp/src/components/CharCard.tsx` → ≥2.
- [ ] **Step 6: Commit.**
```bash
git add apps/tg-miniapp/src/components/CharCard.tsx apps/tg-miniapp/app/globals.css
git commit -m "feat(redesign-A): CharCard — полная карточка-персонаж (характер+статы+автор+live)"
```

---

### Task 4: Маркет — витрина агентов (re-skin templates)

**Files:**
- Modify: `apps/tg-miniapp/app/market/page.tsx`

- [ ] **Step 1: Прочитать** текущий market/page.tsx (он сейчас каталог моделей) + templates/page.tsx (контракт `GET /api/tma/templates?sort=`) + CatalogNav.

- [ ] **Step 2: Переписать `/market`** в витрину агентов: client component, `GET /api/tma/templates?sort=trending` (Bearer), рендер `CharCard` (hue=hueFor(id), name, modelBadge=model_slug, role=description, author='официальный'/author handle, trait — пока из description-хвоста или пусто, stats={runs: clone_count, rating: avg_rating, price: priceLabel}, actionLabel = price?`Арендовать · ${fmtCredits} кр`:`Использовать`). Сегмент-бар сверху: «Агенты» активен; «Модели·Скиллы·MCP·Тузы·Базы» — **заблокированные** пункты с пилюлей «для операторов» (не Link, `aria-disabled`). Поиск + чипы-категории (визуальные, фильтр клиентский по name/role). Eyebrow «Маркет», h1 «Агенты». Скелетоны + честный empty («Каталог пока пуст — скоро появятся официальные агенты»).

- [ ] **Step 3: Действие карточки.** «Использовать» (free) → POST `/api/tma/templates/[id]/clone`; «Арендовать» (платный) → POST `/api/tma/templates/[id]/rent`; при успехе → router.push('/agents') (агент в инбоксе). 402 → ссылка на /wallet. (Переиспользовать паттерн из templates/[id]/page.tsx.)

- [ ] **Step 4: typecheck** → 0.
- [ ] **Step 5: Commit.**
```bash
git add apps/tg-miniapp/app/market/page.tsx
git commit -m "feat(redesign-A): Маркет = витрина агентов-персонажей (CharCard, rent/use → инбокс)"
```

---

### Task 5: Агенты — мессенджер-инбокс

**Files:**
- Modify: `apps/tg-miniapp/app/api/tma/agents/route.ts` (last-run превью)
- Modify: `apps/tg-miniapp/app/agents/page.tsx`

- [ ] **Step 1: Прочитать** `GET /api/tma/agents` route — есть ли уже последний прогон/время.

- [ ] **Step 2: Расширить `GET /api/tma/agents`** полями для инбокса (LEFT JOIN LATERAL последний agent_run):
```sql
SELECT a.id::text, a.name, a.template_kind, a.model_slug, a.description,
       a.budget_credits_monthly::text AS budget,
       r.output AS last_output, r.created_at AS last_at, r.status AS last_status
FROM agents a
LEFT JOIN LATERAL (
  SELECT output, created_at, status FROM agent_runs
  WHERE agent_id = a.id ORDER BY created_at DESC LIMIT 1
) r ON true
WHERE a.tg_user_id = ${tgUserId}::bigint AND a.status != 'deleted'
ORDER BY COALESCE(r.created_at, a.created_at) DESC
```
Вернуть массив с `last_output`/`last_at`/`last_status`. Prepared, без секретов.

- [ ] **Step 3: Переписать `/agents/page.tsx`** в инбокс: client component, `GET /api/tma/agents`, рендер строк-диалогов (`.inbox-row`): портрет-монограмма/character + имя + время (last_at, ru-RU) + превью (last_output, обрезка ~60 симв или «ещё не запускался»). Тап по строке → `router.push('/agents/'+id)` (существующий detail). Секция «Группы» — карточка-заглушка с пилюлей «скоро». Empty (0 агентов): «У тебя пока нет агентов» + амбер-CTA «Взять в Маркете →» → `/market`. Скелетоны. Сохранить auth-гейт + BottomNav.

- [ ] **Step 4: Классы `.inbox-*`** в globals.css (строка, аватар, превью-текст с line-clamp, время mono).

- [ ] **Step 5: typecheck** → 0.
- [ ] **Step 6: Commit.**
```bash
git add apps/tg-miniapp/app/api/tma/agents/route.ts apps/tg-miniapp/app/agents/page.tsx apps/tg-miniapp/app/globals.css
git commit -m "feat(redesign-A): Агенты = мессенджер-инбокс (последний ответ + группы-заглушка)"
```

---

### Task 6: Кошелёк (`/wallet`)

**Files:**
- Create: `apps/tg-miniapp/app/wallet/page.tsx`

- [ ] **Step 1: Собрать `/wallet`** из существующего profile/page.tsx money-части: баланс (mono, fmtCredits), CTA «Пополнить» → `/profile/topup` (топап-страницу НЕ трогаем в A), история движений (леджер `/api/tma/ledger` + незачисленные topups), привязанные кошельки + ton-proof статус (перенести логику wallet/link + proof-payload из profile). Eyebrow «Кошелёк». Один амбер-primary («Пополнить»).

- [ ] **Step 2: typecheck** → 0.
- [ ] **Step 3: Commit.**
```bash
git add apps/tg-miniapp/app/wallet/page.tsx
git commit -m "feat(redesign-A): /wallet — баланс + пополнить + леджер + кошельки"
```

---

### Task 7: Аккаунт (`/account`)

**Files:**
- Create: `apps/tg-miniapp/app/account/page.tsx`

- [ ] **Step 1: Собрать `/account`:** профиль (Telegram имя/аватар из useAuth/initData), **тариф** — строка «Тариф: Шара» + заблокированная «Оператор · скоро» (фаза 2), доход автора (если есть templates — `GET /api/tma/me/author-income`, иначе скрыть), согласия 152-ФЗ/ToS (статичные ссылки/чекбоксы read-only), «Выход» (очистить токен из CloudStorage/localStorage → редирект на онбординг). Eyebrow «Аккаунт».

- [ ] **Step 2: typecheck** → 0.
- [ ] **Step 3: Commit.**
```bash
git add apps/tg-miniapp/app/account/page.tsx
git commit -m "feat(redesign-A): /account — профиль + тариф + доход + согласия + выход"
```

---

### Task 8: Миграция/редиректы старых роутов (убить дубли)

**Files:**
- Modify: `apps/tg-miniapp/app/profile/page.tsx`, `app/templates/page.tsx`, `app/skills/page.tsx`
- Modify: `apps/tg-miniapp/src/components/CatalogNav.tsx` (если ещё используется — иначе удалить импорты)

- [ ] **Step 1: `/profile`** → редирект на `/wallet`: заменить тело на `import { redirect } from 'next/navigation'; export default function(){ redirect('/wallet'); }` (или client `useRouter().replace`). `/profile/income` → `/account` (или оставить, вход из /account).
- [ ] **Step 2: `/templates`** → редирект на `/market`.
- [ ] **Step 3: `/skills`** → заглушка «для операторов · скоро» (или редирект на /market с активным заблок-сегментом).
- [ ] **Step 4: Вычистить CatalogNav** (старые сегменты Шаблоны/Модели/Скиллы) — заменён сегмент-баром внутри /market. Удалить мёртвые импорты/ссылки. grep на дубли-имена: `grep -rn "Готовые агенты\|>Маркет<" apps/tg-miniapp/app` → пусто.
- [ ] **Step 5: typecheck** → 0.
- [ ] **Step 6: Commit.**
```bash
git add apps/tg-miniapp/app/profile apps/tg-miniapp/app/templates apps/tg-miniapp/app/skills apps/tg-miniapp/src/components/CatalogNav.tsx
git commit -m "fix(redesign-A): миграция старых роутов в новую IA, убрать дубли"
```

---

### Task 9: Деплой + прод-верификация

- [ ] **Step 1: Финальный typecheck** обоих приложений → 0.
- [ ] **Step 2: Push + CI-деплой tma** (`gh workflow run … -f ref=… -f apps=tma`), дождаться build success.
- [ ] **Step 3: Ручной рестарт** (aiag-deploy): `ssh aiag-vps 'set -a;. /srv/aiag/shared/.env;set +a; pm2 restart tma --update-env && pm2 save'`; health 200.
- [ ] **Step 4: Прод-верификация:** 5 табов в бандле; `/market` отдаёт CharCard; `/agents` инбокс; `/dashboard`/`/wallet`/`/account` 200; старые `/templates`→редирект; grep дублей пусто; `df -h /` < 80% (почистить релизы при нужде — см. infra-память).
- [ ] **Step 5: Обновить дашборд** (`docs/DASHBOARD.html`) — статус редизайна-A, и сводку фазы в `.planning/`. Commit + push.

---

## Self-Review (план vs спека)
- ✅ 5 табов (Task 1) · границы Дэшборд/Кошелёк/Аккаунт (Task 2/6/7) · charCard с характером+статами (Task 3) · Маркет re-skin templates + операторские заблок-сегменты (Task 4) · инбокс + last-answer + группы-заглушка (Task 5) · use/rent → инбокс (Task 4) · миграция роутов без дублей (Task 8) · деплой+верификация (Task 9).
- Типы: `CharCardProps` определён в Task 3, используется в Task 4/5 — имена согласованы.
- Плейсхолдеров нет (открытый вопрос инбокс-превью решён в Task 5 Step 2 конкретным SQL).
- Контент-посев официальных агентов — НА ОСНОВАТЕЛЕ (вне плана), без него Маркет честно-пуст.
