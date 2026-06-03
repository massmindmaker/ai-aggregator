# AIAG — Strategic Synthesis (2026-05-30): coop, marketplace, x402, units, web-vs-TMA

Deep research synthesis. Decisions + hard legal facts.

## Cooperative (from user's coop docs + RF-legal research)
- User's `AI-Aggregator_кооперативная_архитектура.md` is solid: MVP = 1 ИП (holds IP, licenses to coop) + 1 производственный кооператив (ПК, ФЗ 41-ФЗ). Minцифры IT-accreditation → страховые 7.6%. Distribution 51% ЛТУ / 19% иное участие / 30% по паям (defends against ФНС reclassification — case ПК «Продвижение» А71-95/2021). Неделимый фонд = asset protection. Contest winner → опцион на членство (retention moat vs Replicate/HF).
- **Телемаполис** docx = federation-of-coops template (6 participant types: Житель/Гражданин/Партнёр/Соучредитель/Архитектор/Ячейка); benefits catalog. Internal "unit" = пай via "N% of payment → пай" (НК ст.251 п.2, целевые поступления, вне УСН). Only "digital" thing = DAO governance layer, NOT payments.
- **HARD TRUTH: cooperative does NOT shield 161-ФЗ / 259-ФЗ.** Coop is NOT on the list allowed to provide payment services; 259-ФЗ crypto ban applies to coops too. Coop is clean ONLY for "member → coop" prepaid balance (= пай / предоплата за свои услуги). "member → member" settlements, cash-out to rubles, and crypto payments = same risk as ИП. Coop's real value = governance + revenue-share + tax (7.6%) + community story, NOT legal arbitrage for crypto.

## Internal "stablecoin" / credit unit — the honest path
- **Own fiat-backed stablecoin = dead end for ИП РФ** (Bridge/Brale/Paxos need US MTL/trust licenses + KYC).
- **RU-legal "internal stable unit" = ЦФА / УЦП (259-ФЗ-2020 / 259-ФЗ-2019)** issued via a CBR-licensed operator (ОИС: Атомайз, А-Токен/Альфа, Сбер, Токеон/ПСБ, НРД, Т-Банк — ~15 ОИС + ~70 инвестплатформ). Issuer can be ИП OR coop. УЦП = right to a service (compute/model/tool calls), redeemed by rendering the service = clean "voucher/credit." p2p trading lives INSIDE the ОИС under CBR, not in our system. No НДС on the token itself; НДС question moves to service-redemption (needs RU tax lawyer).
- **Practical build:** user-facing = closed-loop CREDITS in our DB (fiat/TON in, atomic deduct) — covers RU-side risk; under the hood = USDC pool on Base for x402 external tools. ЦФА/УЦП = later, for a real tradable unit.

## x402 + tool marketplace (Agentic.Market: build vs buy)
- x402 v2 = mature infra (Linux Foundation, 165M+ tx). **Protocol is open & self-hostable; Coinbase Bazaar/Agentic.Market catalog is NOT (Coinbase-only; listing requires settlement via CDP facilitator which does KYT/OFAC).**
- **Decision: HYBRID with own core.** (1) Self-host **x402-rs** facilitator (Rust, verify/settle, Base/Polygon/Solana, non-custodial, Docker) — MANDATORY for RU independence from Coinbase KYT. (2) Build own storefront = registry table + search + MCP server with `search_resources`/`proxy_tool_call` (≈ trivial). (3) OPTIONALLY consume Bazaar's public discovery API as inbound supply, pay external tools USDC via OUR facilitator. Take-rate: 20-30% on curated/RU tools, 5-15% on resold Bazaar tools. Facilitator layer ~free (Base gas ~$0.0001; x402-rs no fee). Chain = Base (USDC, EIP-3009 gasless).

## Agent deployment economics
- **$200/mo tier = a CREDIT PACKAGE, not a dedicated server.** Agents are I/O-bound LLM callers (confirmed from agent-runner.ts). Dedicated container/GPU justified ONLY for media (video/image render — Kie/Hyperframes) or code (sandboxed build/test) agents → burst to rented hourly GPU per-job, teardown. Shared worker + per-agent logical quotas (Postgres + BullMQ) for everything else. Benchmarks: Devin $2.25/ACU, Replit checkpoints. Package as credits + overage, NOT "unlimited dedicated agent" (else media/code agents kill unit economics).

## Web vs TMA division (recommendation)
- **Web (ai-aggregator.ru) = supply + B2B + governance:** full marketplace, API gateway/keys, dashboard, billing, contests + author revshare, admin, cooperative/ЦФА issuance, the veiled white paper, aggregator-as-a-provider. Desktop/serious workflows, ML-engineer & B2B side.
- **TMA (Telegram) = consumer + agents + viral:** 2-click agent from prepaid template bundles, agent chat, tool storefront (Agentic.Market-style), TON top-up, connect-your-own-Hermes, mobile/social distribution. Demand side.
- **Shared backend:** gateway (4000), agent-worker, tool broker, credits/ЦФА ledger, models.dev catalog (137 providers / ~5000 models, 25 adapters, 105 OpenAI-compatible).

## Subscriptions (provider OAuth) — decided
- Keep subscription-OAuth ONLY where it actually works/allowed; DROP banned ones (Anthropic Pro/Max, OpenAI consumer, Google — all ToS-banned + server-blocked in 2026). Lead with OpenRouter + BYOK + custom OpenAI-URL. "Maximum multifunctionality" but not the banned paths.

## Thin spots (under-researched / to address)
1. Empirically test CDP/Coinbase policy toward RU before relying on Bazaar.
2. ЦФА/УЦП issuance + НДС-at-redemption + which ОИС — needs RU lawyer.
3. AVOID member-to-member + cash-out in v1 (the 161-ФЗ danger zone).
4. USDC pool custody = AML/custody exposure — who holds the wallet (non-RF entity?).
5. Agent abuse/security: prompt-injection draining balance; spend caps per tool/agent; untrusted skills/MCP supply-chain.
6. Liability when an agent acts (scraping/attacks) + 152-ФЗ for agent data + content moderation.
7. Unit economics per prepaid template bundle (e.g. video-editor with Hyperframes + prepaid media models — price so it doesn't lose money).
8. Still-open code bug: connection_type constraint (migration 0021).

## Two-entity legal split (DECIDED by user 2026-05-30) — keystone
- RF entity (ИП → производственный кооператив) = WEB aggregator, rubles, RF users, billing, contests, coop, ЦФА/УЦП, IT 7.6%. Clean under RF law.
- FOREIGN entity = AI-AGENTS layer: holds USDC wallet, runs self-hosted x402-rs facilitator, pays external x402 tools, issues the technical internal stablecoin/credit. ALL crypto exposure off the RF entity. B2B contract between them. Jurisdiction (UAE/Kazakhstan/Armenia/Georgia/Serbia) needs lawyer; the split itself solves the crypto/legal conflict the coop+ИП alone cannot.
- "Technical stablecoin" (user's intent) = closed-loop credits / simple on-chain token inside our ecosystem, no US registration, on the foreign entity; pay external tools in USDC.

See `mem:aiag_tma_agent_platform_vision_2026_05_30`, `mem:aiag_state_2026_05_30`.
