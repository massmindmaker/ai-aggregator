# AIAG — Project Context Anchor

> **КАНОН: `docs/canon/AIAG-CANON.md` — единственный источник истины. При конфликте побеждает он. Этот файл = тонкий якорь.**
> **⚠️ ОБЯЗАТЕЛЬНО сверяйся с каноном перед любой нетривиальной работой (продукт/модель/найм/Hermes/статус). Если recalled-память противоречит канону — побеждает канон, старую память пометить DEPRECATED→канон.**
>
> **КАРТА ПАМЯТИ (куда за чем):** продукт/модель → канон · код → Serena + graphify · ресёрч → LightRAG · сущности/связи → memgraph · быстрый факт → auto-memory `MEMORY.md` · дизайн → `DESIGN.md` + борды.

> **This file auto-loads every session.** It is the always-present "common denominator" so context is not lost between sessions.
> Detailed state: `.serena/memories/aiag_*.md`. Deploy: skill `aiag-deploy`. Never expose personal Telegram (@b0brov) in artifacts.

## SUITE TOPOLOGY (reorg 2026-08-22)
- **Канон-путь репо: `C:\Users\боб\projects\aggregator\core`.** Все пути в доках вида `apps/...`, `docs/...` отсчитываются отсюда.
- **Канон-ветка: `feat/r2-readiness`. Master заморожен** — история; не мержить/не пушить в master без явной команды основателя.
- **Зеркала read-only:** `C:\Users\боб\projects\aggregator\ai-aggregator` и `C:\Users\боб\projects\aggregator\agent-market\tma` (в доках кратко `../ai-aggregator`, `../agent-market/tma`). Только читать/навигировать; код и коммиты живут в `core`.
- Suite = **3 продукта**, не conflate:

| # | Продукт | Код | Деньги |
|---|---------|-----|--------|
| 1 | **AI-Aggregator (WEB)** — ai-aggregator.ru | `apps/web` + `packages/api-gateway` (`:4000`) | RUBLES (₽): Tinkoff + подписки + B2B org keys |
| 2 | **Agent-Market TMA** | `apps/tg-miniapp` (`:3100`) + `apps/agent-worker`; Web-App = `/agentmarket` внутри `apps/web` | Крипто-кредиты USD-peg: BIGINT микро-кредиты (миграции 0056/0058); ₽ из TMA убраны |
| 3 | **AI-Contest** | contests-роуты внутри `apps/web` + `apps/worker` (eval-sink) | Призовой фонд/судейство — открытые вопросы (черновик зоны 4 дашборда) |

## How to work here (read order)
- Behavior rules: @.claude/rules/coding-behavior.md
- Architecture & service map: @docs/ARCHITECTURE.md
- Security & money-path rules: @SECURITY.md
- Design/product (frontend): @PRODUCT.md
- Design system / tokens (single SoT): @DESIGN.md
<!-- ANIMATION.md and per-app CLAUDE.md load lazily (on UI work / on touching that app) — not imported, to save context. Status page for humans: docs/specs/STATUS.html -->

## THREE PRODUCTS in detail — never conflate them

### 1) Aggregator (WEB) — ai-aggregator.ru
- AI **models + agents marketplace for the RU market** + OpenAI-compatible API gateway (white-label, hides upstream brand).
- Code: `apps/web` (Next 14.x), `packages/api-gateway` (Hono/Bun, `:4000`).
- **Native egress integration (2026-08-22, ветка feat/native-egress-integration):** egress-прокси per-upstream (`model_upstreams.egress_proxy` > env `AIAG_EGRESS_PROXY_URL`; SOCKS5/CONNECT туннели в `api-gateway/src/proxy/`) + failover с circuit breaker (`routing/failover.ts`, `failover/breaker.ts`, персист БД 0064) + каталог-sync models.dev → черновики → `/api/admin/catalog/{diff,apply}` (0065). Частично перенесено из OmniRoute (MIT) — см. THIRD_PARTY_NOTICES.md.
- **Billing: RUBLES (₽) ONLY** — Tinkoff card pay + subscriptions + B2B org keys. No crypto.
- Entity: RF (ИП → производственный кооператив). IT 7.6%.
- Status: live; admin (Phase 14) live; marketplace ~80%; contests/supply deferred.

