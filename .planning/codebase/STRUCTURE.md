# Codebase Structure — TMA + Agent-Worker

**Analysis Date:** 2026-06-02
**Scope:** `apps/tg-miniapp/`, `apps/agent-worker/`, relevant `packages/`

---

## Top-Level Monorepo Layout

```
aggregator/
├── apps/
│   ├── tg-miniapp/          # Next.js 14 Telegram Mini App (port 3100, basePath /tg)
│   ├── agent-worker/        # BullMQ worker — agentic LLM loop (port 3101)
│   ├── web/                 # Main web app (separate scope — not documented here)
│   └── worker/              # Contest/eval worker (separate scope)
├── packages/
│   ├── api-gateway/         # Hono OpenAI-compatible gateway (port 4000) — NOT used by agent-runner
│   ├── shared/              # Startonus NFT client, S3, tax utils
│   ├── database/            # Shared Drizzle schema (used by web/worker, NOT by tg-miniapp)
│   ├── email/               # Email templates
│   ├── telegram-alerts/     # Telegram alerting
│   ├── tinkoff/             # Tinkoff payment adapter
│   ├── upstream-adapters/   # LLM upstream adapters (for web gateway)
│   └── typescript-config/   # Shared tsconfig presets
├── .planning/               # GSD planning docs (this file's home)
├── turbo.json               # Turborepo build pipeline
└── package.json             # Workspace root
```

---

## `apps/tg-miniapp/` Directory Layout

```
apps/tg-miniapp/
├── app/
│   ├── api/
│   │   └── tma/
│   │       ├── agents/
│   │       │   ├── route.ts                  # GET list, POST create agent
│   │       │   ├── test-external/
│   │       │   │   └── route.ts              # POST probe external OpenAI endpoint
│   │       │   └── [id]/
│   │       │       ├── route.ts              # GET detail+runs, PATCH update, DELETE
│   │       │       └── run/
│   │       │           └── route.ts          # POST enqueue agent run → BullMQ
│   │       ├── auth/
│   │       │   └── verify/
│   │       │       └── route.ts              # POST initData → HMAC verify → JWT
│   │       ├── marketplace/
│   │       │   ├── route.ts                  # GET model catalog list (50 items)
│   │       │   └── [slug]/
│   │       │       └── route.ts              # GET single model by slug
│   │       ├── nft/
│   │       │   ├── collections/
│   │       │   │   └── route.ts              # GET active NFT collections
│   │       │   ├── purchase/
│   │       │   │   └── route.ts              # POST initiate NFT purchase via Startonus
│   │       │   └── webhook/
│   │       │       └── route.ts              # POST Startonus mint lifecycle callback
│   │       ├── topup/
│   │       │   ├── route.ts                  # GET topup history (last 20)
│   │       │   ├── init/
│   │       │   │   └── route.ts              # POST create TON topup intent
│   │       │   └── check/
│   │       │       └── [id]/
│   │       │           └── route.ts          # POST reconcile topup via TonCenter
│   │       └── wallet/
│   │           ├── route.ts                  # GET linked wallets + balance
│   │           └── link/
│   │               └── route.ts              # POST link TON wallet (MVP: no proof verify)
│   ├── agents/
│   │   ├── page.tsx                          # Agent list page (client)
│   │   ├── new/
│   │   │   └── page.tsx                      # Agent creation wizard (client)
│   │   └── [id]/
│   │       └── page.tsx                      # Agent detail + chat history (client)
│   ├── market/
│   │   ├── page.tsx                          # Marketplace model grid (client)
│   │   └── [slug]/
│   │       ├── page.tsx                      # Model detail page (client)
│   │       └── UseInAgentButton.tsx          # "Use in agent" CTA (client component)
│   ├── nft/
│   │   ├── page.tsx                          # NFT collection list (client)
│   │   └── [slug]/
│   │       ├── page.tsx                      # NFT detail + buy flow (client)
│   │       └── BuyButton.tsx                 # TonConnect buy button (client component)
│   ├── profile/
│   │   ├── page.tsx                          # Profile page: balance, wallet, history (client)
│   │   └── topup/
│   │       └── page.tsx                      # Topup flow page (client)
│   ├── health/
│   │   └── route.ts                          # GET /tg/health — liveness probe
│   ├── layout.tsx                            # Root layout: wraps <Providers>
│   ├── page.tsx                              # Home page (redirects to /agents)
│   └── providers.tsx                         # 'use client' — TonConnectUIProvider
├── src/
│   ├── components/
│   │   └── BottomNav.tsx                     # Bottom navigation bar (client)
│   ├── hooks/
│   │   └── useAuth.ts                        # TMA auth hook: CloudStorage cache + JWT refresh
│   └── lib/
│       ├── agent-templates.ts                # 6 preset agent templates (writer, coder, etc.)
│       ├── crypto.ts                         # AES-256-GCM encrypt/decrypt (mirror of agent-worker)
│       ├── external-agent.ts                 # SSRF guard + external endpoint probe
│       ├── ton-proof.ts                      # TON Connect proof verify (MVP stub — always false)
│       ├── ton-rate.ts                       # TON/RUB rate via CoinGecko, 60s in-memory cache
│       └── verify-init-data.ts              # Telegram initData HMAC-SHA256 verification
├── next.config.mjs                           # basePath: '/tg', transpile TMA/TON packages
├── package.json                              # @aiag/tg-miniapp, Next 14, jose, bullmq, ioredis
└── tsconfig.json
```

