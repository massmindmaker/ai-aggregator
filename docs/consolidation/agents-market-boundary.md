# Agents Market: граница извлечения из `aggregator/core`

Дата исследования: 2026-09-06. Режим: только чтение, без сборок и правок исходников.

## Вывод

Agents Market уже имеет естественную продуктовую границу: рабочая Telegram Mini App и
исполнитель находятся в `apps/tg-miniapp` и `apps/agent-worker`. Они используют свой
JWT/Telegram вход, очереди Redis и raw `postgres`, а не NextAuth или Drizzle пакета
агрегатора. Это позволяет вынести продукт как отдельный монорепозиторий с
`apps/tma`, `apps/web`, `apps/worker` и минимальным `packages/common`.

Однако «apps/web» не следует переносить из текущего дерева: маршруты
`/agentmarket` были окончательно удалены коммитом `a0948bf` (2026-07-18). Последняя
реальная веб-витрина находится в `fba98da` и была только публичной read-only
витриной, не полноценным web-клиентом TMA. Непроиндексированный `core/tma/` тоже не
кандидат на перенос: это чистый create-next-app-скелет Next 16/React 19 с двумя
заглушками, не зрелый TMA.

Канон `docs/canon/AIAG-CANON.md` фиксирует, что отдельный private repo
`massmindmaker/agent-market` уже создан и деплоит TMA; он также предписывает не
удалять и не объявлять legacy-ветку монорепо устаревшей без отдельного решения
основателя. Следовательно, безопасный первый cutover — добавить/синхронизировать
новую структуру в отдельном repo и оставить `core` в рабочем состоянии до
подтверждённого переключения деплоя.

## Точные исходные границы

| Цель в новом repo | Источник в `core` | Состояние |
|---|---|---|
| `apps/tma` | `apps/tg-miniapp/` | Полный рабочий Next 14.2.33 TMA на порту 3100, basePath `/tg`. |
| `apps/worker` | `apps/agent-worker/` | Полный BullMQ worker на порту 3101: runs, scheduler, top-up/member reconciler, payouts. |
| `apps/web` | историческое дерево из `fba98da:apps/web/src/app/(marketing)/agentmarket/**`, `components/agentmarket/**`, `lib/agentmarket/catalog.ts` | Только публичная витрина списка и детали; в current tree её нет. |
| `packages/common` | узкие части `packages/shared/src/{safe-fetch,startonus}.ts` и дублируемый `apps/tg-miniapp/src/lib/safe-fetch.ts` | Нужны TMA/worker; не переносить весь `@aiag/shared` с S3/AWS и налоговым кодом. |
| `db-schema-reference/` | миграции ниже + фактически используемые SQL-запросы TMA/worker | Канон уже задаёт raw `postgres`, без `@aiag/database`. Это reference/ownership boundary, не новая ORM. |

Не переносить в первый срез: `apps/web` текущего агрегатора целиком,
`packages/api-gateway`, `packages/email`, `telegram-alerts`, Tinkoff/YooKassa,
маркетплейс моделей, contests, NextAuth/Stack auth, административные страницы и
Drizzle package.

## TMA: маршруты и аутентификация

UI-маршруты (`apps/tg-miniapp/app`):

```
/                         /dashboard                 /account
/agents                  /agents/new                 /agents/[id]
/agents/[id]/kanban      /agents/[id]/offer
/market                  /market/[slug]
/templates               /templates/[id]
/wallet                  /profile                    /profile/income
/profile/topup           /membership                 /schedules
/skills                  /mcp-oauth                  /mcp-oauth/callback
/health
```

API под `/tg/api/tma` (Next `basePath: '/tg'`): auth, agents (CRUD/run/hire,
publish, kanban, schedules, transfer/iNFT, MCP OAuth), marketplace, templates
(create/rent/rate), wallet/TON proof, topup/ledger, membership purchase/status/
webhook, provider catalog, skills, Hermes catalog and author income/payout.

