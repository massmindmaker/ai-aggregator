# Technology Stack — TMA / Agent Runtime Subsystem

**Analysis Date:** 2026-06-02
**Scope:** `apps/tg-miniapp`, `apps/agent-worker`, `apps/worker` (agent-path queues), `packages/api-gateway`

---

## Languages

**Primary:**
- TypeScript 5.5.x — all apps and packages (see per-app versions below)

**No secondary languages** in scope (Python used only in eval-runner, unrelated to agent path).

---

## Runtime

**tg-miniapp:**
- Node.js ≥18 (Next.js app, pm2-managed as `tma`)
- No Bun in this app — `next start -p 3100`

**agent-worker:**
- Node.js (ESM, `"type": "module"`)
- Entry: `dist/index.js` via `node dist/index.js`
- Dev: `tsx watch src/index.ts` (tsx ^4.19.2)

**apps/worker:**
- Node.js (ESM, `"type": "module"`)
- Entry: `dist/index.js`
- Dev: `tsc --watch`

**api-gateway:**
- Production: Node.js via `@hono/node-server` (entry: `src/server-node.ts`, port 4000)
- Dev/Bun-compatible: also exports a `Bun.serve` config from `src/server.ts`
- Built with `tsup`

**Package Manager:** npm 10.2.4 (lockfile: `package-lock.json` at repo root)

---

## Frameworks

**tg-miniapp:**
- Next.js **14.2.15** — App Router, `basePath: '/tg'`, `runtime: 'nodejs'` on all API routes
- React 18.3.1 / react-dom 18.3.1
- `transpilePackages: ['@tonconnect/ui-react', '@telegram-apps/sdk-react']`
- `reactStrictMode: true`, `compress: true`, `poweredByHeader: false`

**api-gateway:**
- Hono **^4.12.16** — OpenAI-compatible API server
- `@hono/node-server ^2.0.0` — Node.js adapter for production

**agent-worker / apps/worker:**
- No HTTP framework — plain `node:http` for `/health` endpoint only
- BullMQ for job processing

**Build/Dev:**
- Turbo **^2.0.0** — monorepo task orchestration (`turbo.json`)
- tsup **^8.0.2** — bundler for `api-gateway` and shared packages
- tsx **^4.19.2** — dev runner for agent-worker

---

## Key Dependencies (exact versions from package.json)

### tg-miniapp (`apps/tg-miniapp/package.json`)

| Package | Version | Purpose |
|---------|---------|---------|
| `next` | 14.2.15 | App framework |
| `react` | 18.3.1 | UI |
| `@telegram-apps/sdk-react` | ^3.3.9 | Telegram WebApp SDK (init data, CloudStorage, etc.) |
| `@tonconnect/ui-react` | 2.4.4 | TON Connect wallet UI |
| `@ton/core` | ^0.59.0 | TON cell/BOC encoding (topup payload) |
| `@ton/crypto` | ^3.3.0 | TON crypto primitives (ton-proof verify — stub) |
| `jose` | ^5.9.6 | JWT sign/verify (HS256, 24h expiry) |
| `postgres` | ^3.4.5 | postgres-js SQL client (raw, prepare: false) |
| `bullmq` | ^5.27.0 | Job enqueue to `agent-run` queue |
| `ioredis` | ^5.4.1 | Redis connection for BullMQ |

### agent-worker (`apps/agent-worker/package.json`)

| Package | Version | Purpose |
|---------|---------|---------|
| `bullmq` | ^5.27.0 | Queue consumer (`agent-run`) |
| `ioredis` | ^5.4.1 | Redis connection |
| `postgres` | ^3.4.5 | Direct DB access (agents, agent_runs, agent_memory) |
| `tsx` | ^4.19.2 | Dev runner |
| `typescript` | ^5.5.0 | Compiler |

### apps/worker (`apps/worker/package.json`)

| Package | Version | Purpose |
|---------|---------|---------|
| `bullmq` | **^5.76.6** | Queue workers (upstream-poll, contest-eval, etc.) |
| `ioredis` | ^5.4.0 | Redis |
| `pino` | ^9.0.0 | Structured logging |
| `@aiag/database` | * | Drizzle ORM (lazy import for crons) |
| `@aiag/shared` | * | Shared utilities |
| `@aiag/upstream-adapters` | * | Upstream adapter interface |

**Version mismatch:** `bullmq` is `^5.27.0` in tg-miniapp and agent-worker, but `^5.76.6` in apps/worker. These can resolve to different patch/minor versions; confirm lockfile alignment if issues arise.

### api-gateway (`packages/api-gateway/package.json`)

| Package | Version | Purpose |
|---------|---------|---------|
| `hono` | ^4.12.16 | HTTP framework |
| `@hono/node-server` | ^2.0.0 | Node.js adapter |
| `postgres` | ^3.4.4 | SQL client |
| `ioredis` | ^5.4.1 | Redis (cache, ratelimit, streams roles) |
| `pino` | ^9.0.0 | Structured logging |
| `zod` | ^3.23.0 | Config validation |
| `fast-xml-parser` | ^4.3.6 | CBR XML rate parsing |
| `prom-client` | ^15.1.2 | Prometheus metrics |
| `tsup` | ^8.0.2 | Build |