### 2) Agent-Market TMA — Telegram Mini App
- **Agents marketplace**: discover / run / create AI agents that live in Telegram.
- 3 ways to get an agent: **(a)** connect your own Hermes, **(b)** from a public template, **(c)** from scratch.
- An agent = a composable **SPEC**, not a prompt: persona (`SOUL.md`) + models (separate chat/image/voice/vision) + skills + tools + MCP servers + knowledge/memory + cron.
- Templates are **published, not sold**: public template shares the spec (model names, skills, tool/MCP defs WITHOUT keys), keeps private the keys/memory/data/history. Others clone the setup.
- Code: `apps/tg-miniapp` (Next 14.2.33, `:3100`), `apps/agent-worker` (BullMQ, `:3101`).
- **Billing: CRYPTO CREDITS, USD-peg — DONE (миграции 0056/0058).** Баланс = **BIGINT микро-кредиты** (1 кредит = 1¢ USD = 1000 микро); формула `costCredits = round(cents × markup × batch × caching × 1000)`, markup 1.8 на привязках модель↔апстрим; ₽ из TMA убраны целиком. Telegram **Stars = deferred — do NOT implement/show now** (founder 2026-06-03).
- Web-App версия маркетплейса = `/agentmarket` внутри `apps/web` (сейчас скрыта 404, код жив — см. `docs/specs/2026-07-15-agentmarket-web-hidden.md`).