---

## `apps/agent-worker/` Directory Layout

```
apps/agent-worker/
├── src/
│   ├── index.ts          # Entry: BullMQ Worker('agent-run') + HTTP healthcheck :3101
│   ├── agent-runner.ts   # Core: runAgent() — full agentic loop, resolveUpstream(), callModel()
│   ├── db.ts             # All DB access: loadRun, loadAgent, budget funcs, markStarted/Completed/Failed
│   ├── tools.ts          # Tool registry + executeTool(): web_search, calc, image_gen, memory
│   ├── bot-api.ts        # Telegram Bot API: sendBotMessage(), DM notification builders
│   ├── crypto.ts         # AES-256-GCM decryptSecret() for external API keys
│   └── types.ts          # Shared types: Message, ToolCall, ToolDef, AgentRunRow
├── dist/                 # Compiled output (tsc)
├── package.json          # @aiag/agent-worker, ESM, bullmq, ioredis, postgres
└── tsconfig.json
```

---

## `packages/api-gateway/` Directory Layout (relevant for context)

```
packages/api-gateway/src/
├── server.ts             # Hono app definition — /v1/* routes wired here
├── server-node.ts        # Node entry: @hono/node-server on port 4000
├── config.ts             # Zod-validated env config (PORT default 8787, but server-node overrides to 4000)
├── routes/v1/
│   ├── chat.ts           # POST /v1/chat/completions — billing via settleCharge()
│   ├── completions.ts    # POST /v1/completions
│   ├── embeddings.ts     # POST /v1/embeddings
│   ├── images.ts         # POST /v1/images/generations
│   ├── models.ts         # GET /v1/models
│   ├── balance.ts        # GET /v1/balance
│   ├── video.ts          # POST /v1/video/generations
│   ├── audio.ts          # POST /v1/audio/...
│   └── batches.ts        # POST /v1/batches
├── billing/
│   └── settle.ts         # settleCharge() → aiag_settle_charge() stored function
├── middleware/
│   ├── auth-plan04.ts    # requireApiKey middleware
│   ├── rate-limit-plan04.ts
│   ├── pii-filter.ts
│   ├── model-status-check.ts
│   ├── moderation.ts
│   ├── transborderGate.ts
│   └── antiFraud.ts
├── upstreams/
│   ├── openrouter.ts     # OpenRouter adapter
│   ├── kie.ts            # Kie.ai adapter
│   ├── groq.ts
│   ├── ollama.ts
│   └── registry.ts       # getUpstream(provider) dispatcher
├── streaming/
│   └── sse.ts            # streamSseAndSettle() — SSE proxy with mid-stream billing
└── routing/
    ├── resolver.ts        # resolveModelWithOverride()
    ├── engine.ts          # pickUpstream()
    └── policies.ts        # Session budget checks
```

---

## `packages/shared/` Key Files

```
packages/shared/src/
├── startonus.ts          # generateInvoice() — Startonus NFT minter API client
├── s3.ts                 # S3 upload helpers
├── revshare.ts           # Revenue share calculation
├── tax.ts                # VAT/tax helpers
└── index.ts              # Re-exports
```

