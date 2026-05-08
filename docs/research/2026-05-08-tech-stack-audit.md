# AIAG — Аудит технического стека на 2026-05-08

**Контекст:** перед стартом фаз 14/15/17 проверяем актуальность стека: deprecated / breaking / лучшие альтернативы.
**TL;DR:** 90% стека правильный для мая 2026. Главные точки внимания — `NextAuth` (миграция на Better Auth), `BullMQ` (норм, но Inngest стоит рассмотреть), `TON Connect` (риск с React 19), `Hermes Agent` (уже v0.12, не v0.10) и стратегическое решение по `Vercel AI SDK 6` для Phase 17.

---

## 1. Web app (Next.js 16 + React 19 + Tailwind 4)

**Состояние:** актуально. Next.js 16 — текущий стабильный релиз, на момент аудита — 16.2 (март 2026). React 19.2 интегрирован, поддержка React Compiler промоутнута из experimental в stable. Turbopack теперь дефолт и для `next dev`, и для `next build`. Tailwind 4 шипится в `create-next-app` шаблоне — пара официально благословлена.

**Breaking за 6-12 месяцев:**
- Babel удалён из дефолта — миграции codemod-ом, иначе +40% к bundle size.
- Adapters API стабилизирован — это для платформ, нас не трогает.
- Cache Components (PPR + `use cache`) — новая модель кеширования, миграция с `unstable_cache`. Если используем — стоит проверить через `vercel:next-cache-components` skill.

**Совместимость пар:** Next 16 + React 19 + Tailwind 4 — golden path, проблем нет. shadcn/ui официально поддерживает связку (страница `ui.shadcn.com/docs/react-19`).

**shadcn vs альтернативы:** shadcn остаётся доминирующим в 2026. Park UI — нишевый (Panda CSS, средние отзывы), Origin UI — упоминается как flexible но без масштабной адопции. **Keep shadcn.**

**Действие:** убедиться, что прогнали codemod `next-codemod@latest`. Проверить, не висит ли `unstable_cache` в коде — мигрировать на `use cache` директиву.

---

## 2. Gateway (Bun + Hono)

**Bun:** актуальный 1.3 (февраль 2026), 4-месячная каденция (1.0 март 2025 → 1.1 июль → 1.2 ноябрь → 1.3 февраль 2026). Production-ready, ~98% npm-совместимость, тысячи компаний в проде. Преимущества вашего use-case (gateway, SSE streaming, короткие запросы): cold start 8-15ms против 40-120ms у Node, ~26% меньше RAM. Caveat — длинные процессы (72+ часов) исторически проблемны для GC; Node 24 более проверен. Для VPS с 2GB RAM Bun реально оправдан.

**Hono:** 4.12.16 (апрель 2026). 4.12.12 закрыл 2 уязвимости — cookie prefix bypass (CVE-2026-39410) и path traversal в `toSSG()` (CVE-2026-39408). Если используете SSG — **обновитесь немедленно**. Регулярных breaking changes в 4.x нет, минорные релизы аддитивные.

**HonoX (мета-фреймворк):** всё ещё alpha (v0.1.55). Не нужен — у вас Next отдельно.

**ioredis + pg:** проверенные, без шума за год. Bun 1.3 работает с обоими нативно, регрессий нет.

**Альтернатива — Vercel AI SDK 6 с Hono:** SDK 6 (декабрь 2025) — унифицированный API на 25+ провайдеров, MCP support, agents, observability. Совместим с Hono через `streamText()` и `hono.stream()` — есть официальный пример `leerob/hono-vercel-ai-sdk`. **Стратегическая рекомендация:** для Phase 17 (агенты) рассмотреть AI SDK 6 как абстракцию над провайдерами вместо custom-кода. Это убирает много кода роутинга/повторов, даёт MCP из коробки.

**Действие:**
1. Pin Hono ≥ 4.12.12 (security).
2. Bump Bun до 1.3.13+ (актуальная patch-версия).
3. Phase 17 spike: попробовать AI SDK 6 + Hono как альтернатива custom HTTP-клиентам.

---

## 3. Database (PostgreSQL 16 + Drizzle)

**PG 16:** стабилен, security-only режим до ~2027. Однако **PG 17 (сентябрь 2024) и PG 18 (сентябрь 2025) уже стабильны**. На май 2026 актуальные patch-версии: 18.3, 17.9, 16.13, 15.17. Для нового проекта дефолт — 17 LTS. У вас bare-metal, миграция = `pg_upgrade --link`, минут 5 даунтайма. PG 17 даёт: incremental backups, оптимизации vacuum, JSON path expressions, лучше партишнинг (детачи без лока).

