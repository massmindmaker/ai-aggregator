# AIAG TMA — Functional Stack + Build Roadmap (agents-marketplace-first)

**Date:** 2026-06-02 · **Author:** synthesis pass
**Scope:** deep functional analysis + tech-stack pick + phased build plan for the AIAG
Telegram Mini App, reframed as an **AGENTS MARKETPLACE** (discover / run / create AI agents
that work inside your Telegram via official Bot API + Telegram Business — **no MTProto**).

> **Product framing (the one rule that drives everything):** the TMA is an agents
> marketplace first. The ~73-model aggregator is **ONE PROVIDER among many** (AIAG-gateway
> default · OpenAI/Anthropic BYOK · Gonka/GNK beta · own Hermes R&D), not the hero.
> **Runtime today (REAL):** a stateless BullMQ + OpenRouter tool-calling loop
> (`apps/agent-worker/src/agent-runner.ts`) — managed cloud Hermes per user is **R&D/unbuilt**.
> Billing = TON/USDT prepaid credits, per-call, x402-shaped (USDC/Base) for external agents.
> **HARD RULE:** never expose a personal Telegram handle — generic placeholders only.

Nav re-weight in progress: **Агенты / Маркет / Кошелёк / Профиль**.

---

## 1. Score table — 43 / 108

Four functional tabs, each reviewed against the agents-marketplace reframe and scored **/27**.

| # | Tab | Score | One-line verdict |
|---|-----|------:|------------------|
| 1 | **Агенты** (discover · run · create · deploy) | **14 / 27** | Strongest tab: RUN card, kanban, 3 creation paths, wizard, BYOK picker exist — but no author profiles, no run-trace, clone is a stub, no publish flow, no real ratings, provider choice hidden in wizard |
| 2 | **Маркет** (supply: models · skills · MCP-tools) | **11 / 27** | Model list + detail + filter strong; skills/MCP surfaces drawn but shallow — no unified supply home, no provider attribution on cards, sort/filter for models only, no skill detail, no install-into-agent targeting |
| 3 | **Кошелёк** (credits · top-up · ledger · budgets) | **11 / 27** | x402 per-call ledger + agent budgets + low-balance card exist; auto-top-up is a dead link, no tx-detail/receipt, no 152-ФЗ statement, no billing error/pending states, currency soup, no nav slot yet |
| 4 | **Профиль** (identity · providers · creator · legal) | **7 / 27** | IA scaffolding + BYOK provider list + balance summary present; **no creator/author profile**, no published-agents mgmt, no monetization, no security, no 152-ФЗ screen, no settings/logout |
| | **TOTAL** | **43 / 108** | Strong consumer skeleton; the **supply/creator side is read-only**, observability + error states are missing, and several hero screens still market unbuilt runtime |

> Cross-check: an earlier 9-dimension review of the same board scored **59/108** on a
> different rubric (`docs/specs/2026-06-01-tma-108-reframe.md`). The 43/108 here is the
> stricter **4-functional-tab** rubric (each tab graded as a complete marketplace surface,
> not as IA fragments). Both agree on the same gaps: supply/creator side unbuilt, runtime
> fiction, currency soup, missing observability + error states.

---

## 2. Feature inventory per tab (must-have vs nice-to-have)

### Tab 1 — Агенты

