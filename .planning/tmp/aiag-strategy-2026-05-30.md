# AIAG — Strategy & Monetization Architecture (2026-05-30)

Consolidated strategic decisions for AI-Aggregator (ai-aggregator.ru): cooperative org form, x402 tool marketplace, internal monetary units, two-entity legal split, web-vs-TMA division.

## Two-entity legal split (DECIDED by user, 2026-05-30) — the keystone
- **RF entity (ИП Бобров → производственный кооператив, ФЗ 41-ФЗ): the WEB aggregator.** Operates in RUBLES inside Russia. Models marketplace, API gateway/keys, RF users, billing (Tinkoff/YooKassa/TON top-up), contests + author revshare, cooperative governance, ЦФА/УЦП issuance, IT-accreditation → страховые 7.6%. Clean under RF law (no crypto-as-payment).
- **Foreign entity: the AI-AGENTS layer.** A non-RF company (crypto-friendly jurisdiction) that handles everything crypto: holds the USDC wallet, runs the self-hosted x402 facilitator, pays external x402 tools, can issue a "technical" internal stablecoin/credit. This keeps all 259-ФЗ/161-ФЗ crypto exposure OFF the RF entity.
- The two connect via a normal B2B service contract. Jurisdiction choice (UAE RAK/ADGM, Kazakhstan AIFC, Armenia, Georgia, Serbia, Kyrgyzstan, etc.) + structure needs a lawyer, but the SPLIT itself is the correct architecture and resolves the crypto/legal conflict.

## x402: use it AND self-host it
- x402 is an OPEN standard (like HTTP 402). We don't need anyone's permission to use it. We also run our OWN pieces so we don't depend on Coinbase.
- **Facilitator** = the "cashier" that verifies + settles the on-chain crypto payment so the paid service (Firecrawl etc.) doesn't deal with blockchain plumbing. Coinbase's facilitator does KYT/OFAC screening → may block RF. So we self-host **x402-rs** (open-source Rust, Docker, Base/Polygon/Solana, non-custodial) on the foreign entity → independence, no screening. That's why "to use x402 from RF" = run our own facilitator.
- Chain = Base (USDC, EIP-3009 gasless). Settlement layer is ~free (Base gas ~$0.0001; self-host = no fee).

## Internal "stablecoin" — what's realistic
- A **regulated fiat-backed stablecoin** (Bridge/Brale/Paxos) = US licenses/KYC = dead-end for RF founder.
- A **"technical" internal unit** (what the user actually means) = either (a) closed-loop CREDITS in our DB (1 credit = fixed value), or (b) a simple on-chain token used only inside our ecosystem — needs NO US registration, but MUST live on the foreign entity. For paying external x402 tools we use USDC under the hood (external tools accept USDC, not our own token). The user-facing unit = internal credits; the on-chain settlement asset = USDC pool.
- RF-legal tradable unit (if/when needed) = ЦФА/УЦП via a CBR-licensed operator (ОИС: Атомайз/А-Токен/Сбер/Токеон/НРД/Т-Банк). Issuer can be ИП or coop. УЦП = right-to-a-service voucher, redeemed by rendering the service.

## Cooperative org form
- User's `AI-Aggregator_кооперативная_архитектура.md` confirmed solid: 1 ИП (IP holder, licenses to coop) + 1 производственный кооператив (operations). Distribution 51% ЛТУ / 19% иное участие / 30% по паям (defends ФНС reclassification, case ПК «Продвижение» А71-95/2021). Неделимый фонд = asset protection. Contest winner → опцион на membership = retention moat vs Replicate/HF. Internal balance = пай via "N% of payment → пай" (НК ст.251 п.2).
- HARD TRUTH: cooperative does NOT shield 161-ФЗ/259-ФЗ. Clean only for "member → coop" balance. p2p / cash-out / crypto = same risk as ИП. Coop value = governance + revenue-share + tax (7.6%) + community brand. The crypto problem is solved by the FOREIGN ENTITY, not the coop.

## Tool marketplace (Agentic.Market): hybrid
- x402 protocol self-hostable; Coinbase Bazaar/Agentic.Market catalog is NOT (listing requires CDP settlement w/ KYT). 
- Build own: registry table + search + MCP server (search_resources + proxy_tool_call) + self-host x402-rs facilitator. Consume Bazaar's public discovery API as inbound supply. Take-rate 20-30% curated/RU, 5-15% resold.

## Agent deployment economics
- $200/mo tier = CREDIT PACKAGE + priority + premium tools, NOT a dedicated server. Agents are I/O-bound queue jobs. Dedicated container/GPU only for media (Hyperframes/Kie render) or code (sandbox) agents → burst to rented hourly GPU per-job. Everything else = shared worker + per-agent quotas (Postgres + BullMQ).

## Web vs TMA division
- Web (ai-aggregator.ru) = supply + B2B + governance: marketplace, gateway/keys, dashboard, billing, contests/revshare, admin, cooperative/ЦФА, white paper, aggregator-as-provider.
- TMA (Telegram) = consumer + agents + viral: 2-click agent from prepaid template bundles, agent chat, tool storefront, TON top-up, connect-your-own-Hermes.
- Shared backend: gateway (4000), agent-worker, tool broker, credits/ЦФА ledger, models.dev catalog (137 providers / ~5000 models).

## Providers
- 137 providers / ~5000 models (models.dev), 25 adapters, 105 OpenAI-compatible. One OpenRouter/Vercel key = 250-650 models. Universal adapter = 1 generic + ~6 native branches. Subscription OAuth: keep only working ones; Anthropic/OpenAI/Google consumer = banned (ToS + server-blocked 2026), drop them.

## Veiled white paper (for the site)
- Manifesto about co-ownership/community, NO legal/tax/crypto jargon. Words used: "совладение / доля / фонд участников / внутренние единицы вклада". Words hidden: кооператив, пай, ЦФА, налог, страховые, крипта. Narrative + "join" funnel only.

## Open thin spots
Empirically test CDP policy to RF; ЦФА/УЦП + НДС-at-redemption (RF lawyer); avoid p2p/cash-out in v1; USDC custody (foreign entity); agent security (prompt-injection draining balance, untrusted skills/MCP); liability for agent actions + 152-ФЗ; bundle unit economics; foreign-entity jurisdiction choice; unfixed connection_type bug (migration 0021).
