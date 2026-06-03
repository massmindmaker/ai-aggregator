# AIAG — Project Context Anchor

> **This file auto-loads every session.** It is the always-present "common denominator" so context is not lost between sessions.
> **Canon / single source of truth:** `docs/specs/2026-06-02-WHAT-WE-ARE-BUILDING.md`. On any conflict, the canon doc wins; this file is its short summary.
> Detailed state: `.serena/memories/aiag_*.md`. Deploy: skill `aiag-deploy`. Never expose personal Telegram (@b0brov) in artifacts.

## How to work here (read order)
- Behavior rules: @.claude/rules/coding-behavior.md
- Architecture & service map: @docs/ARCHITECTURE.md
- Security & money-path rules: @SECURITY.md
- Design/product (frontend): @PRODUCT.md
- Design system / tokens (single SoT): @DESIGN.md
<!-- ANIMATION.md and per-app CLAUDE.md load lazily (on UI work / on touching that app) — not imported, to save context. Status page for humans: docs/specs/STATUS.html -->

## TWO SEPARATE PRODUCTS — never conflate them

### 1) Aggregator (WEB) — ai-aggregator.ru
- AI **models + agents marketplace for the RU market** + OpenAI-compatible API gateway (white-label, hides upstream brand).
- Code: `apps/web` (Next 14.x), `packages/api-gateway` (Hono/Bun, `:4000`).
- **Billing: RUBLES (₽) ONLY** — Tinkoff card pay + subscriptions + B2B org keys. No crypto.
- Entity: RF (ИП → производственный кооператив). IT 7.6%.
- Status: live; admin (Phase 14) live; marketplace ~80%; contests/supply deferred.