**MUST-HAVE (table stakes for an agents marketplace)**
- Discovery home: catalog-first landing for zero-agent users (segmented Мои / Каталог), search by task/use-case, trending + "new this week" + "recommended" rails, category landing pages, **price/run estimate on every card**.
- Agent sort/filter **distinct from the model filter**: by runs / rating / price-per-run / recency; filter by category, provider, capability, free-first-run flag.
- Agent detail page: hero, "what's under the hood" expander (model · skills · MCP-tools), quick-start chips, sample output, runs count, ratings + **written reviews**, author link, share, report.
- Run page (form + streamed output): starter chips, ▶ run, first-run-free, per-run cost in TON/USDT, copy/regenerate/save, **post-run rate-this-agent** prompt.
- Streaming chat: composer, context/cost meter, Чат/Раны/Задачи/Настройки seg, stop-generation, retry, multi-turn memory.
- Runs history: per-run title · time · latency · cost · status (ok/timeout/error), retry failed, aggregate stats.
- **Run-trace / observability**: per-run step timeline (web-search → scrape → generate) with per-step USDT cost + latency + status — justifies pay-per-call. **MISSING.**
- Tasks kanban: queue / in-progress / done, scheduled + keyword-triggered tasks, per-task cost, add-task, drag/move.
- Agent creation — 3 paths: from-template (2-click), from-scratch (form), conversational AI-builder.
- Creation wizard **Кто → Где → Что** with an explicit **«На чём работает»** provider/runtime step.
- **Provider picker per-agent** as a real sheet (AIAG-gateway default · OpenAI BYOK · Anthropic BYOK · Gonka beta · own Hermes), in both wizard and settings.
- BYOK connect: provider chips, paste key, verify via `/models`, encrypted storage (last-4 shown).
- Telegram deploy (official only): connect @your_bot, choose channel/group/Business DM, admin/rights check, test-message, live status, disable — **with deploy error/pending states** (not admin / token revoked / Business not granted / no post rights). Error states **MISSING.**
- Telegram Business gating: Premium-required check, scope-consent screen, capability disclaimer, never expose owner's @. **MISSING.**
- Spend control per-agent: daily budget + meter, agent sub-wallet top-up, auto-stop on limit, first-run-free, **auto-top-up at threshold** (critical for cron agents).
- **Clone/remix** flow: fork public agent → pre-filled editable create form (model+prompt+tools inherited), swap provider, keep "форк от @author" lineage. Currently a one-tap **STUB.**
- **Author/creator profile** (tap @author): avatar, total runs, agent grid, follow, verified badge. **MISSING — biggest gap.**
- **Publish/author an agent**: list to catalog, non-personal store alias, per-run pricing, versioning, edit/unpublish, usage analytics. **MISSING.**
- Native Telegram WebApp controls: MainButton / BackButton / themeParams / haptics / keyboard-open state on run + wizard. **MISSING.**
- Empty / loading / error / no-balance / agent-stopped states across run/chat/tasks.

**NICE-TO-HAVE**
- Per-agent **memory surface** (view/edit/clear persistent facts/brand-voice/files, retrieval toggle) — today it's only a create-time toggle.
- Share / deep-link to run a specific agent + referral attribution + install count.
- Agent comparison, collections/favorites, "продолжить" (recently-run) rail.
- BYO-Hermes endpoint connect (URL + bearer, auto-detect runtime, pull its tools/cron/sub-agents) — power-user / R&D.
- Ratings sort + report-abuse.

### Tab 2 — Маркет (supply: models · skills · MCP-tools)

**MUST-HAVE**
- Single canonical **supply home** with the 3-segment control (Модели · Скиллы · Тулзы/MCP) at the TOP, one shared search + shared "что это даёт агенту" framing.
- Models surface: ~73 models with **per-card provider attribution** ("через AIAG-шлюз" / "через твой OpenAI-ключ" / "Gonka · бета"), pay-per-call price (in/out per 1M + per-call estimate), modality, context window, capability tags, uptime, p50/p95 latency — **nested under «Провайдеры → AIAG-шлюз»** so AIAG is one of many.
- Model detail: pricing table, capability chips, live metrics, token calculator, "Создать агента с этой моделью", RU-resident / 152-ФЗ badge.
- Skills surface (`SKILL.md`): category chips, install count, author, short "что делает", «Поставить» CTA, installed/toggle, version, compatibility note.
- **Skill detail** (sibling to model/tool detail): `SKILL.md`/README preview, version + changelog, requested tools/permissions, author link, ratings/reviews, dependencies, «Поставить в агента ›» with target-agent picker + budget-impact line. **MISSING.**
- MCP-tools / servers surface: per-call price, call volume, paying-users, transport (http/sse/stdio), tool count, **first-party vs third-party badge**, **OAuth-required indicator** for third-party MCP, schema preview, «Поставить» CTA.
- **Sort + filter equal across all three** supply types (not models-only): sort by популярное / дешевле / быстрее / новые / по установкам; filter by price-per-call, transport, first-party-vs-third-party, modality, context≥, capabilities, provider, RU-resident.
- **«Поставить» targets a specific agent/runtime** ("в какого агента / в Мой Hermes?"), shows budget impact, writes an installed/manage state with uninstall.
- Live trust metrics on every item: real usage counts, ratings **with browsable reviews**, "used by N agents", "новое за неделю", verified/first-party badge.
- Pay-per-call economics explicit per item: estimated cost, billing source (TON/USDT credit ledger), free-first-call where applicable — **unified TON/USDT framing** (kill the $ vs /вызов vs GNK soup).
- Bring-your-own supply: «Свой OpenAI-совместимый эндпоинт» (from Маркет→Модели, links into BYOK) + «Свой MCP / x402-эндпоинт · само-индексация».
- Empty / loading / error / pending states per surface; native WebApp controls.

