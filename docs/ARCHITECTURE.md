# ARCHITECTURE.md — AIAG

System map. Product reality lives in `/CLAUDE.md`; this is the technical topology.

## Two products
- **Web aggregator** (`apps/web` + `packages/api-gateway`) — RU market, rubles. RF entity.
- **TMA** (`apps/tg-miniapp` + `apps/agent-worker`) — Telegram agents marketplace, crypto credits. Foreign entity.
- Separated by currency + entity + audience; they only share Postgres + the gateway as a model provider.

## Service map (pm2 on a single 2GB Timeweb VPS)
- `web` — Next 14.x (rubles aggregator)
- `gateway` — Hono/Bun, `:4000`, OpenAI-compatible, white-label, model registry + markup
- `tma` — Next 14.2.33, `:3100`, basePath `/tg`, health `/tg/health`
- `agent-worker` — BullMQ runner, `:3101` (the money path)
- `worker` — background jobs
- nginx fronts all; strips `x-middleware-subrequest`/`x-tma-user-id` on `/tg`

## Request → money flow (TMA)
TMA → `agent-worker` (BullMQ) → resolveUpstream → gateway `:4000` (AIAG model, +markup, debit) OR user's own provider (BYOK = no charge) → upstream. `settleRun` does the atomic debit. See `/SECURITY.md`.

## Data stores
- Postgres `aiag` (Timeweb managed) — single source of truth. `tg_user_balances` (TMA spendable; migrating ₽→crypto-credit), gateway org-balances, `agent_*`, `gateway_transactions`, `agent_provider_credentials`.
- Redis 7 — BullMQ queues.

## Deploy topology
- GitHub Actions SSH rsync (Capistrano-style releases) for web/gateway; **tma + agent-worker built manually on VPS** (root-owned dirs, no workflow build step). Migrations applied **manually, no tracking** (`sudo -u postgres psql aiag` for ALTER). Single source of truth for releasing: skill `aiag-deploy`.

## NOT built (don't design as if it exists)
Managed Hermes runtime, tool broker / x402, MCP servers, skills hub — all R&D. Live agent runtime = stateless BullMQ→OpenRouter loop in `apps/agent-worker/src/agent-runner.ts`. See the reality table in `/CLAUDE.md`.