---

## API Route Map — `apps/tg-miniapp/app/api/tma/`

| HTTP Method | Path (under `/tg`) | File | Purpose | Auth |
|-------------|---------------------|------|---------|------|
| POST | `/api/tma/auth/verify` | `auth/verify/route.ts` | initData HMAC verify → JWT issue | None (public) |
| GET | `/api/tma/agents` | `agents/route.ts` | List user's agents | `x-tma-user-id` |
| POST | `/api/tma/agents` | `agents/route.ts` | Create agent (aiag or external_openai) | `x-tma-user-id` |
| GET | `/api/tma/agents/:id` | `agents/[id]/route.ts` | Agent detail + last 20 runs | `x-tma-user-id` |
| PATCH | `/api/tma/agents/:id` | `agents/[id]/route.ts` | Update agent (name, prompt, tools, budget) | `x-tma-user-id` |
| DELETE | `/api/tma/agents/:id` | `agents/[id]/route.ts` | Delete agent | `x-tma-user-id` |
| POST | `/api/tma/agents/:id/run` | `agents/[id]/run/route.ts` | Enqueue agent run → BullMQ → 202 | `x-tma-user-id` |
| POST | `/api/tma/agents/test-external` | `agents/test-external/route.ts` | Probe external OpenAI endpoint (SSRF-guarded) | `x-tma-user-id` |
| GET | `/api/tma/marketplace` | `marketplace/route.ts` | List enabled models (up to 50) | None (public) |
| GET | `/api/tma/marketplace/:slug` | `marketplace/[slug]/route.ts` | Single model detail | None (public) |
| GET | `/api/tma/nft/collections` | `nft/collections/route.ts` | List active NFT collections | None (public) |
| POST | `/api/tma/nft/purchase` | `nft/purchase/route.ts` | Initiate NFT purchase via Startonus | `x-tma-user-id` |
| POST | `/api/tma/nft/webhook` | `nft/webhook/route.ts` | Startonus mint lifecycle callback | None (verified by purchaseId UUID) |
| GET | `/api/tma/topup` | `topup/route.ts` | Topup history (last 20) | `x-tma-user-id` |
| POST | `/api/tma/topup/init` | `topup/init/route.ts` | Create TON topup intent | `x-tma-user-id` |
| POST | `/api/tma/topup/check/:id` | `topup/check/[id]/route.ts` | Poll TonCenter + credit balance | `x-tma-user-id` |
| GET | `/api/tma/wallet` | `wallet/route.ts` | List linked wallets + balance | `x-tma-user-id` |
| POST | `/api/tma/wallet/link` | `wallet/link/route.ts` | Link TON wallet (MVP: no proof) | `x-tma-user-id` |
| GET | `/health` | `health/route.ts` | Liveness probe | None (public) |

---

## Key File Locations

**Entry Points:**
- `apps/tg-miniapp/app/layout.tsx` — Root Next.js layout.
- `apps/agent-worker/src/index.ts` — Worker process entry.
- `packages/api-gateway/src/server-node.ts` — Hono gateway entry.

**Configuration:**
- `apps/tg-miniapp/next.config.mjs` — basePath `/tg`, transpile list.
- `apps/agent-worker/package.json` — ESM module, build with `tsc`.
- `packages/api-gateway/src/config.ts` — Zod env schema.

**Core Logic:**
- `apps/agent-worker/src/agent-runner.ts` — All agent run orchestration.
- `apps/agent-worker/src/db.ts` — All DB reads/writes for the worker.
- `apps/agent-worker/src/tools.ts` — Tool implementations.
- `apps/tg-miniapp/src/lib/verify-init-data.ts` — Telegram auth.
- `apps/tg-miniapp/src/lib/external-agent.ts` — SSRF guard + endpoint probe.

**Shared:**
- `packages/shared/src/startonus.ts` — NFT minter.
- `packages/api-gateway/src/billing/settle.ts` — Gateway billing (NOT used by agent-runner).

---

## Naming Conventions