**NICE-TO-HAVE**
- Author/publisher surface for skills & MCP (their other items, trust badge, total installs).
- Versioning / update-available badges + deprecation gating (бета / скоро / R&D).
- Cross-link supply item → agent creation/equip (close discovery→use loop).
- Sandbox "try a call" (free first call) on MCP tools.

### Tab 3 — Кошелёк

**MUST-HAVE**
- **Own tabbar slot** (Агенты / Маркет / Кошелёк / Профиль); reconcile the legacy Profile balance card into one wallet of record.
- Balance hero in a **single canonical credit unit** (USDT credits) with fiat-equivalent (₽); TON / Gonka GNK shown as **separate rails**, not summed. **Kills currency soup — the #1 wallet blocker.**
- Top-up flow: presets + custom, method picker (TON Connect, Telegram Wallet USDT, Tonkeeper/MyTonWallet, **+ a fiat/RF-card path for 152-ФЗ**), live conversion preview, **pending → confirmed → credited** state machine.
- **Auto-top-up** (real screen, not a dead link): threshold trigger (balance < X), refill amount, source method, period cap, on/off, consent. **Underpins cron/scheduled agents — currently a dead link.**
- Low-balance alerts: in-app + Telegram DM at configurable threshold, "agents will stop" warning + one-tap top-up.
- Per-call spend ledger: every deduction (inference via gateway · MCP tool call · x402 external) + credit, with type, label, amount, timestamp, status, provider attribution, tx-hash; **filter/group/paginate + CSV/PDF export.**
- **Transaction-detail / receipt** screen from each ledger row: amount, fee, token, network, full tx-hash + explorer link, causing agent/run, settlement status, "скачать чек". **MISSING.**
- **152-ФЗ receipts / period statement** (PDF/CSV), reflecting the two-entity posture (fiat on RF ИП · crypto on foreign agentic entity). **MISSING — legal requirement.**
- **Billing error states**: TON tx rejected, insufficient-funds-at-deduct, agent-stopped-on-limit (CTA «пополнить кошелёк агента»), top-up timeout, bridge failure — each with recovery CTA. **MISSING.**
- **Pending/in-flight states** for async on-chain top-ups + x402 settlement.
- **Agent-budgets roll-up** card aggregating all agent sub-wallets (N agents · выделено $X/$Y · M near limit) — manage budgets from the wallet, not just per-agent.

**NICE-TO-HAVE**
- Spend analytics: per-day/week/month, breakdown by agent / provider / cost-type, burn-rate + runway.
- Gonka GNK panel: separate balance, gonka address, faucet, GNK↔credit reconciliation (beta-gated).
- x402 / TON↔USDC(Base) bridge explainer.
- Withdraw / refund path (or explicit non-refundable-credits policy stated up front).
- Connected-wallets manager (set primary / disconnect / copy address).
- Promo / referral / free-credit ledger; pricing/markup transparency + cost calculator.

### Tab 4 — Профиль