### 3) AI-Contest
- Конкурсы агентов: таблицы + роуты + UI **live в web**, прод отвечает 200; eval-sink (`apps/worker`) — заглушка.
- Есть план выделения в отдельный продукт suite (стабилизация ядра → выделение → зеркала); открытые вопросы: призовой фонд, судейство (LLM-judge vs люди), интеграция с Agent-Market.
- Черновики зоны 4 дашборда: `docs/DASHBOARD.html` → вкладка `contest`.
- **Legal/compliance: NOT factored now** (founder 2026-06-03). Working structure: a separate **non-RF foreign entity buys models FROM the AIAG aggregator** (as an RF provider's customer); crypto/USDC + $-billed compute sit on the foreign entity. Revisit compliance later (synthesis FD-2/FD-3).

## HERMES — the intended core, but NOT built yet (read this before any agent-runtime work)
- Hermes = **`NousResearch/hermes-agent`** — an open-source AI-AGENT **RUNTIME** (MIT, v0.15.2). **It is NOT a model.**
- **РЕШЕНИЕ 2026-06-12: КУРС НА РЕАЛЬНЫЙ Hermes.** UI = control-plane к REST API Hermes; наём = profile-per-наниматель. Инфра-блок: нужен VPS 4-8GB → Phase-0 spike перед масштабированием. Синтез D-2: Daytona песочит только тулы; `hermes gateway` остаётся **resident (~300-600MB each)** — мерить мультиплексинг в spike. Connect-your-own-Hermes остаётся дешёвым путём. См. канон §4-5.
- **Vision (deferred/R&D):** creating an agent provisions a per-user Hermes instance on our infra; it talks to our `:4000` gateway for models + our tool broker; has persistent memory + skills + cron.
- **REALITY (verify before promising it):** not built and infra-blocked.
  - Today "Hermes" is just a model slug; the runtime is a **stateless BullMQ → OpenRouter loop** (`apps/agent-worker/src/agent-runner.ts`). No provisioning, no per-user process, no isolation.
  - VPS = 2GB RAM, already runs 5 pm2 procs → **cannot host Hermes pods** (~300MB idle, ~1GB active each).
  - Hermes **ИМЕЕТ REST API** (`/api/model/set`, `/api/jobs`, `/api/sessions` на `:8642`) — наш UI **может им управлять** (research 2026-06-12). TMA *talks to* Hermes via OpenAI-compatible URL (`http://host:8642/v1`) И конфигурит его через этот REST control-plane.
  - Hermes natively bridges ~22 chat platforms incl. Telegram out of the box → **we do NOT build the chat bridge.**

## REAL vs FANTASIZED — what a user is shown MUST match the left column
| Works today (ship / show) | Unbuilt / aspirational (hide or label R&D) |
|---|---|
| agent CRUD, run, conversation history, daily budget | managed Hermes provisioning on our infra |
| crypto-credit balance (BIGINT микро, USD-peg) + TON top-up | full multi-provider picker UI |
| bring-your-own-key = FREE (rule is in code) | tool broker / x402 / Firecrawl paid tools |
| login + R0 auth hardening (live) | MCP servers, skills hub |
| crypto-credit balance + multi-crypto top-up | Telegram-deploy, kanban, scheduled tasks (NFT removed) |

## Commission rule (firm, already in code)
- AIAG-supplied model (routed via `:4000`) → **debit balance + apply markup**.
- User's own key/provider (OpenRouter / Gonka / BYOK) → **charge ZERO** (they pay their provider).

## Money path status
- **R0 (Phase 15.1) COMPLETE + LIVE on prod:** worker money path, gateway routing, auth hardening (Next 14.2.33 CVE, HS256 pin, nginx strip), settleRun atomicity (integration test 4/4 green).
- Branch `plan/15.1-r0-billing-identity` — **NOT merged to master.**
- `AIAG_GATEWAY_KEY` minted + live. `DEFAULT_MODEL` = `openai/gpt-4o-mini` (registered; the old hermes-4-405b "Unknown model" bug is FIXED, commit c8c4ed0). Rule: new default/template slugs must be in the prod `models` table or they silently fall back to OpenRouter (margin leak).
- ⚠️ **Wave-0/R1/Phase16/17 are LIVE on `feat/r1.0-wave0-consolidated`** (D-0 margin, D-1 USD credits, author-rent, provider-picker, MCP+OAuth, reconciler, transfer-iNFT, hub redesign). Older docs that say these are "not-built" LIE IN THE MINUS — verify against `docs/specs/2026-06-12-forensic-audit.md` before trusting any "not-built" status.

## Latest critical scores (forensic audit 2026-06-12, see `docs/specs/2026-06-12-forensic-audit.md`)
- TMA: **продукт 58 · UX 42 (worst) · дизайн 63 · полнота-vs-интент 55** /108.
- Worst now: navigation duplicates (/templates under 4 names), money-display ×100, Potemkin showcases, docs-lie-in-minus. Forgotten core: multimodel per-role, run-trace ledger, AI-builder, free-first-run.

## Memory map (where context lives — query these, don't re-derive)
- **THIS file** = always-loaded anchor.
- **Canon** = `docs/specs/2026-06-02-WHAT-WE-ARE-BUILDING.md`; coherence gaps = `docs/specs/2026-06-02-product-coherence-map.md`.
- **Serena** `.serena/memories/aiag_*.md` = detailed session/exec state.
- **Auto-memory** `~/.claude/projects/.../memory/MEMORY.md` = indexed fact pointers.
- **LightRAG** (pinglass.ru/lightrag) = semantic, slow/timeout-prone, SHARED with PinGlass.
- **memgraph** (`mcp__memory`) = now seeded with AIAG (11 entities + 18 relations, 2026-06-02). Was PinGlass-only before. Query via `mcp__memory__search_nodes`.

## Founder decisions (2026-06-02)
1. ✅ **TMA currency = crypto credits (USDT/TON); ₽ removed from TMA.** Миграция ВЫПОЛНЕНА: баланс = BIGINT микро-кредиты USD-peg (миграции 0056/0058). Draw all TMA mockups in crypto.
2. ✅ **Managed Hermes runtime = R&D, deferred.** Live path = connect-your-own-Hermes. No managed-Hermes dashboard in shippable product.
3. ✅ **Wireframes in two layers:** Board A = honest shippable now (hide unbuilt); Board B = full roadmap vision (separate).
4. ✅ **NFT: REMOVE as speculation** (founder 2026-06-03) — no tradable-agent / NFT-marketplace framing; do not surface NFT-as-investment anywhere. ⚠️ **PARTIAL REVERSAL (founder 2026-06-10):** ONE narrow, opt-in use is back — a **transferable agent** (gift+sell one instance in a single mechanic, transfer WITHOUT personal history, **opt-in** TON mint). Implemented as TON-native iNFT (TEP-62 + backend re-key, Startonus mint reused; 0G rejected). This is the ONLY sanctioned NFT surface → Phase 16 (R1.4). Still no NFT speculation/marketplace. Plan: `.planning/phases/16-r1-4-transferable-agent-inft/`.
   ⚠️ **ОБНОВЛЕНО 2026-07-11 (founder):** санкционированных NFT-поверхностей ТЕПЕРЬ ДВЕ. (1) Transferable-агент (Phase 16, TON-native iNFT) — как раньше. (2) **Membership-NFT — доступ/квота на создание агентов**, 3 яруса: creator 2 TON (1 агент, 0% rev-share) · builder 10 TON (5 агентов, 15%) · studio 30 TON (20 агентов, 30%). Покупка — on-chain TON через Startonus, экран после заставки в TMA. Это НЕ спекуляция: членства у нас не торгуются и не перепродаются — это плата за доступ. Запрет «NFT-как-инвестиция» остаётся в силе. Спека: issue #29 (см. gh).
   ⚠️ **УТОЧНЕНО 2026-07-12 (founder):** membership-NFT — **передаваемый**, и передача переносит ВСЁ: членство + всех агентов владельца + будущий доход с их аренды. Продать NFT = продать аккаунт. **Арендаторы не затронуты:** у них изолированные профили и своя память (namespace `(agent_id, hirer_tg_user_id)`), они продолжают пользоваться; меняется только получатель дохода с аренды. Источник истины владения — **блокчейн** (tonapi.io, реконсилер), не наша БД. SBT/soulbound Startonus не умеет (ресёрч 2026-07-12) — NFT передаваем физически, и мы следуем за передачей осознанно. Спеки: issue #29 (покупка+реконсилер), #35 (передача владения).
5. ✅ **Currency = multi-crypto (TON + others); Stars deferred (ignore now); legal not factored now.** USD-pegged credit (synthesis D-1).
6. ✅ **Managed-Hermes: build on ~18GB VPS (shared) for test → tier later** (dedicated for high-payers, shared for ~$20-tier).
7. ✅ **Monetization = author-rent model:** author publishes a template **free** OR sets a **price** (e.g. monthly rent). The user pays model usage (AIAG markup) + deploy + **the author's exact set sum**; **NO % commission on author rent** — author receives the sum they set; AIAG earns on model markup + tools + deploy. Detail: `docs/specs/2026-06-03-monetization.md`.
8. ✅ **Web version:** build ALL TMA screens + modals as a separate WEB board too, **light theme** à la Studio23 (airy white / sky-blue + orange-amber accent, dark CTA pills). TMA stays dark/amber. → `docs/wireframes/web/`.
9. ✅ **Direction confirmed** by the 12-item research (`docs/specs/research/SYNTHESIS.html`); **fix money-path first** (D-0: gateway must return realized margin).

### Founder decisions (2026-06-12) — см. канон §13
10. ✅ **Наём (rent) — СТРОИМ:** наймовая модель агента = profile-per-наниматель поверх real-Hermes (канон §13).
11. ✅ **Cloneable** — флаг + роут **LIVE** (1-тап клон сетапа из шаблона).
12. ✅ **Hermes-разворот:** курс на реальный Hermes как control-plane к его REST API (отменяет «R&D/deferred», см. HERMES-секцию выше).

Detailed product definition reflecting these: `docs/specs/2026-06-02-tma-product-definition.md`. Research synthesis: `docs/specs/research/SYNTHESIS.html`.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## ПРАВИЛА ПОДДЕРЖКИ ЗНАНИЯ
- Канон = SoT. При изменении продукта → сперва обновить канон → затем синхрон memgraph-узла + указателя в auto-memory `MEMORY.md`.
- После кода → `graphify update .`.
- Новый ресёрч → `LightRAG upload_document`.
- Старьё **не удалять** — помечать `DEPRECATED → канон`.
