# AIAG Marketplace — Project Overview (corrected 2026-05-30)

> NOTE: This replaces an earlier STALE overview that wrongly said MUI / Vercel / Neon.
> The locked decisions (.planning/intel/decisions.md, D#1–D#14) are authoritative.

## Purpose
AIAG (ai-aggregator.ru) — RU-market AI models & agents marketplace + OpenAI-compatible
API Gateway. White-label: it proxies upstreams (OpenRouter / Kie / Fal / Yandex etc.) and
HIDES the underlying provider brand from the user. Three product surfaces:
1. **Web app** (marketplace + gateway + dashboard)
2. **Telegram Mini App (TMA)** — in-app agent marketplace + TON payments
3. **Promo video** — separate workstream, NOT in this repo (see `video-v4/`)

## Tech Stack (ACTUAL)
- **Frontend**: Next.js 15 (App Router, RSC), React 19, **shadcn/ui + Tailwind 4** (MUI removed, D#1), next-intl i18n
- **Auth**: NextAuth v5 (@auth/drizzle-adapter) + custom 152-ФЗ 3-consent flow
- **Gateway**: **Hono on Bun** (D#2), port 4000, SSE streaming, Redis token-bucket rate-limit
- **DB**: **Timeweb managed PostgreSQL 16** + Drizzle ORM (D#12 — NOT Neon, NOT Supabase). Migrations 0001–0021
- **Payments**: Tinkoff Acquiring (web), TON Connect (TMA)
- **Deploy**: **bare-metal Timeweb VPS 5.129.200.99**, Ubuntu 24.04 (D#13 — NOT Vercel, NOT Docker). pm2 (aiag-web / aiag-gateway / aiag-worker) + nginx + certbot. Capistrano-style `/srv/aiag/{web,gateway,worker}/{releases/<sha>,current}`. Secrets in `/srv/aiag/shared/.env`
- **Monorepo**: Turborepo + workspaces

## Structure
```
apps/web/            # Next.js marketplace, dashboard, admin, pricing, playground
apps/tg-miniapp/     # Telegram Mini App (port 3100)
apps/agent-worker/   # BullMQ consumer for TMA agent execution
apps/worker/         # contest eval / background jobs
packages/api-gateway/  # Hono-on-Bun gateway (billing, routing, upstreams, streaming)
packages/database/     # Drizzle schemas + migrations 0001–0021
packages/tinkoff/      # Tinkoff Acquiring client
packages/shared/       # zod validation
```

## Phase status (snapshot 2026-05-30)
- Web: P1 Foundation ✓, P3 Design ✓, P2 Infra ~90%, P4 Gateway ~60%, P5 Upstreams ~75%, P6 Marketplace ~80%, P7 Supply/contests planned, P8 Launch planned, **P14 Admin LIVE**
- TMA: **Phase 15 SHIPPED** (TON Connect, agents CRUD, streaming, NFT via Startonus, agent-worker, DM notifications, nginx vhost). **P1A "connect your own OpenAI-compatible agent" = current WIP**
- Deferred: P16 x402, P17 Hermes agent runtime

## Hard rule
NO local runtime testing (no local dev/Docker/tests). Verify on VPS ai-aggregator.ru after deploy.

See also `mem:aiag_state_2026_05_30` for the detailed cross-workstream snapshot.
