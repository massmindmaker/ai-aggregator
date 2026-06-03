# AIAG — TMA Agent Platform Vision (user, 2026-05-30)

User's product vision for the Telegram Mini App as an agent platform. Captured verbatim-ish; drives Phase 15b+ design.

## Core idea
TMA = an agent builder + runtime. Two creation paths:
1. **Prepaid template bundle** — click a ready template, agent launches with the right tools already wired AND prepaid. E.g.:
   - "Видеомонтажёр" → has the **Hyperframes** skill + prepaid video/image models + relevant plugins.
   - "Трейдер" → has the relevant trading tools/data sources.
2. **Custom agent** (slightly more advanced) — user sets own personality, own tools, own **skills**, own **plugins**, own **MCP servers**.

## Provider model (decided 2026-05-30)
Per-agent provider choice, 4 connection types (OpenCode-style: adapter + baseURL + apiKey|OAuth token + model; catalog from models.dev):
1. OpenRouter (default), 2. own API key (BYOK, AES-256-GCM already exists), 3. custom OpenAI-compatible URL (Ollama/self-host), 4. subscription OAuth (Codex/Claude Pro) — user wants it despite ToS/WebApp caveats.
**The AIAG aggregator itself is ALSO one of the model providers** (web version exposes its gateway as a provider).

## Tool payments (decided 2026-05-30): HYBRID
- **Now**: Tool Broker — we hold the real tool keys (Firecrawl, proxies, MCP), user pays internal credits from TON balance, we meter+atomic-deduct. Legal for RU IP, no crypto. (Reuses P0 daily-budget mechanism.)
- **Later**: outgoing x402 adapter inside the broker (service-side USDC wallet + self-host facilitator x402-rs) to reach arbitrary x402 services. Put the x402 layer on a NON-RF entity (259-FZ/161-FZ risk). User also wants x402 Bazaar / Agentic.Market (70+ paid APIs) as a tool catalog.

## Per-agent auto-deploy
Each created agent **auto-deploys to the VPS**, configured per its load requirements; the config (incl. server performance) is changeable in agent settings. Connects to Phase 17 Hermes Managed Cloud idea (k3s per-user pods, kube-green idle hibernate) already in memory.

## TMA as interface over user's own runtime
Beyond building an agent, TMA can connect to the user's **own Hermes or OpenCode** and act as a thin interface/GUI for it. Research target: existing Agentic OS / agent GUIs (we already scraped hermesatlas.com workspaces-and-GUIs; see LLM-wiki aiag/concepts/aiag-tg-miniapp-phase15 and tma-3tier-deployment).

## Start order (decided)
1. Fix the `connection_type` constraint bug (migration 0021: CHECK allows 'aiag','external' but code writes 'external_openai' → external-agent INSERT fails).
2. Provider picker (provider/model/auth_ref/base_url on agent + models.dev catalog).
Then: 2-click agent UX, Tool Broker + Firecrawl, x402 later.

See `mem:aiag_state_2026_05_30`.
