# External Integrations — TMA / Agent Runtime Subsystem

**Analysis Date:** 2026-06-02
**Scope:** `apps/tg-miniapp`, `apps/agent-worker`, `apps/worker` (agent path), `packages/api-gateway`

---

## Telegram

### initData Verification (auth)
- **What:** Verifies Telegram WebApp `initData` HMAC-SHA256 on login
- **Where configured:** `TELEGRAM_BOT_TOKEN` env var
- **Implementation:** `apps/tg-miniapp/src/lib/verify-init-data.ts`
  - Algorithm: HMAC-SHA256 keyed with `HMAC-SHA256("WebAppData", botToken)`, data_check_string = sorted params joined with `\n`
  - Expiry: 86400s (24h) — `auth_date` checked server-side
- **Invoked by:** `apps/tg-miniapp/app/api/tma/auth/verify/route.ts` (POST `/api/tma/auth/verify`)
- **Output:** Issues a HS256 JWT (24h TTL, signed with `TMA_JWT_SECRET`) stored in Telegram CloudStorage

### Telegram Bot API — DM Notifications
- **What:** Sends completion/failure DM messages to users after agent runs
- **Where configured:** `TG_BOT_TOKEN` env var in agent-worker; `TMA_APP_BASE_URL` for deep link base
- **Implementation:** `apps/agent-worker/src/bot-api.ts`
  - Endpoint: `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`
  - Auth: bot token in URL path
  - Payload: `{ chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true }`
  - Silent no-op if `TG_BOT_TOKEN` is missing (worker keeps running)
- **Invoked by:** `apps/agent-worker/src/agent-runner.ts` on `markCompleted` and `markFailed`

### Telegram WebApp SDK (client-side)
- **What:** Provides `window.Telegram.WebApp.initData`, `CloudStorage`, `initDataUnsafe`
- **SDK:** `@telegram-apps/sdk-react ^3.3.9` (listed in tg-miniapp dependencies, transpilePackages)
- **CloudStorage usage:** JWT cached under key `aiag_jwt` to avoid re-auth on every open
- **Implementation:** `apps/tg-miniapp/src/hooks/useAuth.ts`

---

## TON Blockchain

### TON Connect (wallet connection)
- **What:** Allows users to connect TON wallets for NFT purchases and top-ups
- **SDK:** `@tonconnect/ui-react 2.4.4` (pinned exact version)
- **Supporting libs:** `@ton/core ^0.59.0`, `@ton/crypto ^3.3.0`
- **Manifest:** `apps/tg-miniapp/public/tonconnect-manifest.json`
  - URL: `https://app.ai-aggregator.ru`, name: `AIAG`
- **Wallet linking:** `apps/tg-miniapp/app/api/tma/wallet/link/route.ts`
  - MVP: trusts client-provided address without strict ton-proof signature verify
  - `is_verified = false` for all wallets (full Ed25519 verify stubbed in `apps/tg-miniapp/src/lib/ton-proof.ts`)

### TON Transaction Payload (top-ups)
- **What:** Encodes TON transfer with text comment using `@ton/core` BoC cells
- **Implementation:** `apps/tg-miniapp/app/api/tma/topup/init/route.ts`
  - Uses `beginCell().storeUint(0, 32).storeStringTail(comment).endCell().toBoc().toString('base64')`
  - Comment format: `topup:<8-char-tag>` for reconciliation
- **Receive wallet:** `TMA_TOPUP_WALLET_ADDRESS` env var

### TonCenter API (on-chain tx lookup)
- **What:** Reconciles pending top-ups by querying recent inbound transactions
- **Endpoint:** `https://toncenter.com/api/v3/transactions` (configurable via `TONCENTER_API_URL`)
- **Auth:** Optional `X-API-Key: ${TONCENTER_API_KEY}` header
- **Implementation:** `apps/tg-miniapp/app/api/tma/topup/check/[id]/route.ts`
  - Client-driven poll (no cron); idempotent via status guard
  - On match: atomically confirms topup + credits `tg_user_balances`

### CoinGecko (TON/RUB rate)
- **What:** Provides live TON→RUB exchange rate for top-up amount calculation
- **Endpoint:** `https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=rub`
- **Auth:** None (free public endpoint)
- **Cache:** 60s in-memory TTL (module-level variable), stale-ok fallback
- **Implementation:** `apps/tg-miniapp/src/lib/ton-rate.ts`