**MUST-HAVE**
- Identity header: avatar, **generic @username (never a real personal handle)**, member-since, edit display-name/alias, account-type (consumer vs creator) switch.
- Connected providers as a **peer set** (AIAG-gateway default + BYOK OpenAI/Anthropic/… + Gonka beta + own Hermes R&D), each with status, last-verified, default toggle.
- Per-provider key management: add/verify/**rotate/revoke** BYOK key, masked last-4, `/models` verify result, per-key spend + cap, last-verified timestamp. (Today add+verify only.)
- AIAG platform API keys (outbound OpenAI-compatible): list, base_url, copy, create/name/revoke, per-key usage.
- Wallet/billing entry (thin summary that deep-links into Кошелёк — single source of truth).
- **Author / Creator profile** (also reachable from every @author handle): public alias (non-personal default), avatar, bio, total runs, follower count, verified/trust badge, agent grid. **MISSING — #1 marketplace gap.**
- **Published-agents management**: per-agent runs/rating/revenue, publish/unpublish, versioning, moderation status. **MISSING — no way to BE a seller.**
- **152-ФЗ / privacy screen** behind the existing «Настройки · 152-ФЗ» row: PDN consent, privacy/ToS links, data-residency notice, data-export, account+data deletion. **MISSING — legal requirement.**
- Notification preferences + app settings (language RU/EN, theme via themeParams, default model/provider, default budget).
- Logout / switch-account / delete-account; app version + support/help row.

**NICE-TO-HAVE**
- Creator monetization: earnings dashboard, payout method (TON/USDT), revenue-share, withdraw, payout history, publisher KYC/verification gate.
- Referrals / invite program (link/code, invited count, credits earned, payout state).
- Security: active sessions/devices, sign-out-everywhere, login history, 2FA/passkey, connected-wallet revocation.
- Receipts/invoice export for RF ИП accounting.

---

## 3. Top gaps (highest leverage, cross-tab)

1. **No author/creator profile** — every @author handle (catalog cards 20/21/38) is dead; the entire supply-side trust surface is missing. The single highest-leverage screen and the precondition for the publish loop.
2. **No publish/author-an-agent flow + no creator monetization** — supply side is read-only; nobody can list an agent, price it, version it, or earn. Without it there is no two-sided marketplace.
3. **No run-trace / observability** — no tool-call timeline with per-step USDT cost + latency, so pay-per-call and tool budgeting are unjustified to the user.
4. **Clone is a stub, not a remix** — no pre-filled editable form, no provider swap, no "форк от @author" lineage. Remix is the central marketplace mechanic.
5. **Provider choice hidden** — no explicit «На чём работает» wizard step; provider lives as a flat settings row, not a real picker sheet — directly undercuts the "AIAG is one provider of many" reframe.
6. **Supply discovery is shallow & fragmented** — no unified Маркет home, no per-card provider attribution on models, sort/filter for models only, no skill detail, install doesn't target an agent.
7. **Error / pending / empty states largely absent** — no deploy errors, no payment errors, no top-up pending, no insufficient-funds-at-deduct; every flow is drawn as instantly-successful.
8. **Currency soup** — $, USDT, USDC, GNK, TON, ₽ coexist with no canonical credit unit and no stated conversion across runs/wallet/agent-budget surfaces.
9. **Auto-top-up is a dead link** — the feature the whole scheduled/cron-agent premise depends on is undrawn.
10. **152-ФЗ / privacy + receipts unbuilt** — only an unlinked row label; a hard RF legal requirement (consent record, data-export, erasure, downloadable чеки).
11. **Telegram Business overstated** — shown as a peer option with no Premium gating / scope-consent / capability disclaimer.
12. **Runtime is fiction vs codebase** — onboarding markets a "cloud Hermes" spin-up; the real worker is a stateless BullMQ OpenRouter loop with no memory, no pod, no `:8642`/`:9119`. **The `aiag` provider also currently bypasses our own gateway** (`agent-runner.ts:48-51` hits OpenRouter directly), so white-label markup + `gateway_transactions` billing are skipped for agent runs.

---

## 4. Recommended tech stack per subsystem

Grounded against the REAL stack: Turborepo + Bun monorepo · Next.js 15 (`apps/web`) + `apps/tg-miniapp` · Hono gateway (`:4000`, OpenAI-compatible, markup) · BullMQ + Redis worker (`apps/agent-worker`) · Drizzle + raw-SQL Postgres on a Timeweb VPS (pm2 + nginx) · TON Connect + Startonus (NFT). **No Vercel / Neon.**

| # | Subsystem | Pick | Why (vs the codebase) | Difficulty |
|---|-----------|------|------------------------|------------|
| 1 | **Agent runtime** | Keep the stateless BullMQ tool-loop (`agent-runner.ts`) as the **default** runtime; layer **Mastra** (TS-first, Bun/Hono-native) for multi-step + memory; managed **NousResearch Hermes-agent** as the opt-in "cloud Hermes per user" tier. **No code sandbox in v1** — worker only calls vetted tools/MCP over HTTP (trust boundary = the MCP endpoint, `code_interpreter` is intentionally unimplemented in `tools.ts`). gVisor-wrapped containers (per tool-class) only **if** arbitrary code execution becomes real; k3s/per-user pods reserved strictly for the managed-Hermes tier. | The runtime works end-to-end today (budgets, history, tool loop). The expensive isolation problem only exists if you run untrusted code — the design routes everything through MCP/HTTP, so the default path needs no Firecracker/E2B/k3s-per-tenant. | HARD only if/when code-sandbox needed; otherwise MEDIUM and mostly built |
| 2 | **MCP tool gateway** | New Hono service (`apps/mcp-gateway`) on the **2026-03 MCP Streamable-HTTP** transport via `@modelcontextprotocol/sdk`. Mint per-agent endpoints `https://mcp.ai-aggregator.ru/t/{agentId}/mcp` + a per-tenant bearer (hashed in Postgres, scoped, revocable). **Bearer-auth in v1** (both sides ours); **defer OAuth 2.1 + PKCE + RFC 8707** to the 3rd-party-host phase. Back each server with the in-process tool registry (key-broker rail injecting OUR Firecrawl/etc. key). | Exactly the architecture in `2026-06-01-aiag-hermes-supply-design.md` (P3). The official TS SDK speaks Streamable-HTTP natively (matches Hono streaming). Per-agent path + bearer gives isolation + metering hooks with no OAuth dance you don't yet need. | MEDIUM (OAuth later is the hard part) |
| 3 | **Billing — credit ledger + atomic deduct** | **EXTEND the existing custom Postgres ledger** — do NOT adopt OpenMeter/Lago. Reuse `aiag_settle_charge` (SELECT FOR UPDATE + in-lock idempotency + dual sub/payg bucket + author-earnings accrual) in `packages/database/src/functions/settle-charge.sql`. Add a sibling `aiag_deduct_tool_call(org_id, tool_call_id, cost_credits)` using the same `UPDATE balance WHERE balance >= cost RETURNING` pattern, idempotency key = `tool_call_id`, writing a `tool_calls` ledger row. x402 = `rail`/`accepts`/`trust` jsonb columns present-but-stubbed. | OpenMeter/Lago would duplicate a battle-hardened ledger (TOCTOU-fixed, idempotent, concurrency-serialized, RU-self-hostable) and add an external service against the no-Vercel / 152-ФЗ constraint. The hard correctness (atomic deduct, no double-charge on SSE abort) is already solved. | MEDIUM (idempotency across SSE-abort + tool-call + top-up) |
| 4 | **Crypto — TON + USDT + Gonka** | Keep `@tonconnect/ui-react` for connect/top-up + Startonus NFT. Top-up = TON/USDT-jetton to a deposit address, reconcile by polling TonAPI/Toncenter for incoming transfers, credit ledger via a settle fn keyed on **tx-hash (idempotent)**. **Gonka GNK fully OFF the live per-call path**: a CosmJS watcher (separate worker job) reads GNK transfers and posts periodic netting entries as `source='gonka'`, converting at a recorded rate snapshot (mirror the `lib/cbr.ts` pattern). Never block a run on a GNK confirmation. | TON Connect + USDT-jetton is the proven RU-friendly rail (already integrated). Per-call on-chain settlement is infeasible (latency/fees) → bulk top-up → off-chain decrement. Gonka is beta — isolate chain instability from the run loop. | HARD (Gonka reconciliation + RU crypto-payment legal status are partly-legal, not technical) |
| 5 | **Telegram — Bot API + Business + WebApp** | **grammY** for the Bot API layer in a new `apps/agent-bot` service consuming the same BullMQ queues (replaces hand-rolled `bot-api.ts` fetches). Use grammY **Business Connection** updates for the "agent acts in your DMs" tier. Keep `@telegram-apps/sdk-react` for the Mini App + existing initData HMAC verify. **No MTProto userbot; never expose a personal handle.** | grammY is the 2026 TS standard, has first-class Business Connection handling (the exact no-MTProto mechanism), runs on Bun. `@telegram-apps/sdk-react` is the correct non-deprecated WebApp SDK. | MEDIUM (Business scopes + never-leak-handle enforcement) |
| 6 | **Streaming / realtime** | **SSE via Hono `streamSSE`** — already implemented in `packages/api-gateway/src/streaming/sse.ts` (forwards chunks, parses usage, settles on completion OR client-abort with `X-AIAG-Partial`). Extend it for agent-chat token streaming. For async BullMQ **run-status** (queued→running→tool-call→done), add a thin SSE route backed by **Redis pub/sub** keyed by `runId`. Avoid WebSockets unless mid-stream steer/interrupt becomes a product need (then model cancel as a Redis flag the worker checks each iteration). | SSE is proven in-repo with the hardest property solved (partial-settle on abort → never lose/double-charge). One-directional, nginx-friendly, Bun/Hono-native. Redis pub/sub reuses the BullMQ Redis. | EASY-MEDIUM |
| 7 | **Observability / per-call traces** | Two layers. Keep `prom-client` + pino + node/postgres exporters; add `tool_call_total{tool,rail,status}` + `tool_cost_credits` counters; the new `tool_calls` table doubles as the durable per-call audit. Adopt **OpenTelemetry SDK** → self-hosted collector → **Grafana Tempo or SigNoz** (self-hostable, no SaaS). Wrap each agent iteration + each `executeTool`/MCP `tools/call` as a span → full run→model→tool tree per request. | You already have the Prometheus/Grafana-class stack + structured ledger; the gap is request-scoped tracing across worker→gateway→MCP→tool hops, which OTel spans give you, self-hostable for 152-ФЗ. | MEDIUM (one `traceId` across the BullMQ/Redis job hop) |
| 8 | **Vector / agent memory** | **pgvector on the existing Postgres** — do NOT add a separate vector DB. You already have KV memory (`agent_memory` + memory tool, migration 0023). Add a `pgvector` extension + `agent_memory_vectors(agent_id, content, embedding, created_at)` with an HNSW index. Generate embeddings **through the AIAG gateway** (OpenAI-compatible) so embedding spend flows through the same ledger. Keep KV for exact facts; use vectors for semantic recall over history + skill/tool docs. | Keeps memory in the one Postgres you operate/backup/keep RU-resident — no Pinecone/Weaviate SaaS, no second datastore on a small VPS. HNSW is production-grade at this scale. | EASY-MEDIUM |

### Hardest parts (build-order risk)
- **Isolation is a trap you've mostly architected away** — build gVisor/k3s only if/when arbitrary code execution is a real requirement; don't pre-build microVM isolation. Reserve per-user pods for the managed-Hermes tier only.
- **RU crypto legal status, not code, is the blocker** — self-hosting an x402 facilitator may make AIAG an «оператор иностранной электронной валюты» (161-ФЗ/259-ФЗ). Legal review BEFORE enabling inbound x402; ship TON/USDT credits only until cleared.
- **Gonka reconciliation** across a beta Cosmos chain must stay out-of-band (netting entries + rate snapshots), never on the synchronous run path.
- **Billing idempotency across three paths** — SSE client-abort (handled), tool-call deduct, async crypto top-up — each idempotent under concurrency; replicate the `aiag_settle_charge` pattern exactly.
- **Telegram Business + never leaking a personal handle** — enforce the generic-placeholder rule at every message-render site, not just in config.
- **Trace propagation across the BullMQ boundary** — one `runId`/`traceId` must survive the Redis job hop to reconstruct the full tool-call tree.
- **The `aiag` provider currently bypasses your own gateway** — `resolveUpstream` sends `kind='aiag'` straight to OpenRouter with a shared key, so markup + `gateway_transactions` billing are skipped for agent runs. Rewiring through `127.0.0.1:4000` is a who-gets-charged-what behavioral change — verify on the VPS.

---

## 5. Best GitHub building blocks (reuse, not rebuild)

| Repo | What it is | For which piece | License |
|------|-----------|------------------|---------|
| **mastra-ai/mastra** | TS-first agent framework (agents · tools · memory · workflows · MCP), Bun/Turborepo-native | Runtime — multi-step + memory engine over the existing BullMQ loop without leaving TS | Apache-2.0 (Elastic v2 on parts — verify) |
| **NousResearch/hermes-agent** | Self-hosted persistent agent: pluggable memory, MCP, 200+ providers, OpenAI-compat `:8642` + dashboard `:9119` | Runtime — the opt-in "managed cloud Hermes per user" R&D tier (on-brand; defaults to hermes-4-405b already) | MIT |
| **modelcontextprotocol/typescript-sdk** | Official MCP TS server/client (Streamable-HTTP, `tools/list` → `tools/call`) | MCP gateway — per-agent endpoints + tool schemas | MIT |
| **modelcontextprotocol/servers** + **registry** | Reference MCP servers + canonical server-metadata registry/schema | Маркет supply (MCP-tools surface) + ecosystem-interoperable catalog | MIT / Other |
| **IBM/mcp-context-forge** | Production MCP gateway + registry + federation on **Postgres + Redis** (the exact stack AIAG runs) | MCP gateway — drop-in registry/federation endpoint; alternative to building one | Apache-2.0 |
| **coinbase/x402** (+ **x402-foundation/x402**) | HTTP-402 pay-per-call protocol + TS/Go/Rust SDKs + facilitator interface (USDC/Base) | x402 — the wire format the "x402-shaped" external-agent billing should literally speak | Apache-2.0 |
| **x402-rs/x402-rs** | Rust self-hostable x402 facilitator (verify/settle/monitor) | x402 — own-your-rails facilitator (no Coinbase-hosted dependency; matches self-host posture) | Apache-2.0 |
| **ton-connect/sdk** (`@tonconnect/ui-react`) | Official TON Connect 2 wallet-link + tx-request | Crypto — top-up signing + connected-wallet mgmt (already the rail behind 12/14) | Apache-2.0 |
| **toncenter/ton-http-api** / **TonAPI** | Index/watch incoming TON + jUSDT transfers | Crypto — deposit detection → pending→confirmed top-up state machine + tx-hash receipts | open |
| **cosmos/cosmjs** | Cosmos signing / balance / address tooling | Crypto — Gonka GNK wallet panel + out-of-band reconciliation watcher | Apache-2.0 |
| **grammyjs/grammY** | Modern TS Telegram Bot framework; Bot API + **Telegram Business** connections; Bun-compatible | Telegram deploy — `apps/agent-bot` per-agent runtime (replaces hand-rolled `bot-api.ts`) | MIT |
| **Telegram-Mini-Apps/telegram-apps** (`@telegram-apps/sdk-react`) | Native WebApp: MainButton/BackButton/themeParams/haptics/viewport + initData validation | Native WebApp controls on run/wizard/wallet screens | MIT |
| **vercel/ai** (AI SDK, `useChat`/`useCompletion`) | Unified streaming + tool-calling + agent loops in TS | Streaming chat + run output over the OpenAI-compatible gateway | Apache-2.0 |
| **BerriAI/litellm** | OpenAI-format proxy with virtual-keys + per-key budgets + cost-map | Gateway/ledger — reference for per-key budgets (mine the schema; keep the Hono gateway) | MIT (enterprise dirs other) |
| **Helicone/helicone** or **langfuse/langfuse** | Self-hostable LLM observability / cost-per-step tracing | Observability — per-run/per-step cost attribution feeding the run-trace screen | Apache-2.0 / MIT |
| **pgvector/pgvector** | Postgres extension for vector similarity (HNSW) | Agent memory — semantic recall in the existing Postgres | PostgreSQL |
| **BuilderIO/dnd-kit** or **atlassian/pragmatic-drag-and-drop** | Performant React drag-and-drop | Tasks kanban (drag/move) | MIT / Apache-2.0 |
| **TanStack/query** + **TanStack/table** + **@tanstack/react-virtual** | Cached discovery, infinite-scroll rails, sort/filter, virtualized lists | Catalog discovery + supply sort/filter over ~73 models + large skill/MCP lists | MIT |
| **react-hook-form** + **zod** | Form + schema validation | Wizard (provider step + budget) + scratch-form validation | MIT |
| **getlago/lago** or **openmeterio/openmeter** | Self-hostable usage metering / invoicing | OPTIONAL reporting/rating layer ON TOP of the ledger (never the live-deduct system-of-record) | AGPL-3.0 / Apache-2.0 |

---

## 6. Phased roadmap (build order · dependencies · R&D)

Ordered by leverage and dependency. Each phase is shippable; R&D items are explicitly flagged
and **must not be marketed in onboarding as already working** until they back a real runtime.

### Phase 0 — Reframe + billing-truth foundation (do FIRST, unblocks everything)
- **Route `kind='aiag'` through `127.0.0.1:4000/v1`** with `AIAG_GATEWAY_KEY` + `provider.markup`, falling back to OpenRouter only if the gateway lacks the model. Verify on the VPS that `gateway_transactions` now records agent runs. *(Closes the "managed path bypasses the gateway" bug — `agent-runner.ts:48-51`.)*
- Add `aiag_deduct_tool_call(...)` stored fn + `tool_calls` ledger table (mirrors `aiag_settle_charge`; idempotency key = `tool_call_id`).
- Kill the "N models" hero across onboarding/Маркет; reframe Маркет as SUPPLY; nest the model list under «Провайдеры → AIAG-шлюз»; add per-card provider attribution.
- **Dependencies:** none. **R&D:** none. This is the truth-alignment phase.

### Phase 1 — Provider picker + supply attribution (the core reframe move)
- Real **provider-picker sheet** (AIAG default · OpenAI BYOK · Anthropic BYOK · Gonka beta · own Hermes) in agent settings AND an explicit **«На чём работает»** wizard step.
- Unified **Маркет home** (3-segment Модели/Скиллы/Тулзы + shared search); equal sort/filter across all three.
- BYOK connect hardening: rotate/revoke, last-verified, per-key spend cap (reuses `crypto.ts`).
- **Dependencies:** Phase 0 gateway routing. **R&D:** Gonka card stays «бета» behind a flag pending the spike (OpenAI-compat endpoint? p50/p95? settlement?).

### Phase 2 — Marketplace two-sided surfaces (author + remix + publish)
- **Author/Creator profile** screen, reachable from every @author handle — the #1 missing surface.
- **Remix flow**: clone → pre-filled editable create form (inherited model+prompt+tools, swap provider, "форк от @author" lineage).
- **Publish/author-an-agent** flow: list to catalog, non-personal store alias (guard against leaking personal @), per-run price, version, edit/unpublish, usage stats.
- **Ratings + written reviews** + post-run rate-this-agent prompt; replace bare synthetic ★.
- **Skill detail** screen + «Поставить» that targets a specific agent/runtime with budget impact.
- **Dependencies:** Phase 1 (provider picker feeds remix provider-swap). **R&D:** creator monetization/payout is a later sub-phase (needs publisher KYC + earnings ledger).

### Phase 3 — Wallet truth + observability (justify pay-per-call)
- **Кошелёк own nav slot**; canonical credit unit (USDT credits ≈ ₽), TON/GNK demoted to rails — kill currency soup.
- **Auto-top-up** screen (threshold · refill · source · cap · consent) — unblocks cron agents.
- **Billing + deploy error/pending states** (sibling to existing modals): tx rejected, insufficient-funds-at-deduct, agent-stopped-on-limit, top-up pending/timeout, bot-not-admin, token-revoked, Business-not-granted.
- **Run-trace / observability** screen: per-step tool-call timeline with USDT cost + latency + status (OpenTelemetry spans + the `tool_calls` table).
- Transaction-detail / receipt screen.
- **Dependencies:** Phase 0 `tool_calls` ledger + Phase 4 MCP gateway (for real per-step tool costs); ledger-only traces can ship before the MCP gateway. **R&D:** none for the off-chain ledger path.

### Phase 4 — MCP tool gateway + per-call metering (the supply engine)
- `apps/mcp-gateway` (Hono + `@modelcontextprotocol/sdk`, Streamable-HTTP), per-agent endpoints + per-tenant bearer.
- Tools catalog wired to per-call deduction via `aiag_deduct_tool_call`; first-party (key-broker, no key) vs third-party (OAuth-required indicator) distinction in UI.
- **Dependencies:** Phase 0 ledger. **R&D:** OAuth 2.1 + PKCE + RFC 8707 deferred to the 3rd-party-host phase; bearer-auth in v1.

### Phase 5 — Telegram delivery + native WebApp controls + legal
- `apps/agent-bot` on grammY; Bot API channels/groups as default; **Telegram Business gated** behind a Premium check + scope-consent + capability disclaimer.
- Native WebApp controls (MainButton/BackButton/themeParams/haptics/keyboard-open) on run/wizard/wallet.
- **152-ФЗ / privacy** screen + receipts/period-statement export (PDF/CSV) + fiat/RF-card top-up path.
- Profile completeness: settings, notifications, logout/switch/delete.
- **Dependencies:** none hard (parallelizable with 3/4). **R&D:** none — but legal review of the two-entity / 152-ФЗ posture is a gate.

### R&D track (explicitly NOT marketed as live)
- **Managed cloud Hermes per user** — k3s + per-user namespace/PVC + S3 archive + hibernation + SecComp/NetworkPolicy isolation. Single biggest cost/ops bet. Keep the stateless worker as "managed agent" (drop the "Hermes spin-up" fiction) until real infra backs it.
- **Gonka (GNK)** — spike OpenAI-compat endpoint + latency + settlement before rendering a live provider card.
- **x402 external-agent inbound** — reserved/stubbed until legal review clears 161-ФЗ/259-ФЗ; then self-host the facilitator.
- **pgvector semantic memory surface** + agent groups / Swarm / shared memory.

---

## 7. Reframe-ready — concrete next wireframe/build actions

1. **Phase 0 build:** rewire `resolveUpstream` so `kind='aiag'` hits `127.0.0.1:4000/v1` (markup + `gateway_transactions`); add `aiag_deduct_tool_call` + `tool_calls` table. Verify billing on the VPS.
2. **Wireframe — Author/Creator profile** (new screen): make every @author handle on catalog cards tappable → avatar · total runs · agent grid · follow · verified badge. Highest-leverage missing surface.
3. **Wireframe — Provider picker sheet** + insert the **«На чём работает»** wizard step between Где and Что (reuse the Провайдеры cards); convert the flat settings provider row into the sheet.
4. **Wireframe — Remix flow:** turn the clone stub into a pre-filled editable create form (inherited model+prompt+tools, provider swap, "форк от @author" lineage) + post-run rate prompt + per-run TON/USDT cost line.
5. **Wireframe — Run-trace screen** opening from runs history and kanban «Готово»: step timeline (web-search → scrape → generate) with per-step USDT cost + latency + status.
6. **Wireframe — Unified Маркет supply home** (3-segment top control + shared search) with per-card provider attribution on models and equal sort/filter across Модели/Скиллы/Тулзы.
7. **Wireframe — Кошелёк** with its own nav slot, canonical credit unit, real **Auto-top-up** screen, and **billing/deploy error + pending** states.
8. **Wireframe — Publish-an-agent + Skill-detail + 152-ФЗ/receipts** screens; harden the personal-handle guard (mask @user in kanban; default published-agent author display to a non-personal alias).