Аутентификация полностью продуктовая:

* `POST /tg/api/tma/auth/verify` проверяет Telegram `initData` через
  `TELEGRAM_BOT_TOKEN`, upsert-ит `tg_users`, выдаёт HS256 JWT (issuer
  `aiag-tma`, audience `aiag-gateway`, 24h) с секретом `TMA_JWT_SECRET`.
* `middleware.ts` защищает `/api/tma/**`, pin-ит HS256, проверяет revoke list
  в Redis и после проверки единолично ставит `x-tma-user-id`. Входной spoofed
  header удаляется.
* Публичные исключения: auth, OAuth callback, public marketplace, transfer
  offer read и callbacks webhook; последние дополнительно защищаются секретом/
  инфраструктурной allowlist по комментариям к коду.
* Клиентский `useAuth` хранит JWT в Telegram CloudStorage и шлёт Bearer token.

Значит TMA не связан с `apps/web/src/auth.ts`, NextAuth, Stack или web-user
cookies. Его перенос блокируют не auth-сервисы агрегатора, а только корректная
передача собственного Telegram/JWT/Redis/DB config.

## Бывшая веб-витрина `/agentmarket`

В `fba98da` существовали только:

```
/agentmarket             public dynamic list (до 100 public templates)
/agentmarket/[id]        public template detail
```

Серверный `catalog.ts` выполнял parameterized SQL над `agent_templates`,
`template_ratings`, `tg_users`, выбирая только safe fields. Он не создавал HTTP
API, не требовал сессии и не читал `agents` (где находятся prompt/ключи/PII).
Деталь давала только Telegram deep link. В `a0948bf` удалены route, component,
catalog и ссылка меню; поэтому на текущем HEAD нет ни `/agentmarket`, ни
связанного API/auth coupling.

Для нового `apps/web` безопаснее восстановить именно этот маленький срез из
`fba98da` и заменить его старые aliases/layout/UI на локальные компоненты.
Не переносить всю старую `apps/web`: её `package.json` требует database, email,
alerts, Tinkoff, YooKassa, NextAuth и прочие агрегаторные зависимости, хотя
сама витрина ими не пользовалась.

## Реальные зависимости и препятствия standalone build

`apps/tg-miniapp` уже почти независим: `next@14.2.33`, React 18, Telegram SDK,
TON/TON Connect, Redis/BullMQ, `jose`, `postgres`; внутренние aliases `@/` смотрят
только на его `app/` и `src/`. Внешние imports только:

* `@aiag/shared/client` — `tonToNano` в membership UI;
* `@aiag/shared` — `generateInvoice`, `tonToNano` в membership/transfer routes;
* код SSRF guard частично дублируется с shared.

`apps/agent-worker` имеет `postgres`, BullMQ/Redis, TON packages и MCP SDK. Он
импортирует `@aiag/shared` только в `src/safe-fetch.ts`; остальное локально.
Оба приложения используют raw `postgres(process.env.DATABASE_URL, {prepare:false})`
и SQL tagged templates. Это не импортная связь с `@aiag/database`.

Невыносимые без явного контракта runtime coupling:

1. Worker для AIAG-моделей вызывает локальный `http://127.0.0.1:4000/v1/chat/completions`
   с `AIAG_GATEWAY_KEY`; fallback использует OpenRouter. Это должен быть внешний
   provider contract, URL/key — конфигом, не перенос `api-gateway`.
2. TMA ai-builder тоже обращается к gateway/OpenRouter; provider catalog в DB
   связан с gateway tables (`ai_models`, `model_upstreams` и provider migrations).
3. Общая Postgres схема ещё включает gateway-owned `users`, `organizations` и
   `gateway_api_keys`; migration `0060_tma_own_org` создаёт отдельную
   organization/key для AM, но не делает AM DB независимой. Отдельная AM DB
   требует либо копии model/provider catalog, либо versioned API gateway catalog.
