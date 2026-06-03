# AIAG — Cross-Workstream State Snapshot (2026-05-30)

Consolidated recall across all 3 workstreams + memory-system audit.

## 1. WEB APP (apps/web + packages/api-gateway)
- **Shipped**: P1 Foundation (NextAuth v5, 152-ФЗ 3-consent, Drizzle 26 tables), P3 Design (shadcn/Tailwind 4, 12/15 advanced components, i18n), **P14 Admin LIVE** (contests/models/KYC/payouts admin, NFT collection status quick-toggle — commit 2ccbac3)
- **In flight**: P2 Infra ~90%, P4 Gateway ~60%, P5 Upstreams ~75%, P6 Marketplace UI ~80%
- **Gateway**: 5 routing modes (auto/fastest/cheapest/balanced/ru-only), dual-bucket billing (subscription_credits + payg_credits), atomic settle (UPDATE WHERE balance>=cost RETURNING), SSE streaming, batch API (-50%), prompt caching, USD→RUB CBR daily +5%, X-AIAG-Upstream header
- **Upstreams**: OpenRouter (proprietary LLM), Together/Groq (OSS), Fal (Flux/Kling/Whisper), Kie (Veo3/Runway/Suno), Yandex direct, BYOK (0.5 cred/req). White-label — provider brand hidden
- **Pricing tiers**: Free / Basic 990 / Starter 2490 / Pro 6990 / Business 29900 ₽
- **Blockers**: real upstream API keys, S3 bucket aiag-storage not created, VPS RAM 2→4GB, www/api DNS A-records, Tinkoff e2e test

## 2. TELEGRAM MINI APP (apps/tg-miniapp + apps/agent-worker)
- **Phase 15 SHIPPED** (commit 88f5eab "close Phase 15"). Next.js 14.2.15 port 3100, @telegram-apps/sdk-react 3.3.9, @tonconnect/ui-react 2.4.4
- Built: HMAC init-data verify + JWT (jose) auth; agents CRUD w/ 6 templates; streaming execution + conversation history; daily budget per agent; real image_gen via Fal; NFT marketplace via **Startonus** API + TonConnect; agent-worker (BullMQ + ioredis + postgres, runs on Bun); **Telegram DM notifications**; nginx vhost
- Migrations: 0016 tg_users, 0017 nft, 0018 agents, 0019 ton_wallets, 0020 agents_daily_budget, 0021 agents_external_connection
- **P0 worker hardening** (74ce4d8): model_slug from DB, tools whitelist, history, daily budget, real image_gen
- **P1A / Path 1 "Connect your own OpenAI-compatible agent"** = CURRENT WIP (commits 3697476, 84a762e). User supplies endpoint URL + API key. Uncommitted working tree DELETES secret-box.ts, url-validate.ts, test-connection route → secret-storage / validation approach being refactored. Plaintext external API key was a known gap.
- **Telegram Stars DROPPED** (32% mobile fee + 21d hold). TON Connect only.

## 3. PROMO VIDEO (separate dir `video-v4/`, NOT in aggregator repo)
- AIAG-Video-v9 trailer: 1080×1920 portrait, 21 scenes, assembled via ffmpeg concat (build-v9.sh), NOT DaVinci
- Master rules SOT: video-v4/AIAG-VIDEO-RULES.md (scene-by-scene approval, never render all at once)
- Known traps: yellow-girl rembg cutout (GrabCut+rembg union ~80%), DaVinci portrait pillarbox trap
- Well-covered in memory graph (AIAG-Video-v9-Trailer, AIAG-Video-Pipeline, AIAG-Characters etc.) and auto-memory

## DEFERRED
- P16 x402 (self-host facilitator promoted to 16.1 due to EU-20 sanctions; 161-ФЗ/259-ФЗ legal review gate)
- P17 Hermes Agent v0.12 runtime (k3s per-user pods, needs 4GB VPS; Mastra vs Hermes decision open)

## MEMORY SYSTEM COVERAGE (audit result)
- **LightRAG**: design/strategy heavy, current through ~2026-05-29; lacked shipped TMA detail (fixed today)
- **Memory Graph**: AIAG-Phase14/15/16/17 + video; Phase15 was stale "NOT planned" (fixed today)
- **Serena**: project_overview was stale MUI/Vercel/Neon (corrected today)
- **Auto-memory**: video + deploy + strategy strong; added workstream map + TMA shipped today
