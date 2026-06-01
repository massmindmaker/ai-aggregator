# AIAG — Hermes supply marketplace + payment rail (design)

Brainstorm conclusion, 2026-06-01. Reframes AIAG around **Hermes** as the agent runtime; AIAG is the **supply marketplace** (models · skills · MCP-tools) + **payment rail** (TON/USDT, x402-shaped) + Telegram storefront/control-panel.

## Vision (one picture)
`[Hermes agent = runtime]` ← supplied by ← `[AIAG: catalog (models+skills+MCP-tools) · TMA storefront/control-panel · crypto billing]`

- **Ordinary user:** AIAG hosts a **managed cloud Hermes** per user, pre-loaded with the AIAG catalog. Zero setup.
- **Power user:** connects **their own Hermes** (self-hosted); AIAG installs into its config.
- One runtime (Hermes), one catalog. "Everything is for Hermes" — literally.

## What Hermes is (integration target)
`NousResearch/hermes-agent` — Python CLI + OpenAI-compatible gateway (`:8642`) + dashboard API (`:9119`). Config: `~/.hermes/config.yaml` + `.env` + `models.json`. Already has: **skills** (`SKILL.md` + YAML frontmatter — same format as Claude skills), **MCP servers** (`config.mcp_servers`), **cron**, **sub-agents** (tmux), **Swarm** (multi-agent). Front-ends: `hermes-workspace` (dashboard) + `hermes-telegram-miniapp` (FastAPI/Telegram). We integrate with the AGENT via config-injection.

## The three catalogs + integration seams
1. **Models** — AIAG's OpenAI-compatible gateway (73 models). Hermes registers AIAG as a provider: `PUT /api/env` (base URL + key) + `PUT /api/config` (`auth.profiles."aiag:default"`, `model:"aiag/<slug>"`). Auto-discovery `/api/local-providers` picks it up. Catalog maps 1:1 onto `/api/models`.
2. **Skills** — `SKILL.md` bundles. Install via Hermes skill-hub: `POST /api/skills/install {identifier}` backed by an AIAG-hosted hub, or drop bundles into `.hermes/skills/`. Toggle `PUT /api/skills/toggle`.
3. **MCP-tools** — AIAG runs an **MCP gateway** minting a **per-agent Streamable-HTTP endpoint** `https://mcp.ai-aggregator.ru/t/{agentId}/mcp` (+ bearer). "Add tool" = `PUT /api/mcp/configure` writing the entry into `config.mcp_servers`. Agent then `tools/list` → `tools/call`. (Both sides ours → no OAuth dance; reserve OAuth 2.1+PKCE for exposing tools to 3rd-party hosts later.)

## How a user "buys/adds a tool" (the mechanic)
- One-tap **"Поставить в моего Hermes"** in the TMA → AIAG provisions the tenant MCP endpoint + key → patches Hermes config → tool appears on the next turn.
- **Billed per-call** at the AIAG gateway, deducted from the user's **TON/USDT** balance (Startonus/TON Connect rails). Internally shaped as an **x402 envelope** (HTTP 402, price/asset/recipient) so the same tools can later be opened to **external agents** (Coinbase x402 / agentic.market ecosystem) paying USDC autonomously.
- Steals from **agentic.market** (Coinbase x402 storefront): **zero-API-key** ("one wallet → thousands of tools"), **live metrics** on every card (calls/payers/price/last-active), **self-indexing** (a tool used through the gateway auto-lists), **machine-readable discovery** (`/v1/tools`, `/v1/tools/search`, `llms.txt`) so a Hermes agent finds the catalog at runtime — not just human-browsed.
- Avoid: don't force USDC on non-crypto users (TON/USDT credits primary, x402 optional); don't ship a static directory with no real catalog API (the API is the product); be deliberate — AIAG tools are **true MCP** (`tools/call`) for our agents, x402-HTTP optionally for external.

## Telegram deployment (unchanged, official)
Agents act via **Bot API** (channels/groups) + **Telegram Business** (DMs on your behalf). Hermes already speaks Bot-API + initData. **No MTProto userbot** (ToS/ban). Creation wizard "Кто → Где → Что" stays.

## Tiers
- **Ordinary (managed Hermes):** onboard → cloud Hermes spun up, catalog pre-loaded → create agent (template/describe) → deploy to your Telegram → pay-per-use in TON/USDT.
- **Power (own Hermes):** connect endpoint URL + bearer → AIAG installs catalog items into their config → same storefront, their compute.

## TMA surface (storefront + control panel)
- **Маркет:** Модели · **Скиллы** · **MCP-тулзы** (each a catalog with cards, price-per-call, live metrics, "Поставить в Hermes").
- **Мой Hermes** dashboard: installed models/skills/tools, cron tasks, sub-agents/Swarm, status — a mirror of the Hermes config (read via `/api/config`, `/api/skills`, `/api/mcp`, `/api/cron`, `/api/agents`).
- **Агенты:** create (wizard) · run/chat · tasks kanban · deploy (Telegram).
- **Профиль/кошелёк:** TON/USDT balance, top-up (TON Connect), per-call spend, NFT (Startonus).

## Phasing
- **P0 (in progress):** provider catalog + BYOK credentials + GET /api/providers + worker resolveUpstream (migration 0026, applied). This is the "models supply / BYOK" foundation.
- **P1:** AIAG-as-provider into managed Hermes (model supply) + managed-Hermes provisioning + "Мой Hermes" dashboard.
- **P2:** Skills catalog + skill-hub install endpoint.
- **P3:** MCP gateway (per-agent endpoints) + tools catalog + per-call TON/USDT metering.
- **P4:** x402 envelope → open tools to external agents; self-indexing; `llms.txt`/discovery API.
- **P5:** agent groups / Swarm, shared memory, group chat.

Guardrails (from Virtuals/agentic AVOID): TON = pay-for-compute/tools, NOT tradable agent equity; rank by real usage not hype; first run free; crypto optional layer, credits primary.