4. Redis нужен и TMA (replay/revocation/rate limits), и worker queues/reconcilers.
5. Третьи стороны остаются config dependency: Telegram bot, TON Center/TON API,
   Startonus, Hermes control-plane, MCP remote endpoints.

## Миграции: что принадлежит Agents Market

Переносить в `db-schema-reference/migrations` как последовательный baseline
все AM-таблицы/изменения, а не выдёргивать только финальные CREATE:

* 0016 `tg_users`; 0017 NFT collections/purchases; 0018 `agents`, `agent_runs`;
  0019 TON wallets/balance/topups; 0020 daily budget; 0021/0022/0027 external
  connection/key hint; 0023 agent memory; 0028 MCP.
* 0029 credit ledger conversion; 0031 templates; 0032 rentals; 0033 ratings;
  0034/0035 schedules; 0036 skills; 0037 MCP OAuth.
* 0039 transfers; 0040 hire sessions/memory scope; 0041 rental subscription;
  0042 role models; 0043 USDT topups/author payouts; 0044 creator membership;
  0045 Hermes profile; 0046 transaction-hash dedup.
* 0048/0049/0052 membership purchases/hardening; 0050 Hermes connection type;
  0051 clone-count data correction; 0053 payment balance dedup; 0054 subscription
  tier columns only if AM continues to use shared `subscriptions`.

Shared/gateway prerequisites must be explicitly versioned as external schema/API
dependencies, not silently copied: gateway core `0004`, users/orgs and model
catalog/provider lineage (`0025`, `0026`, plus relevant upstream migrations),
credit conversion/settle function `0056`, `0058`, comments `0059`, AM own org
`0060`, cap-unit correction `0061`. 0057/0062+ are gateway operational policy,
not native AM ownership, but worker billing behavior is affected by them.

## Минимальная целевая раскладка

```
agent-market/
  apps/
    tma/                 # copy of apps/tg-miniapp
    web/                 # new thin public showcase; historical fba98da logic only
    worker/              # copy of apps/agent-worker
  packages/
    common/              # startonus, ton units, SSRF guard; no AWS/email/tax baggage
    typescript-config/   # or local root tsconfig equivalent
  db-schema-reference/
    migrations/          # AM baseline + explicit gateway prereq manifest
    README.md             # ownership, order, environment contract
  package.json
  turbo.json
```

Use a fresh root workspaces config and rename imports from `@aiag/shared` to
`@agent-market/common`. Keep `apps/tma` basePath `/tg` initially to retain
production URL compatibility. Make gateway host/key explicit env vars (with
the current localhost setting only a deployment default); do not encode secrets
or copy `.env` files.

## Initial verification after extraction

Run one heavy build at a time per workspace contract. From new repo root:

```bash
npm ci
npm run --workspace @agent-market/common type-check
npm run --workspace @agent-market/tma type-check
npm run --workspace @agent-market/worker test
npm run --workspace @agent-market/web type-check
npm run --workspace @agent-market/tma build
npm run --workspace @agent-market/worker build
npm run --workspace @agent-market/web build
```

Then run the existing worker contract tests (`billing-header-contract`,
`no-silent-openrouter-fallback`, `resolve-upstream`, `budget`) against the
configured gateway contract, and a controlled TMA smoke flow: Telegram initData
verify → protected `GET /tg/api/tma/agents` → public marketplace → enqueue one
non-billable/BYOK run. Do not point the first extraction build at production
credentials or deploy it; current overlap means deployment must switch only
after these checks and explicit rollout decision.

## Existing work deliberately left untouched

`git status` is broadly dirty. Within the investigated scope it includes many
modified tracked `apps/tg-miniapp`, `apps/agent-worker`, `packages/database`,
`packages/shared` and `apps/web` files, plus untracked `.worktrees/`,
`docs/roadmaps/`, `reports/`, `tma/`, `web/`, and a database test. No source,
index, generated output, untracked file or build artifact was changed by this
investigation.