**Партиционирование `requests` by created_at (monthly):** PG 17 заметно улучшил `ATTACH/DETACH PARTITION` без полного лока — для retention процедуры это плюс.

**Drizzle ORM:** v1 стабилен с начала 2026. Партиционированные таблицы поддерживаются в **introspection** (читаются как обычные), но **declarative partition definition в schema файле — НЕ поддерживается** (issue #2854 открыт с августа 2024). Текущий workaround: генерируете миграцию SQL-файлом и редактируете руками — что вы и делаете. Это нормально для production, не блокер.

**PG 18 caveat:** есть отчёт `Postgres 18 upgrade breaks drizzle-kit push not-null` — если двинетесь на 18, оставайтесь на ручных миграциях, не на `drizzle-kit push`.

**Stored functions (`aiag_settle_charge`):** Drizzle их не "видит" но вы и не хотите — вы их вызываете через raw SQL. Это правильный паттерн.

**Drizzle vs альтернативы:** в 2026 Drizzle обогнал Prisma по новым проектам, npm trends 1.9M vs 3.8M (Prisma), но рост у Drizzle. Performance: Drizzle ~12% overhead vs raw SQL, Prisma ~29%. Bundle 5KB vs 40KB. **Keep Drizzle.** Kysely — для тех, кто хочет 0-абстракции, у вас уже Drizzle и это правильный выбор.

**Действие:**
1. План на `pg_upgrade` 16 → 17 в Phase 16 (после фаз 14/15).
2. Не апгрейдить на 18 пока не починят `drizzle-kit push`.
3. Партишнинг — оставить ручные SQL-миграции (там, где Drizzle не справляется).

---

## 4. Infrastructure

**Ubuntu 24.04 LTS:** актуально до 2029, security до 2034. **Keep.**

**Nginx 1.24:** mainline уже 1.27/1.28 на май 2026, но 1.24 это stable branch с long-term поддержкой. Обновитесь до **1.26 stable** (выпущен апрель 2024, security patches активные). 1.24 не deprecated, но более свежие исправления уязвимостей в 1.26.

**pm2 + systemd:** проверенно, 0 рисков. **Keep.** Альтернатива на 2026 — у Bun свой `bun --watch` для dev и process management через systemd напрямую (без pm2). Если уйдёте полностью на Bun — pm2 необязателен.

**Мониторинг (node_exporter + postgres_exporter):** standard, поддержка активна. **Keep.**

**CI/CD (GitHub Actions → SSH rsync → atomic symlink):** классика, надёжно для одного VPS. Для k3s в Phase 17 — добавить шаг `kubectl apply` или ArgoCD.

---

## 5. Auth — главный риск

**Текущее: NextAuth.** В 2026 это **legacy путь**:
- Lucia Auth объявлена deprecated в марте 2025, превращена в educational resources.
- Сами мейнтейнеры Auth.js в 2026 направляют **новые** проекты на Better Auth.
- Auth.js v5 имеет смысл только для миграции existing codebase или если критичен широкий список enterprise SSO провайдеров.

**Better Auth (v1.x с начала 2025):**
- Framework-agnostic, ноль vendor lock-in.
- Из коробки: 2FA, passkeys, RBAC, organizations, impersonation, magic links.
- Сам управляет схемой БД, авто-миграции.
- Лучшая интеграция с Drizzle (vs NextAuth, где adapter тяжелее).
- Активная разработка в 2026.

**Clerk:** хорош для B2C под 50K MAU, но vendor lock-in, цена и российский рынок (санкции, оплата) — против.

**Рекомендация:** мигрируйте на **Better Auth** до Phase 14 если auth-логика будет расширяться (organizations, impersonation для админ-аккаунтов B2B). Если NextAuth уже работает и критичных гэпов нет — остаётесь, но новые auth-фичи в фазах 14-17 пишите в Better Auth-стиле, чтобы потом мигрировать одним подходом.

**Действие:** Phase 14 — спайк на Better Auth (1-2 дня), решение о миграции по итогу.

---

## 6. Background Jobs (BullMQ)

**Состояние:** валидно. BullMQ на 2026 остаётся лидером для self-hosted high-throughput сценариев когда у вас уже есть Redis (а у вас есть). Активная разработка, security-aware.

**Альтернативы:**
- **Inngest** — serverless-first, без Redis, лучший DX (replay, observability), generous free tier. Для российского B2B на VPS — overkill и зависимость от внешнего SaaS.
- **Trigger.dev** — managed, отличная observability, многошаговые AI workflows. Платный сервис, для AI/LLM-tasks хорош, но vendor.
- **Hatchet** — open-source, можно self-host, durable workflows. Появился в 2025-2026 как претендент.

**Для Phase 17 (Hermes agents):** Trigger.dev/Inngest заметно лучше, чем BullMQ, для long-running AI workflows со step retries и дебагом. НО — оба managed/SaaS, для российского рынка проблемно. **Hatchet self-hosted** — компромисс: дайте ему spike в Phase 17, если планируете multi-step agent runs.

**Действие:**
1. Для текущих background jobs (вебхуки, биллинг, отчёты) **keep BullMQ**.
2. Для Phase 17 long-running agent runs — спайкнуть Hatchet self-hosted либо принять, что у Hermes своя оркестрация (Kanban в v0.12).

---

## 7. Phase 15 — Telegram Mini App

**SDK:** `@telegram-apps/sdk-react` v3.3.9 — это правильный выбор на 2026. Старый `@twa-dev/sdk` deprecated (теперь это `@tma.js/*` → `@telegram-apps/*`). Используйте именно `@telegram-apps/sdk-react`, не `@twa-dev/*`.

**TON Connect:** `@tonconnect/ui-react` 2.4.4 (свежая, 23 дня). **КРАСНЫЙ ФЛАГ:** issue #290 в репо — *"Doesn't work on Next.js 15 with React 19"*. У вас Next 16 + React 19. До Phase 15 — обязательно проверить, что патч прилетел в ≥2.4.x; если нет — TON Connect нужен в **отдельной части бандла** (например, dynamic import + 'use client'), либо ждать апдейта от ton-connect.

**Telegram Stars:**
- Currency tag `XTR`, `provider_token` пустой в `sendInvoice`/`createInvoiceLink`.
- **Effective fee ~32% на mobile** (Apple/Google cut) + 21-day withdrawal hold. Это важно для unit economics — ваша B2B-маржа должна это покрыть.
- API стабилен, breaking-changes в 2025-2026 не было — только аддитивные (Star subscriptions).

**Дизайн:** ваш dark+amber + Inter/JetBrains — нормально для Mini App, не противоречит TG guidelines (TG не диктует тему). Альтернативно — `@telegram-mini-apps-dev/TelegramUI` если хотите native-feel, но это компромисс с брендингом AIAG.

**Действие:**
1. Перед стартом Phase 15 — спайк на Next 16 + React 19 + `@tonconnect/ui-react` 2.4.4 на 2 часа, проверить SSR/hydration. Если красные ошибки — изоляция в client-only chunk.
2. Просчитайте unit economics с учётом 32% TG Stars commission.

---

## 8. Phase 17 — Hermes Agent + k3s + MCP

**Hermes Agent — версия:** в задании указано **v0.10.0**. Актуальная на 2026-05-07 — **v0.12.0** (Tenacity Release: durable Kanban, /goal, Checkpoints v2, gateway auto-resume). v0.11.0 (23 апреля) — Interface release, React/Ink CLI, AWS Bedrock, GPT-5.5 via Codex OAuth, 17 messaging platforms. **Релизная каденция ~1 раз в неделю.** Для production-планирования — заклядывайте быстрое обновление, pin major.minor, но не patch.

**Стабильность Hermes:** активный maintenance, MIT, Nous Research серьёзный игрок. Risk низкий. v0.12 наконец дала "durable agent state" что было main pain в 0.10 — **обязательно стартуйте с 0.12+**.

**MCP в 2026:** spec обновлён, стандартизирован OAuth 2.1 как foundation, обязательны Resource Indicators (RFC 8707) для предотвращения token confusion attacks, поддержка role-based authz (`@RolesAllowed`-style annotations). Anthropic, OpenAI, Cloudflare — все интегрировали. AI SDK 6 имеет full MCP support. **Используйте OAuth 2.1 + Resource Indicators с самого начала** — иначе security долг.

**Альтернативы Hermes для managed-agent:**
- **Mastra** — TypeScript-first, built-in memory, RAG, workflows, Next.js integration. Если ваш стек TS-first и хотите всё-в-одном — это сильнейший выбор. Self-hostable (Hono/Express/Fastify deployers).
- **LangGraph** — Python-first ecosystem; на TS меньше сообщества; не работает в serverless.
- **Vercel AI SDK 6 Agents** — простой single-agent + tools; для сложных multi-agent графов слабее.
- **OpenAI Agents SDK** — vendor lock.

**Решение по Hermes vs Mastra:** Hermes — это **готовый агент-продукт (CLI + UI)**, Mastra — **фреймворк для построения агентов**. Если AIAG предоставляет per-user agent как managed feature — Hermes ставится "под ключ". Если строите кастомных агентов под B2B-задачи (workflow для маркетинга, аналитики) — Mastra сильнее.

**k3s vs альтернативы для per-user pods:**
- **k3s** — single binary, lightweight, на VPS с 2GB заведётся. Для 100+ юзеров — нужен будет multi-node.
- **Nomad** — проще K8s, но в 2026 экосистема сжимается ("Nomad is dead" — мнение, но плагины/operators явно реже выходят).
- **Fly Machines** — managed, isolated VMs, идеален для per-user agent boxes; проблема — оплата из РФ.
- **Modal.com** — managed serverless для AI, удобно, но vendor + RU-payments.

Для российского B2B и self-host: **k3s остаётся правильным выбором**. На 2GB VPS — k3s OK для proof-of-concept, на проде нужен второй узел или upgrade RAM. Альтернатива — Docker + systemd (без оркестратора) если per-user pods — это 1-2 контейнера на user, и масштаб <50 активных.

**7-day idle hibernate / 90-day archive:** k3s сам по себе hibernate не делает — нужно строить через CronJob + custom controller, или использовать `kube-green` operator. Заложите время.

**Действие:**
1. **Использовать Hermes 0.12.x**, не 0.10.0.
2. MCP — OAuth 2.1 + Resource Indicators с первого дня.
3. Спайкните Mastra параллельно Hermes — возможно, для AIAG-специфичных агентов (B2B marketplace) Mastra-as-framework окажется правильнее, чем Hermes-as-product.
4. k3s — keep, но запланируйте 4GB RAM минимум для multi-tenant.

---

## Action Items

| Компонент | Текущее | Рекомендация | Что делать |
|---|---|---|---|
| Next.js 16 + React 19 + Tailwind 4 | актуально | **keep** | Прогнать codemod, проверить `unstable_cache` → `use cache` |
| shadcn/ui | актуально | **keep** | — |
| Bun 1.3.13 | актуально | **keep, bump** | Pin последний 1.3.x patch |
| Hono 4.x | актуально | **upgrade** | Pin ≥ 4.12.12 (CVE security fixes) |
| ioredis / pg | актуально | **keep** | — |
| BullMQ | актуально | **keep** | Для Phase 17 long-running — спайк Hatchet |
| PostgreSQL 16 | OK, но устаревает | **upgrade plan** | Phase 16 → PG 17 LTS (`pg_upgrade --link`); НЕ 18 пока drizzle-kit push сломан |
| Drizzle ORM v1 | актуально | **keep** | Партиции — ручные SQL-миграции (issue #2854 открыт) |
| Nginx 1.24 | старый stable | **upgrade** | До 1.26 stable |
| pm2 | актуально | **keep** | — |
| **NextAuth** | legacy в 2026 | **replace** | Спайк Better Auth в Phase 14, миграция при следующем расширении auth |
| @telegram-apps/sdk-react 3.3.9 | актуально | **keep** | — |
| @tonconnect/ui-react 2.4.4 | риск с React 19 | **verify** | Спайк на совместимость Next 16 + React 19 ДО Phase 15 |
| Telegram Stars API | актуально | **keep** | Учесть 32% mobile fee + 21d hold в unit economics |
| **Hermes Agent v0.10.0** | **устарело** | **upgrade** | Использовать v0.12.0 (Tenacity), pin major.minor только |
| MCP | spec эволюционирует | **adopt 2026 spec** | OAuth 2.1 + Resource Indicators (RFC 8707) с первого дня |
| k3s | актуально для self-host | **keep** | Запланировать 4GB+ RAM; `kube-green` для idle hibernate |
| **Vercel AI SDK 6** | не используется | **evaluate** | Phase 17 — спайкнуть как layer над провайдерами + MCP support |
| **Mastra** | не используется | **evaluate** | Phase 17 — рассмотреть как агент-фреймворк vs Hermes-as-product |

---

## Приоритеты до старта Phase 14

1. **Сегодня:** Hono → 4.12.12+, Bun pin, Hermes планировать на 0.12+.
2. **До Phase 14:** Better Auth спайк (1-2 дня).
3. **До Phase 15:** TON Connect + Next 16 + React 19 совместимость спайк (2 часа).
4. **До Phase 17:** Mastra vs Hermes решение, AI SDK 6 spike, MCP OAuth 2.1 архитектурное решение.
5. **Phase 16+:** PostgreSQL 17 миграция, Nginx 1.26.

Стек в целом — правильный для мая 2026. Главный реальный риск — застарелые версии (Hermes 0.10 → 0.12, Hono CVE) и одно стратегическое решение по auth (NextAuth → Better Auth).
