# AIAG — Product Canon (resolved v2, 2026-06-02) — START HERE

Single "start here" Serena memory. Summarizes the resolved product definition.
Authoritative sources: `/CLAUDE.md` (anchor) + `docs/specs/2026-06-02-WHAT-WE-ARE-BUILDING.md` (canon)
+ `docs/specs/2026-06-02-tma-product-definition.md` (v2 resolved). On conflict, canon wins.

## TWO SEPARATE PRODUCTS — never conflate
1. **WEB Aggregator** (ai-aggregator.ru) — AI models + agents marketplace for RU + OpenAI-compatible
   API gateway (white-label). Code: `apps/web` (Next 15), `packages/api-gateway` (Hono/Bun :4000).
   Billing: **RUBLES (₽) ONLY** (Tinkoff + subs + B2B org keys). Entity: RF (ИП → кооператив, IT 7.6%).
   Status: live; admin (Phase 14) live; marketplace ~80%.
2. **TMA** (Telegram Mini App) — **CURRENT FOCUS.** Hosted multi-user marketplace of AI agents that
   live in Telegram (discover / run / clone-template / build). Code: `apps/tg-miniapp` (Next 14.2.33 :3100),
   `apps/agent-worker` (BullMQ :3101). 4 tabs: Agents, Market, Wallet, Profile.
   Billing: **CRYPTO CREDITS (USDT/TON) ONLY — ₽ REMOVED** (founder 2026-06-02). Entity: foreign.

Hard rule: rubles never appear in TMA; crypto never appears in WEB user-facing billing.

## HERMES — intended core, NOT built
- Hermes = `NousResearch/hermes-agent`, an open-source AI-AGENT **RUNTIME** (MIT v0.15.2). NOT a model.
- **Managed Hermes runtime = R&D, deferred** (founder 2026-06-02). Today "Hermes" is just a model slug;
  real runtime = stateless BullMQ → OpenRouter loop (`apps/agent-worker/src/agent-runner.ts`).
- Blocked: 2GB VPS can't host pods, no provisioning, no isolation, no remote config REST API.
- **Live path = connect-your-own-Hermes**: user runs Hermes, gives TMA its OpenAI-compatible URL
  (`http://host:8642/v1`); TMA = UI/controller supplying our models/skills/tools + metering.
- Hermes natively bridges Telegram + ~22 platforms → we do NOT build the chat bridge.

## AGENT = composable SPEC (not a prompt)
persona (`SOUL.md`) + models by role (chat/image/voice-in/voice-out/vision, each w/ provider)
+ skills + tools/plugins + MCP servers + knowledge/memory + cron schedules.
Three ways to get one: (a) connect own Hermes [live], (b) clone public template, (c) build from scratch.
Templates are **published, not sold**: shares spec (model names, skills, tool/MCP defs w/ secrets
stripped, schedules); keeps private keys, memory, knowledge DB, history, profile.

## COMMISSION RULE (firm, in code)
- AIAG-supplied model (via :4000 gateway) → debit credits + apply markup.
- User's own key/provider (OpenRouter / Gonka / BYOK / custom URL) → charge ZERO.
- OPEN decision: "OUR catalog + YOUR key" path currently billable (wrong) — fix to free before
  any provider-catalog screen ships.

## BILLING / STATUS
- Crypto-credit balance, TON Connect top-up (server-verified TonCenter), atomic deduct, daily budget,
  run-start floor. **R0 / Phase 15.1 COMPLETE + LIVE on prod** (worker money path, gateway routing,
  auth hardening — Next 14.2.33 CVE-2025-29927 fix, HS256 pin, nginx strip, fail-hard JWT; settleRun 4/4 green).
- Branch `plan/15.1-r0-billing-identity` — NOT merged to master. `AIAG_GATEWAY_KEY` minted + live.
- Latent bug: DEFAULT_MODEL `nousresearch/hermes-4-405b` not in gateway registry (400); 0 agents on prod.
- Code migration pending: `tg_user_balances` ₽ → canonical crypto-credit unit; drop `USD_TO_RUB=90`.

## ROADMAP (Board B — hide from shippable Board A)
Tool Broker (D3, first tool Firecrawl, key_broker rail now / x402 later) · skills hub · MCP servers
(OAuth 2.1 + PKCE + RFC 8707) · full provider picker · multi-model spec editor · author profiles /
publish/monetize · run-trace · Telegram-deploy · scheduled tasks / kanban · managed-Hermes dashboard.
**x402** = rail for an agent paying OUTWARD to external paid services (foreign entity); not a top-up. Stage 5.

## SCORES (108-scale = 12 dims × 9)
Tech **50/108** · Functional **43/108** (Agents 14 / Market 11 / Wallet 11 / Profile 7) · UX **59/108**.
Worst dims: billing integrity, provider routing, auth, observability, testing, compliance.
Functional gap = almost entirely unbuilt-but-featured items; everything marketed as live genuinely works.

## NFT
⏳ open: canon says remove; Phase 15 shipped it live. Default: hide in Board A, show in Board B.
