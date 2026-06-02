# Architecture — TMA + Agent-Worker

**Analysis Date:** 2026-06-02
**Scope:** `apps/tg-miniapp/`, `apps/agent-worker/`, `packages/api-gateway/` (Hono gateway on :4000)

---

## Pattern Overview

**Overall:** Event-driven async processing with a synchronous API facade.

**Key Characteristics:**
- Next.js 14 App Router (TMA) acts as thin REST API facade — no server-side rendering logic, pure API routes + client-side React pages.
- Agent runs are fire-and-forget: the API route returns 202 immediately after inserting a DB row and enqueuing a BullMQ job.
- The Hono gateway (`packages/api-gateway/`) is NOT in the agent-runner's call path (see P0 billing-bypass bug below). It serves the web app's user-facing OpenAI-compatible proxy (`/v1/*`).
- All auth within the TMA is header-based: JWT (`x-tma-user-id` extracted by middleware, or directly by route handlers reading the header directly — see gap below).

---

## Layers

**TMA API (Next.js App Router):**
- Purpose: HTTP API consumed by the TMA React client.
- Location: `apps/tg-miniapp/app/api/tma/`
- Contains: Route handlers for auth, agents CRUD, agent run enqueue, NFT, wallet, topup.
- Depends on: `postgres` (direct SQL — no ORM), `bullmq`/`ioredis` (enqueue only), `@aiag/shared` (Startonus), `src/lib/*` helpers.
- Used by: TMA React client pages (`apps/tg-miniapp/app/agents/`, etc.).

**TMA Client Pages (React/Next.js client components):**
- Purpose: Telegram Mini App UI.
- Location: `apps/tg-miniapp/app/agents/`, `apps/tg-miniapp/app/market/`, `apps/tg-miniapp/app/nft/`, `apps/tg-miniapp/app/profile/`
- Contains: RSC page shells + `'use client'` interactive components.
- Depends on: `useAuth` hook, TonConnect UI, TMA SDK.
- Used by: End user via Telegram WebView.