### packages/database

| Package | Version | Purpose |
|---------|---------|---------|
| `drizzle-orm` | ^0.30.10 | ORM (used by apps/worker crons and web app) |
| `drizzle-kit` | ^0.21.4 | Migrations |
| `pg` | ^8.20.0 | Postgres driver for Drizzle |
| `@neondatabase/serverless` | ^0.9.0 | Neon serverless driver (legacy/web app) |

**Note:** `apps/tg-miniapp` and `apps/agent-worker` use `postgres` (postgres-js) directly, NOT Drizzle. Drizzle is only used by `apps/worker` crons and the web app.

### packages/shared

| Package | Version | Purpose |
|---------|---------|---------|
| `@aws-sdk/client-s3` | ^3.1045.0 | S3 file storage |
| `@aws-sdk/s3-request-presigner` | ^3.1045.0 | Pre-signed URLs |
| `zod` | ^3.23.6 | Validation |

---

## TypeScript Configuration

**Per-app tsconfig:**
- `apps/tg-miniapp/tsconfig.json` extends `@aiag/typescript-config/nextjs.json`
  - `baseUrl: "."`, paths: `@/*` → `["./app/*", "./src/*"]`
- `apps/agent-worker` and `apps/worker` extend `@aiag/typescript-config`
- `packages/api-gateway` extends `@aiag/typescript-config`

**TypeScript versions:**
- tg-miniapp: `^5.5.0`
- agent-worker: `^5.5.0`
- api-gateway: `^5.4.5`
- apps/worker: `^5.5.0`

---

## Build / Config Files

| File | Purpose |
|------|---------|
| `turbo.json` | Monorepo build graph, globalEnv vars, task definitions |
| `apps/tg-miniapp/next.config.mjs` | Next.js config (`basePath: '/tg'`, transpilePackages) |
| `apps/tg-miniapp/tsconfig.json` | TS config + `@/*` path alias |
| `packages/api-gateway/src/config.ts` | Zod-validated gateway config (PORT default 8787; production entry forces 4000) |

---

## Environment / Configuration

**Turbo globalEnv (affects build cache):**
`NODE_ENV`, `DATABASE_URL`, `REDIS_URL`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_API_URL`, plus legacy Postgres/Neon/NextAuth/S3 vars.

**Shared env file on VPS:** `/srv/aiag/shared/.env` (loaded by apps/worker via `loadSharedEnv()`)

**Key env vars required per app:**

| Var | App(s) | Purpose |
|-----|--------|---------|
| `DATABASE_URL` | tg-miniapp, agent-worker, gateway | Postgres connection |
| `REDIS_URL` | tg-miniapp, agent-worker, apps/worker, gateway | Redis (default `redis://127.0.0.1:6379`) |
| `TELEGRAM_BOT_TOKEN` | tg-miniapp | initData HMAC verification |
| `TG_BOT_TOKEN` | agent-worker | DM notifications (sendMessage) |
| `TMA_JWT_SECRET` | tg-miniapp | JWT signing key (HS256) |
| `TMA_KEY_ENCRYPTION_KEY` | tg-miniapp, agent-worker | AES-256-GCM key for BYOK API keys (64 hex chars) |
| `OPENROUTER_API_KEY` | agent-worker | Default LLM upstream |
| `KIE_API_KEY` | agent-worker | image_gen tool |
| `STARTONUS_SECRET` | tg-miniapp | NFT invoice generation |
| `TMA_TOPUP_WALLET_ADDRESS` | tg-miniapp | TON receive address for top-ups |
| `TONCENTER_API_URL` | tg-miniapp | TON tx lookup (default `https://toncenter.com/api/v3`) |
| `TONCENTER_API_KEY` | tg-miniapp | Optional TonCenter API key |
| `PUBLIC_BASE_URL` | tg-miniapp | For Startonus callback URL |
| `TMA_APP_BASE_URL` | agent-worker | Deep link base in DM notifications |
| `OPENROUTER_API_KEY` | gateway | System key for OpenRouter |
| `KIE_API_KEY` | gateway | System key for Kie.ai |
| `KIE_BASE_URL` | gateway | Kie base (default `https://api.kie.ai`) |
| `CBR_URL` | gateway | CBR XML rate feed |
| `METRICS_TOKEN` | gateway | Prometheus auth |

---

## Platform Requirements

**Development:**
- Node.js ≥18.0.0 (from root `package.json` `engines`)
- npm 10.2.4
- Redis instance on `redis://127.0.0.1:6379`
- Postgres instance

**Production (VPS):**
- pm2 manages: `tma` (tg-miniapp, port 3100), `agent-worker` (port 3101), `gateway` (port 4000), `aiag-worker` (port 4001)
- Nginx reverse-proxies `/tg/*` → tg-miniapp, gateway at 4000 internal only
- No Docker in this subsystem (pm2 + bare Node.js)

---

*Stack analysis: 2026-06-02*