---

## Startonus (NFT Minting)

- **What:** TON NFT collection minter; generates TON Connect invoices, handles async mint lifecycle
- **Base URL:** `https://bot.startonus.com/api` (configurable via `STARTONUS_BASE_URL`)
- **Auth:** `secret` field in request body (`STARTONUS_SECRET` env var, obtained from @startonus_bot /createMinterSecret)
- **Flow:**
  1. `POST /minter/generate-invoice/custom` → returns `{ id, to, value, payload, validUntil }`
  2. Returns TON Connect transaction params to client
  3. After on-chain confirmation, Startonus calls back `POST /api/tma/nft/webhook`
- **SDK:** `packages/shared/src/startonus.ts` — `generateInvoice()` exported via `@aiag/shared`
- **Invoked by:** `apps/tg-miniapp/app/api/tma/nft/purchase/route.ts`
- **Webhook:** `apps/tg-miniapp/app/api/tma/nft/webhook/route.ts`
  - Events: `invoice_paid`, `minted`, `failed`
  - No webhook signing — protection via unguessable `purchase_id` UUID in `userData` + planned nginx IP-allowlist
  - Idempotent: only forward state transitions (pending → paid → minted)

---

## OpenRouter

### In agent-worker (direct, no gateway)
- **What:** Default LLM upstream for all AIAG-managed agents
- **Endpoint:** `https://openrouter.ai/api/v1/chat/completions`
- **Auth:** `Authorization: Bearer ${OPENROUTER_API_KEY}` env var
- **Headers:** `HTTP-Referer: https://ai-aggregator.ru`, `X-Title: AIAG TMA` (for attribution)
- **BYOK path:** If agent has `connection_type = 'external_openai'`, bypasses OpenRouter entirely and calls the user's own endpoint
- **Models hardcoded** in `apps/agent-worker/src/agent-runner.ts` PRICING table:
  - `nousresearch/hermes-4-405b` (default), `openai/gpt-4o`, `openai/gpt-4o-mini`, `anthropic/claude-3.5-sonnet`, `anthropic/claude-3-haiku`, `google/gemini-2.0-flash-001`, `meta-llama/llama-3.3-70b-instruct`
- **Implementation:** `apps/agent-worker/src/agent-runner.ts` — `callModel()`, `resolveUpstream()`
- **Note:** Agent runs go DIRECTLY to OpenRouter, bypassing the internal gateway. Billing/markup is handled locally by the agent-worker, not the gateway.

### In api-gateway (web app path)
- **What:** Chat/completions/embeddings upstream for the main web API
- **Endpoint:** `https://openrouter.ai/api/v1`
- **Auth:** `Authorization: Bearer ${OPENROUTER_API_KEY}` + optional `OPENROUTER_APP_URL`, `OPENROUTER_APP_NAME` env vars
- **BYOK:** `X-Upstream-Key` header overrides system key
- **White-label:** Provider/fingerprint fields stripped from responses before returning to clients
- **Implementation:** `packages/api-gateway/src/upstreams/openrouter.ts`

---

## Kie.ai (Image Generation)

### In agent-worker (tool: `image_gen`)
- **What:** Image generation tool available to agents
- **Endpoint:** `https://api.kie.ai`
  - Create: `POST /api/v1/playground/createTask`
  - Poll: `GET /api/v1/playground/recordInfo?taskId=<id>`
- **Auth:** `Authorization: Bearer ${KIE_API_KEY}`
- **Model:** `google/nano-banana-pro`
- **Cost:** 6.5 RUB per image (hardcoded in tools.ts)
- **Behavior:** Synchronous from caller's perspective — polls up to 60s, returns URL or placeholder
- **Graceful degradation:** If `KIE_API_KEY` not set, returns placehold.co URL with cost=0
- **Implementation:** `apps/agent-worker/src/tools.ts` — `imageGen()`, `kieCreateTask()`, `kiePoll()`

### In api-gateway (image/video/audio routes)
- **What:** Multi-media generation (images, video, audio speech) for the web API
- **Endpoint families:**
  - `jobs` family: `POST /api/v1/jobs/createTask`, `GET /api/v1/jobs/recordInfo`
  - `veo` family: `POST /api/v1/veo/generate`, `GET /api/v1/veo/recordInfo`
  - `suno` family: `POST /api/v1/generate`, `GET /api/v1/generate/recordInfo`
