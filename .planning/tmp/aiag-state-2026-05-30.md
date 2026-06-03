# AIAG State Snapshot — 2026-05-30

AIAG (ai-aggregator.ru) — Russian-market AI models & AI agents marketplace plus an OpenAI-compatible API Gateway. White-label: proxies upstreams (OpenRouter, Kie, Fal, Together, Groq, Yandex) and hides the provider brand from the user. Three surfaces: Web app, Telegram Mini App, promo video.

## Tech stack (supersedes any earlier note saying MUI, Vercel, or Neon)
- Next.js App Router + React 19, **shadcn/ui + Tailwind 4** (MUI removed, D#1), next-intl i18n
- Auth: NextAuth v5 + Drizzle adapter + custom 152-FZ three-consent flow
- Gateway: **Hono on Bun** (D#2), port 4000, SSE streaming, Redis token-bucket rate-limit
- DB: **Timeweb managed PostgreSQL 16** + Drizzle ORM (D#12 — NOT Neon, NOT Supabase), migrations 0001–0021
- Payments: Tinkoff Acquiring (web), TON Connect (TMA)
- Deploy: **bare-metal Timeweb VPS 5.129.200.99** Ubuntu 24.04 (D#13 — NOT Vercel, NOT Docker), pm2 (aiag-web/gateway/worker) + nginx + certbot, `/srv/aiag/{web,gateway,worker}/{releases/<sha>,current}`, secrets in `/srv/aiag/shared/.env`

## Web app
Shipped: P1 Foundation (NextAuth v5, 152-FZ 3-consent, Drizzle 26 tables), P3 Design (shadcn + Tailwind 4, 12/15 advanced components, i18n), **P14 Admin LIVE** (contests/models/KYC/payouts admin; NFT collection status quick-toggle + filter, commit 2ccbac3). In flight: P2 Infra ~90%, P4 Gateway ~60%, P5 Upstreams ~75%, P6 Marketplace ~80%.
Gateway: 5 routing modes (auto/fastest/cheapest/balanced/ru-only), dual-bucket billing (subscription_credits + payg_credits) with atomic settle, SSE streaming, batch API -50%, prompt caching, USD→RUB CBR daily +5%, X-AIAG-Upstream header. Upstreams: OpenRouter, Together, Groq, Fal, Kie, Yandex, BYOK (0.5 cred/req). Tiers: Free / Basic 990 / Starter 2490 / Pro 6990 / Business 29900 RUB.
Blockers: real upstream API keys, S3 bucket aiag-storage not created, VPS RAM 2→4GB, www/api DNS A-records, Tinkoff e2e test.

## Telegram Mini App
**Phase 15 SHIPPED** (commit 88f5eab "close Phase 15"). `apps/tg-miniapp` (Next.js 14.2.15, port 3100, @telegram-apps/sdk-react 3.3.9, @tonconnect/ui-react 2.4.4) + `apps/agent-worker` (BullMQ + ioredis + postgres on Bun). Auth: Telegram init-data HMAC + JWT via jose.
Shipped: agent CRUD with 6 templates, streaming execution + conversation history, daily budget per agent, real image_gen via Fal, NFT marketplace via Startonus API + TonConnect, Telegram DM notifications, nginx vhost. Migrations 0016 tg_users, 0017 nft, 0018 agents, 0019 ton_wallets, 0020 agents_daily_budget, 0021 agents_external_connection.
**P0 worker hardening** (74ce4d8): model_slug from DB, tools whitelist, history, daily budget, real image_gen.
**WIP P1A "Path 1"**: connect your own OpenAI-compatible agent (endpoint URL + API key; commits 3697476, 84a762e). As of 2026-05-30 the working tree is mid-refactor — secret-box.ts, url-validate.ts, test-connection route deleted; secret-storage + URL validation reworked (external API key was plaintext, known gap).
Telegram Stars dropped (32% fee + 21d hold); TON Connect only. Hermes runtime NOT used here (that is Phase 17, deferred).

## Promo video
Separate `video-v4/` directory, NOT in the aggregator repo. AIAG-Video-v9: 1080×1920 portrait, 21 scenes, ffmpeg concat (build-v9.sh), not DaVinci. SOT: video-v4/AIAG-VIDEO-RULES.md (scene-by-scene approval). Traps: yellow-girl rembg cutout (GrabCut+rembg union ~80%), DaVinci portrait pillarbox.

## Deferred
- P16 x402 (self-host facilitator promoted to 16.1 due to EU-20 sanctions April 2026; 161-FZ/259-FZ legal-review gate)
- P17 Hermes Agent v0.12 runtime (k3s per-user pods, needs 4GB VPS; Mastra vs Hermes decision open)

## Hard rule
No local runtime testing — never spin up local dev, Docker, or tests; verify on the VPS ai-aggregator.ru after deploy.