### 2) TMA (Telegram Mini App) — **CURRENT FOCUS**
- **Agents marketplace**: discover / run / create AI agents that live in Telegram.
- 3 ways to get an agent: **(a)** connect your own Hermes, **(b)** from a public template, **(c)** from scratch.
- An agent = a composable **SPEC**, not a prompt: persona (`SOUL.md`) + models (separate chat/image/voice/vision) + skills + tools + MCP servers + knowledge/memory + cron.
- Templates are **published, not sold**: public template shares the spec (model names, skills, tool/MCP defs WITHOUT keys), keeps private the keys/memory/data/history. Others clone the setup.
- Code: `apps/tg-miniapp` (Next 14.2.33, `:3100`), `apps/agent-worker` (BullMQ, `:3101`).
- **Billing: CRYPTO CREDITS — multi-crypto (TON + other cryptos), ₽ removed from TMA.** Telegram **Stars = deferred — do NOT implement/show now** (founder 2026-06-03). ⚠️ Code still debits a RUB balance (`tg_user_balances`) → migration to a **USD-pegged** crypto-credit unit pending (synthesis D-1). Draw TMA mockups in crypto credits.
- **Legal/compliance: NOT factored now** (founder 2026-06-03). Working structure: a separate **non-RF foreign entity buys models FROM the AIAG aggregator** (as an RF provider's customer); crypto/USDC + $-billed compute sit on the foreign entity. Revisit compliance later (synthesis FD-2/FD-3).

## HERMES — the intended core, but NOT built yet (read this before any agent-runtime work)
- Hermes = **`NousResearch/hermes-agent`** — an open-source AI-AGENT **RUNTIME** (MIT, v0.15.2). **It is NOT a model.**
- **Stance (founder 2026-06-03): BUILD managed-Hermes for test on an ~18GB VPS (shared).** Later tier: high-paying users → dedicated instance; ~$20-tier → shared VPS. Synthesis D-2: Daytona sandboxes only the tools; the `hermes gateway` stays **resident (~300-600MB each)** — measure multiplexing in a Phase-0 spike before scaling. Connect-your-own-Hermes stays the cheap path.
- **Vision (deferred/R&D):** creating an agent provisions a per-user Hermes instance on our infra; it talks to our `:4000` gateway for models + our tool broker; has persistent memory + skills + cron.
- **REALITY (verify before promising it):** not built and infra-blocked.
  - Today "Hermes" is just a model slug; the runtime is a **stateless BullMQ → OpenRouter loop** (`apps/agent-worker/src/agent-runner.ts`). No provisioning, no per-user process, no isolation.
  - VPS = 2GB RAM, already runs 5 pm2 procs → **cannot host Hermes pods** (~300MB idle, ~1GB active each).
  - Hermes has **NO remote config REST API** (no `POST /api/model/set`). Config is via files + CLI on the host. TMA can *talk to* a Hermes via its OpenAI-compatible URL (`http://host:8642/v1`) but cannot remote-control it without a control plane WE build.
  - Hermes natively bridges ~22 chat platforms incl. Telegram out of the box → **we do NOT build the chat bridge.**

## REAL vs FANTASIZED — what a user is shown MUST match the left column
| Works today (ship / show) | Unbuilt / aspirational (hide or label R&D) |
|---|---|
| agent CRUD, run, conversation history, daily budget | managed Hermes provisioning on our infra |
| RUB balance + TON top-up | full multi-provider picker UI |
| bring-your-own-key = FREE (rule is in code) | tool broker / x402 / Firecrawl paid tools |
| login + R0 auth hardening (live) | MCP servers, skills hub |
| crypto-credit balance + multi-crypto top-up | Telegram-deploy, kanban, scheduled tasks (NFT removed) |

## Commission rule (firm, already in code)
- AIAG-supplied model (routed via `:4000`) → **debit balance + apply markup**.
- User's own key/provider (OpenRouter / Gonka / BYOK) → **charge ZERO** (they pay their provider).

## Money path status
- **R0 (Phase 15.1) COMPLETE + LIVE on prod:** worker money path, gateway routing, auth hardening (Next 14.2.33 CVE, HS256 pin, nginx strip), settleRun atomicity (integration test 4/4 green).
- Branch `plan/15.1-r0-billing-identity` — **NOT merged to master.**
- `AIAG_GATEWAY_KEY` minted + live. **Latent bug:** `DEFAULT_MODEL = nousresearch/hermes-4-405b` is not in the gateway registry (400 "Unknown model"); no current victims (0 agents on prod).

## Latest critical scores (108-point scale = 12 dims × 9)
- Tech stack **50/108** · Functional **43/108** · UX **59/108**.
- Worst dims: billing integrity, provider routing, auth, observability, testing, compliance.

## Memory map (where context lives — query these, don't re-derive)
- **THIS file** = always-loaded anchor.
- **Canon** = `docs/specs/2026-06-02-WHAT-WE-ARE-BUILDING.md`; coherence gaps = `docs/specs/2026-06-02-product-coherence-map.md`.
- **Serena** `.serena/memories/aiag_*.md` = detailed session/exec state.
- **Auto-memory** `~/.claude/projects/.../memory/MEMORY.md` = indexed fact pointers.
- **LightRAG** (pinglass.ru/lightrag) = semantic, slow/timeout-prone, SHARED with PinGlass.
- **memgraph** (`mcp__memory`) = now seeded with AIAG (11 entities + 18 relations, 2026-06-02). Was PinGlass-only before. Query via `mcp__memory__search_nodes`.

## Founder decisions (2026-06-02)
1. ✅ **TMA currency = crypto credits (USDT/TON); ₽ removed from TMA.** Code migration pending (`tg_user_balances` → crypto-credit unit). Draw all TMA mockups in crypto.
2. ✅ **Managed Hermes runtime = R&D, deferred.** Live path = connect-your-own-Hermes. No managed-Hermes dashboard in shippable product.
3. ✅ **Wireframes in two layers:** Board A = honest shippable now (hide unbuilt); Board B = full roadmap vision (separate).
4. ✅ **NFT: REMOVE** (founder 2026-06-03) — removed from the product/wireframes; Startonus mint code to be retired. Do not surface NFT anywhere.
5. ✅ **Currency = multi-crypto (TON + others); Stars deferred (ignore now); legal not factored now.** USD-pegged credit (synthesis D-1).
6. ✅ **Managed-Hermes: build on ~18GB VPS (shared) for test → tier later** (dedicated for high-payers, shared for ~$20-tier).
7. ✅ **Monetization = author-rent model:** author publishes a template **free** OR sets a **price** (e.g. monthly rent). The user pays model usage (AIAG markup) + deploy + **the author's exact set sum**; **NO % commission on author rent** — author receives the sum they set; AIAG earns on model markup + tools + deploy. Detail: `docs/specs/2026-06-03-monetization.md`.
8. ✅ **Web version:** build ALL TMA screens + modals as a separate WEB board too, **light theme** à la Studio23 (airy white / sky-blue + orange-amber accent, dark CTA pills). TMA stays dark/amber. → `docs/wireframes/web/`.
9. ✅ **Direction confirmed** by the 12-item research (`docs/specs/research/SYNTHESIS.html`); **fix money-path first** (D-0: gateway must return realized margin).

Detailed product definition reflecting these: `docs/specs/2026-06-02-tma-product-definition.md`. Research synthesis: `docs/specs/research/SYNTHESIS.html`.