- **Auth:** `Authorization: Bearer ${KIE_API_KEY}` (configurable via `KIE_BASE_URL`)
- **BYOK:** Request-level key override via `req.byokKey`
- **Implementation:** `packages/api-gateway/src/upstreams/kie.ts`

---

## BYOK — User-Supplied External Endpoints

- **What:** Users can connect their own OpenAI-compatible LLM endpoints (any vLLM/OpenAI-API-compatible server)
- **Storage:** API key encrypted with AES-256-GCM, stored as `bytea` in `agents.external_api_key_encrypted`
  - Key: `TMA_KEY_ENCRYPTION_KEY` (64 hex chars = 32 bytes)
  - Same encryption impl duplicated in: `apps/tg-miniapp/src/lib/crypto.ts` and `apps/agent-worker/src/crypto.ts`
- **SSRF guard:** `apps/tg-miniapp/src/lib/external-agent.ts` — rejects non-HTTPS, loopback, RFC1918, `.local`/`.internal`/`.lan`, `169.254.169.254`
- **Probe endpoint:** `POST /api/tma/agents/test-external` — validates URL + calls `GET <base>/models` to confirm reachability
- **Runtime resolution:** `apps/agent-worker/src/agent-runner.ts` — `resolveUpstream()` decrypts key and builds URL if `connection_type = 'external_openai'`
- **Cost:** 0 for external runs (user pays their own provider)

---

## Internal Gateway (127.0.0.1:4000)

- **What:** Hono HTTP server providing OpenAI-compatible API for the web app's users; handles billing, rate limiting, routing
- **Port:** 4000 (Node.js production via `packages/api-gateway/src/server-node.ts`)
- **Auth:** `Authorization: Bearer sk_aiag_{live|test}_...` gateway API keys; hashed with SHA-256 and cached in Redis 5min
- **Routes exposed:**
  - `POST /v1/chat/completions`
  - `POST /v1/completions`
  - `POST /v1/embeddings`
  - `GET /v1/models`
  - `GET /v1/balance`
  - `POST /v1/images/generations`
  - `POST /v1/video/generations`
  - `POST /v1/audio/speech`, `POST /v1/audio/transcriptions`
  - `POST /v1/batches`
  - `GET /health`
- **Note:** TMA agent runs do NOT go through the gateway — they call OpenRouter/external endpoints directly from agent-worker

---

## Postgres

- **Connection string:** `DATABASE_URL` env var
- **Client:** `postgres` (postgres-js) `^3.4.5` in tg-miniapp and agent-worker; `^3.4.4` in gateway; Drizzle ORM with `pg ^8.20.0` in apps/worker crons
- **All queries use `prepare: false`** (compatible with PgBouncer/Supabase pooler)
- **Tables touched by TMA/agent path:**
  - `tg_users` — Telegram user records (upserted on auth)
  - `agents` — Agent definitions (CRUD via `/api/tma/agents/*`)
  - `agent_runs` — Run history + status + cost
  - `agent_memory` — Per-agent key-value store
  - `nft_collections` — NFT collection catalog
  - `nft_purchases` — NFT purchase lifecycle
  - `ton_wallets` — Linked wallet records
  - `tg_topups` — TON top-up records
  - `tg_user_balances` — User balance (RUB)
  - `gateway_api_keys` — API key store for gateway auth
  - `models`, `upstreams`, `model_upstreams` — Gateway routing tables
- **Migrations:** Manual via `drizzle-kit` (`packages/database`) or raw SQL; prod: `sudo -u postgres psql aiag`
- **Billing stored function:** `aiag_settle_charge(org_id, request_id, total_rub)` — atomic SELECT FOR UPDATE + idempotency

---

## Redis

- **Connection:** `REDIS_URL` env var (default `redis://127.0.0.1:6379`)
- **Clients:**
  - `apps/tg-miniapp`: ioredis `^5.4.1` (inline, ephemeral — created per request then closed)
  - `apps/agent-worker`: ioredis `^5.4.1` (persistent connection, `maxRetriesPerRequest: null`)
  - `apps/worker`: ioredis `^5.4.0` (persistent via `createRedisConnection()`)
  - `packages/api-gateway`: ioredis `^5.4.1` (3 role-keyed pools: `cache`, `streams`, `ratelimit`)