**Files:**
- API routes: `route.ts` (Next.js App Router convention).
- Library helpers: `kebab-case.ts` (e.g., `verify-init-data.ts`, `external-agent.ts`, `ton-rate.ts`).
- Components: `PascalCase.tsx` (e.g., `BottomNav.tsx`, `BuyButton.tsx`).
- Pages: `page.tsx` (Next.js convention).

**Functions:**
- Route handlers: `GET`, `POST`, `PATCH`, `DELETE` (named exports matching HTTP methods).
- DB helpers: verb + noun, camelCase (`loadRun`, `markCompleted`, `getOrResetDailyBucket`).
- Lib functions: descriptive camelCase (`verifyInitData`, `resolveUpstream`, `pickToolDefs`, `encryptSecret`).

**TypeScript interfaces:**
- Database row shapes: `SomeNameRow` (e.g., `AgentRow`, `AgentRunRow`, `HistoryRow`).
- Request bodies: `Body` or descriptive inline (e.g., `RunBody`, `CreateBody`, `PatchBody`).

**Environment variables (TMA + agent-worker):**
- `DATABASE_URL` — Postgres connection string.
- `REDIS_URL` — Redis, default `redis://127.0.0.1:6379`.
- `TELEGRAM_BOT_TOKEN` — For initData HMAC verify (TMA).
- `TG_BOT_TOKEN` — For DM notifications (agent-worker — note different var name!).
- `TMA_JWT_SECRET` — JWT signing secret.
- `TMA_KEY_ENCRYPTION_KEY` — AES-256-GCM key, 64 hex chars.
- `OPENROUTER_API_KEY` — Used by agent-runner for `connection_type='aiag'` agents.
- `KIE_API_KEY` — Used by `image_gen` tool.
- `TMA_TOPUP_WALLET_ADDRESS` — Receiving TON wallet for topups.
- `TONCENTER_API_URL` / `TONCENTER_API_KEY` — TonCenter v3 for topup reconciliation.
- `STARTONUS_SECRET` / `STARTONUS_BASE_URL` — Startonus NFT minter.
- `NEXT_PUBLIC_TONCONNECT_MANIFEST_URL` — TonConnect manifest URL.
- `PUBLIC_BASE_URL` — Used for Startonus callback URL construction.
- `TMA_APP_BASE_URL` — Used in bot DM deep-links (agent-worker).

---

## Where to Add New Code

**New TMA API endpoint:**
- Create `app/api/tma/<feature>/route.ts` (GET/POST/PATCH/DELETE named exports).
- Auth: add `const tgUserId = req.headers.get('x-tma-user-id'); if (!tgUserId) return 401;` at top.
- Add `export const runtime = 'nodejs'` and `export const dynamic = 'force-dynamic'`.
- Tests: none currently for TMA routes — verify on VPS.

**New agent tool:**
- Add `ToolDef` entry to `TOOL_DEFS` array in `apps/agent-worker/src/tools.ts`.
- Add `case 'tool_name':` to `executeTool()` dispatcher in same file.
- Add tool name to relevant templates in `apps/tg-miniapp/src/lib/agent-templates.ts`.

**New agent template:**
- Add `AgentTemplate` object to `AGENT_TEMPLATES` array in `apps/tg-miniapp/src/lib/agent-templates.ts`.

**New TMA client page:**
- Create `app/<feature>/page.tsx` (RSC shell that renders a `'use client'` component).
- Use `useAuth()` hook for auth state.

**New shared utility:**
- Place in `packages/shared/src/` if needed by multiple apps.
- Place in `apps/tg-miniapp/src/lib/` if TMA-only.
- Place in `apps/agent-worker/src/` if worker-only.

---

## Special Directories

**`apps/tg-miniapp/.next/`:**
- Purpose: Next.js build output.
- Generated: Yes.
- Committed: No.

**`apps/agent-worker/dist/`:**
- Purpose: TypeScript compiled output (`tsc`).
- Generated: Yes.
- Committed: No (but present in repo due to VPS deploy copying strategy).

**`packages/api-gateway/dist/`:**
- Purpose: Compiled gateway library.
- Generated: Yes (via `tsup`).
- Committed: No.

**`.planning/`:**
- Purpose: GSD planning documents, phase state, codebase maps.
- Generated: No (human/AI-authored).
- Committed: Yes.

---

*Structure analysis: 2026-06-02*