**Agent Worker (`apps/agent-worker/`):**
- Purpose: BullMQ consumer — reads `agent-run` queue from Redis, executes the full LLM agentic loop, writes results to Postgres, sends Telegram DM on completion.
- Location: `apps/agent-worker/src/`
- Contains: `index.ts` (worker bootstrap), `agent-runner.ts` (orchestration), `db.ts` (all DB reads/writes), `tools.ts` (tool implementations), `bot-api.ts` (TG DM notify), `crypto.ts` (AES-256-GCM decrypt).
- Depends on: `bullmq`/`ioredis`, `postgres`, external LLM APIs (OpenRouter or user's own).
- Used by: Nothing calls agent-worker directly; it self-polls Redis queue.

**Hono Gateway (`packages/api-gateway/`):**
- Purpose: OpenAI-compatible `/v1/*` proxy for the web app's paying users. Handles API key auth, billing via `aiag_settle_charge` stored function, rate limits, PII filter, moderation, streaming SSE.
- Location: `packages/api-gateway/src/`
- Entry: `src/server-node.ts` — starts `@hono/node-server` on `PORT` (default 4000 per `server-node.ts` line 12).
- Contains: `server.ts` (Hono app), `routes/v1/chat.ts` (chat completions), `billing/settle.ts`, `upstreams/` adapters (openrouter, kie, groq, ollama).
- Used by: Web app users hitting `https://app.ai-aggregator.ru` — NOT used by the agent-worker.

---

## CRITICAL: P0 Billing-Bypass Bug — Confirmed

**The agent-runner calls OpenRouter directly, bypassing the Hono gateway entirely.**

Trace in `apps/agent-worker/src/agent-runner.ts`:

```
Line 21:  const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
Line 49:  return { url: OPENROUTER_URL, apiKey, model, isExternal: false };  // aiag path
Line 117: const res = await fetch(upstream.url, { ... });                    // callModel()
```

- For `connection_type = 'aiag'` agents: `resolveUpstream()` (lines 33–52) returns `url = 'https://openrouter.ai/api/v1/chat/completions'` with `OPENROUTER_API_KEY` from env. This calls OpenRouter directly.
- The Hono gateway (`127.0.0.1:4000`) is **never called** by the agent-runner.
- The gateway's `settleCharge()` (`packages/api-gateway/src/billing/settle.ts`) is therefore **never executed** for any agent run.
- Cost is estimated client-side by the worker itself using a hardcoded `PRICING` table (lines 56–65) and then written to `agent_runs.cost_rub` via `markCompleted()` and `agents.spent_today_rub` via `incrementDailySpend()`. This is a local estimate, not a gateway-billed charge against the user's platform balance.
- **User `tg_user_balances` is never debited by agent runs.** The only path that credits/debits `tg_user_balances` is the TON topup flow (`apps/tg-miniapp/app/api/tma/topup/check/[id]/route.ts` line 149–155).

For `connection_type = 'external_openai'` agents: `resolveUpstream()` (lines 34–46) calls the user's own endpoint directly. `isExternal: true` → `totalCostRub` stays 0 (line 228), so no internal cost tracking at all.

---

## End-to-End Agent Run Flow

### Step 1 — Client → TMA API Route

File: `apps/tg-miniapp/app/api/tma/agents/[id]/run/route.ts`

```
POST /tg/api/tma/agents/:id/run
  Header: x-tma-user-id: <tg_user_id>   ← set by middleware or client
  Body: { input: "user message" }
```

1. Line 21: Reads `x-tma-user-id` from request header (no JWT verify here — trusts header).
2. Lines 37–44: Ownership check — `SELECT FROM agents WHERE id=? AND tg_user_id=? AND status='active'`.
3. Lines 46–55: `INSERT INTO agent_runs (agent_id, tg_user_id, input, status='pending') RETURNING id`.
4. Lines 62–76: Dynamically imports `bullmq.Queue` + `ioredis.IORedis`, connects to `REDIS_URL` (default `redis://127.0.0.1:6379`), calls `queue.add('run', { runId }, ...)`.
5. Returns `{ run_id, status: 'pending' }` with HTTP 202.

**Note:** The route comment says "Stub: Wave 04 wires the real agent-worker" but the BullMQ enqueue is real and functional.

### Step 2 — BullMQ Queue → Agent Worker

File: `apps/agent-worker/src/index.ts`

- Line 14: `new Worker('agent-run', async (job) => { ... }, { connection, concurrency: 4 })`.
- Line 17: Extracts `runId` from `job.data.runId`.
- Line 21: Calls `await runAgent(runId)` from `agent-runner.ts`.

### Step 3 — `runAgent()` Orchestration

File: `apps/agent-worker/src/agent-runner.ts`, function `runAgent()` at line 159.

1. **Lines 160–168:** `loadRun(runId)` → `loadAgent(run.agent_id)` from `db.ts`. If either missing → `markFailed()`.
2. **Lines 171–184:** Budget gates:
   - `sumMonthlySpend(agent.tg_user_id)` — sums `agent_runs.cost_rub` for this month.
   - `getOrResetDailyBucket(agent.id)` — atomically resets `agents.spent_today_rub` if date stale (MSK timezone), returns current bucket.
   - If either limit exceeded → `markFailed()` + Telegram DM notification.
3. **Line 186:** `markStarted(runId)` — `UPDATE agent_runs SET status='running'`.
4. **Lines 188–195:** `loadHistory()` — last 10 completed runs for this agent, built into `messages[]` array.
5. **Lines 198–206:** `resolveUpstream(agent)` — determines LLM endpoint (see below).
6. **Line 207:** `pickToolDefs(agent.tools)` — filters `TOOL_DEFS` by agent's allowed tools list.
7. **Lines 213–283:** Agentic loop (max 12 iterations, `MAX_ITERATIONS`):
   - `callModel(upstream, messages, tools)` → `fetch(upstream.url, ...)`.
   - Accumulates `tokensIn`/`tokensOut`, re-checks budget mid-run (lines 232–242).
   - On no tool calls → `markCompleted()` + `incrementDailySpend()` + Telegram DM → return.
   - On tool calls → `executeTool()` for each → append tool result to messages → next iteration.
8. **Line 286:** If loop exhausts → `markFailed('max_iterations_exceeded')`.

### Step 4 — `resolveUpstream()` (aiag vs external)

File: `apps/agent-worker/src/agent-runner.ts`, lines 33–52.

```typescript
function resolveUpstream(agent: AgentRow): Upstream {
  if (agent.connection_type === 'external_openai') {
    // Lines 35–46: Uses agent.external_base_url + decryptSecret(agent.external_api_key_encrypted)
    // → calls user's own endpoint directly
    return { url, apiKey, model, isExternal: true };
  }
  // aiag path (line 48–51):
  const apiKey = process.env.OPENROUTER_API_KEY;
  return { url: 'https://openrouter.ai/api/v1/chat/completions', apiKey, model, isExternal: false };
}
```

- **`connection_type = 'aiag'`** → `https://openrouter.ai/api/v1/chat/completions` with `OPENROUTER_API_KEY`. Hono gateway at `127.0.0.1:4000` is **not involved**.
- **`connection_type = 'external_openai'`** → User's URL (decrypted from `agents.external_api_key_encrypted` via AES-256-GCM). No cost tracked.

### Step 5 — Completion Notifications

File: `apps/agent-worker/src/bot-api.ts`.

- `sendBotMessage()` (line 19) — calls `https://api.telegram.org/bot{TG_BOT_TOKEN}/sendMessage`.
- Sends HTML-formatted DM with run result preview and deep-link back to the agent page.

---

## Auth Flow

### Step 1 — Telegram initData HMAC Verify

File: `apps/tg-miniapp/src/lib/verify-init-data.ts`, function `verifyInitData()` at line 20.

Algorithm (per Telegram spec):
1. Parse `rawInitData` as `URLSearchParams`.
2. Extract and delete `hash` param.
3. Sort remaining params alphabetically, join as `key=value\n` pairs → `dataCheckString`.
4. `secretKey = HMAC-SHA256("WebAppData", botToken)`.
5. `computedHash = HMAC-SHA256(secretKey, dataCheckString)`.
6. Compare with extracted `hash` (constant-time implicit — standard string compare, not constant-time — minor security note).
7. Check `auth_date` not older than 86400s (24h).

### Step 2 — JWT Issue

File: `apps/tg-miniapp/app/api/tma/auth/verify/route.ts`.

1. Calls `verifyInitData(initData, process.env.TELEGRAM_BOT_TOKEN)`.
2. `UPSERT INTO tg_users` — updates user record with latest Telegram profile fields.
3. Issues HS256 JWT via `jose.SignJWT` with `sub = String(user.id)`, 24h expiry, secret from `TMA_JWT_SECRET` env.
4. Returns `{ token, user }`.

### Step 3 — Client JWT Caching

File: `apps/tg-miniapp/src/hooks/useAuth.ts`.

1. Checks Telegram CloudStorage for cached `aiag_jwt` token.
2. `isTokenUsable()` (line 18) — decodes JWT payload client-side, checks `exp - 60s > now`.
3. On fresh token or expired: `POST /tg/api/tma/auth/verify` with `initData`.
4. Stores new token in CloudStorage via `tg.CloudStorage.setItem('aiag_jwt', ...)`.

### Step 4 — API Route Auth Gap

**All protected API routes read `x-tma-user-id` from request headers directly.** Example:
- `apps/tg-miniapp/app/api/tma/agents/[id]/run/route.ts` line 21: `req.headers.get('x-tma-user-id')`.
- `apps/tg-miniapp/app/api/tma/agents/route.ts` line 29: same pattern.

There is **no middleware that verifies the JWT and sets `x-tma-user-id`**. The routes trust whatever value the client sends in `x-tma-user-id`. This means any client can impersonate any `tg_user_id` by setting this header manually. The ownership checks (e.g., `WHERE tg_user_id = ${tgUserId}::bigint`) prevent cross-user data access for owned resources, but do not prevent acting as another user for resource creation.

---

## NFT Purchase Flow

File: `apps/tg-miniapp/app/api/tma/nft/purchase/route.ts`

1. Client sends `{ collection_slug, recipient_address }`.
2. Route loads `nft_collections` row — checks `status='active'`, supply not exhausted, `startonus_collection_id` set.
3. `INSERT INTO nft_purchases (status='pending')` → gets `purchaseId` UUID.
4. Calls `generateInvoice()` from `packages/shared/src/startonus.ts` → POST to `https://bot.startonus.com/api/minter/generate-invoice/custom` with `userData = purchaseId`.
5. Startonus returns TON Connect transaction params. Route stores `startonus_invoice_id` in `nft_purchases`.
6. Returns `{ purchase_id, transaction: { validUntil, messages: [{ address, amount, payload }] } }` — client passes `transaction` to `TonConnectUI.sendTransaction()`.
7. After TON tx confirms on-chain, Startonus calls webhook at `POST /tg/api/tma/nft/webhook`.
8. Webhook (`apps/tg-miniapp/app/api/tma/nft/webhook/route.ts`) handles events `invoice_paid` → `minted`/`failed`. On `minted`: transaction wraps `UPDATE nft_purchases SET status='minted'` + `UPDATE nft_collections SET minted_count = minted_count + 1`.

---

## TON Wallet Link + Topup Flow

**Wallet Link:**
File: `apps/tg-miniapp/app/api/tma/wallet/link/route.ts`

- `POST /tg/api/tma/wallet/link` with `{ address, public_key? }`.
- `UPSERT INTO ton_wallets` with `is_verified=FALSE`. Ed25519 proof verification is a TODO stub (`src/lib/ton-proof.ts` — `verifyTonProof()` always returns `false`, documented as MVP).

**Topup Init:**
File: `apps/tg-miniapp/app/api/tma/topup/init/route.ts`

1. `POST /tg/api/tma/topup/init` with `{ amount_rub, wallet_address }`.
2. Fetches TON/RUB rate from CoinGecko via `getTonRubRate()` (`src/lib/ton-rate.ts`) — 60s in-memory cache.
3. Generates random 8-char `comment_tag` (Crockford alphabet).
4. Encodes TON text comment cell (`topup:<tag>`, opcode 0 + UTF-8 tail) via `@ton/core.beginCell()`.
5. `INSERT INTO tg_topups (status='pending', comment_tag)`.
6. Returns TON Connect transaction params to client.

**Topup Check (client-driven poll):**
File: `apps/tg-miniapp/app/api/tma/topup/check/[id]/route.ts`

1. `POST /tg/api/tma/topup/check/:id`.
2. Queries TonCenter v3 API (`TONCENTER_API_URL` env, default `https://toncenter.com/api/v3/transactions`) for last 20 inbound txs on `TMA_TOPUP_WALLET_ADDRESS`.
3. Scans txs for `in_msg.message` containing `topup:<tag>` + value ≥ expected nano.
4. On match: `UPDATE tg_topups SET status='confirmed' WHERE status='pending'` (atomic guard against double-credit).
5. `UPSERT INTO tg_user_balances ... SET balance_rub = balance_rub + amount_rub`.

---

## Key Abstractions

**`AgentRow` (db.ts):**
- Purpose: Represents an agent configuration row from `agents` table.
- File: `apps/agent-worker/src/db.ts` lines 11–27.
- Key fields: `connection_type: 'aiag' | 'external_openai'`, `external_base_url`, `external_api_key_encrypted` (Buffer — AES-256-GCM blob), `budget_rub_monthly`, `daily_budget_rub`, `spent_today_rub`.

**`Upstream` (agent-runner.ts):**
- Purpose: Resolved LLM endpoint — URL, API key, model, whether it's external (user-supplied).
- File: `apps/agent-worker/src/agent-runner.ts` lines 26–31.
- `isExternal: true` → cost tracking skipped.

**`TOOL_DEFS` / `executeTool()` (tools.ts):**
- Purpose: Tool registry + dispatcher. 4 tools: `web_search`, `calc`, `image_gen`, `memory`.
- File: `apps/agent-worker/src/tools.ts`.
- `web_search`: scrapes DuckDuckGo HTML (no API key needed).
- `image_gen`: Kie.ai `nano-banana-pro` — `createTask` → poll → URL (adds `KIE_COST_RUB = 6.5` to `totalCostRub`).
- `memory`: Postgres-backed per-agent KV store (`agent_memory` table).
- `code_interpreter`: declared in templates, in `UNIMPLEMENTED_TOOLS` set — returns safe error, never crashes run.

**`encryptSecret` / `decryptSecret` (crypto.ts):**
- AES-256-GCM, key from `TMA_KEY_ENCRYPTION_KEY` env (64 hex chars = 32 bytes).
- Blob layout: 12-byte IV | ciphertext | 16-byte auth tag.
- Duplicated identically in `apps/tg-miniapp/src/lib/crypto.ts` and `apps/agent-worker/src/crypto.ts`.

**`PRICING` table (agent-runner.ts):**
- Lines 56–65: Hardcoded USD/1M token prices for 8 models.
- `FALLBACK_PRICE = { in: 1.0, out: 2.0 }` for unknown models.
- `USD_TO_RUB = 90` — hardcoded, not using CBR rate (the Hono gateway uses CBR; agent-worker does not).

---

## Entry Points

**TMA (Next.js):**
- Server: `apps/tg-miniapp/app/layout.tsx` — root layout wrapping `<Providers>` (TonConnectUIProvider).
- API: `apps/tg-miniapp/app/api/tma/` — all REST endpoints.
- Health: `apps/tg-miniapp/app/health/route.ts` → `GET /tg/health`.
- Port: 3100 (`next start -p 3100`).
- basePath: `/tg` (`next.config.mjs` line 4).

**Agent Worker:**
- Entry: `apps/agent-worker/src/index.ts` — starts BullMQ worker + HTTP healthcheck server.
- Port: `process.env.PORT ?? 3101` (line 7).
- Health: `GET http://localhost:3101/` returns `{ ok: true, service: 'agent-worker' }`.

**Hono Gateway:**
- Entry: `packages/api-gateway/src/server-node.ts` — `@hono/node-server` adapter.
- Port: `parseInt(process.env.PORT || '4000', 10)` (line 12).
- Note: `config.ts` has `PORT: z.coerce.number().default(8787)` but `server-node.ts` hardcodes default `'4000'`. The `server-node.ts` value wins on Node deployments.

---

## Error Handling

**Strategy:** Each layer handles locally; failures surface via DB status fields and Telegram DM notifications.

**TMA API routes:**
- Return JSON error objects with descriptive `error` string codes.
- No centralized error middleware — each route has inline try/catch.
- Enqueue failures in `run/route.ts` are logged but do not prevent 202 response (lines 73–75).

**Agent Worker:**
- `runAgent()` calls `markFailed(runId, errorMessage)` on all failure paths.
- Sends Telegram DM via `notifyFailed()` on budget exceeded and LLM errors.
- Worker-level failures (uncaught throws) are logged by BullMQ's `worker.on('failed')` handler.
- Max iterations → `markFailed('max_iterations_exceeded')` at line 286.

---

## Cross-Cutting Concerns

**Logging:** `console.log/console.error` throughout TMA routes. Agent-worker uses `console.log/console.error` with `[agent-worker]` prefix. Hono gateway uses `pino` logger (`packages/api-gateway/src/lib/logger.ts`).

**Validation:** Inline in each route handler. UUID format validated with regex `UUID_RE` in routes that accept agent/run IDs. External URL validated with SSRF guard (`src/lib/external-agent.ts`).

**Authentication (TMA routes):** Trusts `x-tma-user-id` header without JWT verification at the route level. JWT is issued at `/tg/api/tma/auth/verify` but is not subsequently validated per-request server-side.

**Shared package:** `@aiag/shared` (from `packages/shared/`) provides Startonus NFT client (`startonus.ts`), used in `nft/purchase/route.ts`.

---

*Architecture analysis: 2026-06-02*