- **Usage by subsystem:**
  - **BullMQ queue:** `agent-run` — tg-miniapp enqueues (ephemeral), agent-worker consumes (concurrency 4)
  - **Gateway cache:** `model:<slug>` (10min TTL), `apikey:<hash>` (5min TTL), `cbr:usd_rub:today` (24h TTL)
  - **Gateway rate limit:** `usd_day:<org>:<date>`, per-minute RPM counters
  - **apps/worker:** All BullMQ queues: `upstream-poll`, `contest-eval`, `webhook-retry`, `email-send`

---

## CBR (Central Bank of Russia — USD/RUB Rate)

- **What:** Daily USD/RUB exchange rate used to convert LLM costs from USD to RUB
- **Endpoint:** `https://www.cbr.ru/scripts/XML_daily.asp` (configurable via `CBR_URL`; optional fallback `CBR_FALLBACK_URL`)
- **Auth:** None
- **Retry:** 3 attempts per URL, delays 0s/1s/3s, timeouts 10s/15s/15s
- **Cache:** Redis key `cbr:usd_rub:today` (24h TTL); `cbr:usd_rub:last_known` (7d TTL) for stale fallback
- **Spread:** `CBR_RATE_SPREAD_PCT` (default 2%) applied before caching
- **Implementation:** `packages/api-gateway/src/lib/cbr.ts`

---

## AWS S3 (file storage)

- **What:** File storage (used by shared package, not directly in TMA agent path)
- **SDK:** `@aws-sdk/client-s3 ^3.1045.0`, `@aws-sdk/s3-request-presigner ^3.1045.0` (in `packages/shared`)
- **Config vars:** `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_REGION`
- **Implementation:** `packages/shared/src/s3.ts`

---

## DuckDuckGo (web_search tool)

- **What:** Web search tool available to agents (no API key required)
- **Endpoint:** `https://html.duckduckgo.com/html/?q=<query>` (HTML scrape)
- **Auth:** None; impersonates Chrome 120 User-Agent
- **Returns:** Up to 5 results (title, url, snippet) parsed with regex
- **Implementation:** `apps/agent-worker/src/tools.ts` — `webSearch()`

---

## Webhooks

**Incoming:**
- `POST /api/tma/nft/webhook` — Startonus NFT mint lifecycle callbacks (no signing, UUID-based security)
- Planned: TonCenter/other on-chain event callbacks (not yet implemented; topup reconciliation is client-polled)

**Outgoing:**
- Startonus callback URL sent during invoice generation: `${PUBLIC_BASE_URL}/tg/api/tma/nft/webhook`

---

## Environment Variables Summary

| Variable | Default | Apps | Required |
|----------|---------|------|----------|
| `DATABASE_URL` | — | all | Yes |
| `REDIS_URL` | `redis://127.0.0.1:6379` | all | Yes |
| `TELEGRAM_BOT_TOKEN` | — | tg-miniapp | Yes |
| `TG_BOT_TOKEN` | — | agent-worker | No (DMs disabled) |
| `TMA_JWT_SECRET` | `dev-only-change-in-prod` | tg-miniapp | Yes (prod) |
| `TMA_KEY_ENCRYPTION_KEY` | — | tg-miniapp, agent-worker | Yes (BYOK) |
| `OPENROUTER_API_KEY` | — | agent-worker, gateway | Yes |
| `KIE_API_KEY` | — | agent-worker, gateway | No (graceful fallback) |
| `KIE_BASE_URL` | `https://api.kie.ai` | gateway | No |
| `STARTONUS_SECRET` | — | tg-miniapp | Yes (NFT) |
| `TMA_TOPUP_WALLET_ADDRESS` | — | tg-miniapp | Yes (topup) |
| `TONCENTER_API_URL` | `https://toncenter.com/api/v3` | tg-miniapp | No |
| `TONCENTER_API_KEY` | — | tg-miniapp | No |
| `PUBLIC_BASE_URL` | `https://app.ai-aggregator.ru` | tg-miniapp | No |
| `TMA_APP_BASE_URL` | `https://app.ai-aggregator.ru/tg` | agent-worker | No |
| `STARTONUS_BASE_URL` | `https://bot.startonus.com/api` | shared | No |
| `CBR_URL` | `https://www.cbr.ru/scripts/XML_daily.asp` | gateway | No |
| `S3_ENDPOINT / S3_*` | — | shared | No (TMA path unused) |

---

*Integration audit: 2026-06-02*
