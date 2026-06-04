# R-17 — Market Monitoring (competitive intel sweep)

> **Date:** 2026-06-04 · **Scope:** AI-agent-marketplace + DeAI space deltas (~last 3–6 months) relevant to AIAG (Telegram-native AI-agent marketplace, crypto credits, author-rent monetization).
> **Method:** live web search (built-in WebSearch; Exa + Firecrawl MCP were down at run time). Every claim carries a URL + date. Where a metric is self-reported by the project, it is flagged.

---

## TL;DR (what changed and why it matters to us)

1. **Agent-to-agent commerce + onchain micropayments went from theory to standardized infrastructure.** x402 (now under the **Linux Foundation**, backed by Circle/Google/Microsoft/Stripe/Visa) crossed **100M+ agentic transactions on Base**, and **ERC-8004 (trustless agent identity)** went live on Ethereum mainnet (Jan 2026, 200K+ registrations across 20+ chains). The "tool broker / x402" layer AIAG has parked as R&D is now a real, adopted standard — not a bet.
2. **The author-rent / creator-monetization model AIAG chose is now validated by the centralized incumbents.** Poe shipped **price-per-message** for bot creators (Feb 2026) on top of its per-subscriber payout; Coze 2.0/3.0 added a **monetizable Skills Marketplace**; Character.ai went the *opposite, user-hostile* way (in-chat full-screen ads + "Charms" virtual economy, **no creator revenue share**) and is bleeding sentiment — a clear anti-reference.
3. **Telegram/TON itself shipped the rails AIAG's "agent budget card" depends on.** TON **Agentic Wallets** (Apr 28, 2026) = per-agent funded wallet, hard spending limits, revocable access — a near-exact match to AIAG's budget-card concept, and **TON Pay SDK** (Feb 2026) enables native TON/USDT checkout inside Mini Apps. This is both a gift (rails we don't have to build) and a threat (Telegram is moving into our lane).

---

## Per-player deltas

### 1) Virtuals Protocol — agent-to-agent commerce at "internet scale"
- **Agent Commerce Protocol (ACP)**: full-lifecycle onchain standard (request → negotiation → escrow → evaluation → settlement). Now in public beta; **ACP Node v2** released May 4, 2026.
- **Virtuals Revenue Network** (Feb 2026): agents autonomously request services, negotiate, execute, settle via ACP; humans deploy **tokenized agents that earn continuously**. Up to **$1M/month** incentives to agents that sell services via ACP.
- **$60M+ revenue (annualizing ~$300M), top-10 crypto protocol by revenue, no token emissions** (self-reported).
- **ERC-8183** (Mar 2026): co-authored with the Ethereum Foundation's dAI team — cross-chain "hire / deliver / settle via onchain escrow" standard. Also integrated Arbitrum.
- **Read for AIAG:** Virtuals is the loud, speculative, *tokenize-the-agent* model PRODUCT.md explicitly lists as an anti-reference. But their **ACP lifecycle (escrow + evaluation + settlement)** is the maturest blueprint for paid agent-to-agent work — worth borrowing the *shape* (escrowed deliverable + evaluation gate) for author-rent payouts, without the token speculation.
- Sources: [PRNewswire — Revenue Network launch](https://www.prnewswire.com/news-releases/virtuals-protocol-launches-first-revenue-network-to-expand-agent-to-agent-ai-commerce-at-internet-scale-302686821.html) · [ACP whitepaper](https://whitepaper.virtuals.io/about-virtuals/agent-commerce-protocol-acp) · [ACP release notes](https://whitepaper.virtuals.io/info-hub/builders-hub/agent-commerce-protocol-acp-builder-guide/acp-release-notes) · [Arbitrum integration, Mar 2026](https://coinalertnews.com/news/2026/03/25/virtuals-protocol-arbitrum-ai-integration)

### 2) x402 micropayment ecosystem — the layer AIAG marked "R&D"
- Coinbase-originated (May 2025); **x402 Foundation** with Cloudflare (Sep 2025); **moved to the Linux Foundation Apr 2026** with Circle, Google, Microsoft, Stripe, Visa backing.
- **Adoption snapshot (Apr 21, 2026):** ~**69,000 active agents**, **165M+ transactions**, **$50M volume**; **100M+ cumulative tx on Base** through Q1 2026.
- **Who's adopting:** Stripe (USDC payments for agents on Base, Feb 2026), Visa (via Trusted Agent Protocol), Google (folded into **AP2**), Cloudflare (native CDN-level paywalls), AWS, World/Worldcoin **AgentKit** (proof-of-human + x402), GPU provider **Hyperbolic** (pay-per-inference), CoinGecko (gated data feeds).
- **Tool-broker middleware emerging:** **Kobaru** (transparent x402 paywall proxy over existing APIs, no backend changes) and **Agently** (routing + settlement layer for agent-to-agent commerce) — these are exactly the "tool broker" role AIAG sketched.
- **Caveat (don't over-rotate):** CoinDesk (Mar 11, 2026) reports demand for micropayments "is just not there yet" despite the infra — adoption is supply-led, not pulled by real user demand.
- **Read for AIAG:** the standard + middleware now exist off-the-shelf. When AIAG builds the paid-tool path, **adopt x402 + a broker like Kobaru rather than inventing a settlement layer.** Pairs naturally with our crypto-credit (USD-pegged) unit.
- Sources: [BlockEden — x402 Foundation](https://blockeden.xyz/blog/2026/03/05/x402-foundation-ai-payment-internet/) · [Chainalysis — 100M payments on Base](https://www.chainalysis.com/blog/x402-agentic-payments-adoption/) · [Cryptobriefing — 100M tx](https://cryptobriefing.com/coinbase-x402-protocol-100m-transactions-base/) · [Coinbase x402 AI Agent App Store](https://cryptonews.com/news/coinbase-x402-ai-agent-app-store-crypto-payments/) · [CoinDesk — demand caveat](https://www.coindesk.com/markets/2026/03/11/coinbase-backed-ai-payments-protocol-wants-to-fix-micropayment-but-demand-is-just-not-there-yet)

### 3) Fetch.ai / ASI Alliance — "Google Search of AI agents"
- **ASI:One** (LLM + agent-orchestration "search engine for agents") in beta → broader release; **ASI:One Mobile** (iOS/Android) live.
- **Agentverse**: 2.7M+ registered agents (self-reported, platform-agnostic directory); BNB Chain hosts 150K+ deployments.
- **ASI:Create** (closed alpha, Feb 2026) — build agents at scale; current roadmap focus. **ASI:Chain mainnet** targeted late-2026/early-2027.
- **Agent Launch on BNB Chain** (May 2026): an agent can **issue its own token, attract supporters, list on a DEX in minutes, no human founder** — i.e., doubling down on tokenized/speculative agents (same anti-reference lane as Virtuals).
- **Read for AIAG:** their **discovery/routing layer (ASI:One over Agentverse)** is the interesting part — a brand-agnostic agent directory + capability routing. AIAG's catalog is curated/character-led, not a 2.7M-agent firehose; that curation + personification is our edge against directory-scale plays.
- Sources: [VentureBeat — ASI:One launch](https://venturebeat.com/ai/the-google-search-of-ai-agents-fetch-launches-asi-one-and-business-tier-for) · [Invezz — agent economy platform](https://invezz.com/news/2026/05/20/fetch-ai-launches-platform-that-gives-ai-agents-their-own-economy/) · [Cryptobriefing — ASI:One + uAgents](https://cryptobriefing.com/fetch-ai-asi-one-uagents-framework/)

### 4) Olas (formerly Autonolas) — user-owned agents + A2A bazaar
- **Pearl v1** — self-custodial "**AI Agent App Store**": Google/Apple sign-in, fund agents with a **credit/debit card**, run on a device you control, stake OLAS for rewards. (Web2 simplicity + Web3 sovereignty.)
- **Mech Marketplace** — business-facing "AI Agent Bazaar" for agent-to-agent (A2A) service buying/selling; **10M+ A2A transactions** in 2026 (self-reported). Legacy Mech agents retired (proved API-free crypto micropayments since 2023).
- Pushing **x402 support + ERC-8004-style standards** and new consumer agents (e.g. Polystrat).
- **Read for AIAG:** Pearl is the closest *consumer UX* analog — **card-funded, run-on-your-device, app-store framing.** Validates AIAG's "ready agent in 2 clicks + own-key/own-runtime" path. Their A2A marketplace volume shows agent-to-agent demand is real on the supply side. We differ by being **Telegram-native** (no separate app to install) and **character-led**.
- Sources: [Olas — Pearl v1 launch](https://olas.network/blog/introducing-pearl-v1-the-ai-agent-app-store-powered-by-olas) · [Zawya — Pearl v1](https://www.zawya.com/en/press-release/companies-news/olas-launches-pearl-v1-the-worlds-first-ai-agent-app-store-miamgzc0) · [Olas — Mech Marketplace](https://olas.network/blog/olas-launches-the-mech-marketplace-the-ai-agent-bazaar) · [Olas on X — 10M+ A2A, x402, ERC-8004](https://x.com/autonolas/status/2019752385959415861)

### 5) Poe (Quora) — direct validation of author-rent
- **Price-per-message** earnings for creators shipped **Feb 2026** (point system; creators paid in USD), on top of the existing **up to $20 per subscriber** a creator's bots drive.
- **Bot Monetization API**: dynamic per-response pricing by input/output length or compute complexity. Enhanced daily-updated **earnings analytics dashboard**.
- Positioning itself as the **"App Store of conversational AI."** US creators only for now.
- **Read for AIAG:** Poe is the cleanest proof that **author-rent / pay-per-use creator monetization is a working model** — and that **per-message + per-subscriber** can coexist. AIAG's "author sets exact sum, AIAG 0% on author rent, earns on model markup + tools + deploy" is differentiated from Poe's platform-mediated points (Poe takes the spread). Watch whether Poe expands globally — that would pressure our RU/Telegram niche.
- Sources: [Quora blog — price-per-message](https://quorablog.quora.com/New-on-Poe-Creator-monetization-via-price-per-message) · [Poe Bot Monetization API docs](https://creator.poe.com/docs/server-bots/poe-bot-monetization-api-documentation) · [VentureBeat — App Store of conversational AI](https://venturebeat.com/ai/poe-wants-to-be-the-app-store-of-conversational-ai-will-pay-chatbot-creators)

### 6) Coze (ByteDance) — skills as a monetizable unit
- **Coze 2.0** (Jan 19, 2026): pivot from chat tool to "intelligent work partner" with **long-term planning** + a **Skills Marketplace** — package expertise into reusable, installable, **monetizable** skill modules via natural language ("browse like a supermarket").
- **Coze 3.0**: multi-user multi-agent collaboration + industry skill-packs (finance, legal, healthcare, etc.).
- **Coze Studio + Coze Loop open-sourced** ([GitHub](https://github.com/coze-dev/coze-studio)).
- **Read for AIAG:** Coze validates the **SPEC-as-composable-skills** thesis at the heart of AIAG's product (persona + models + skills + tools + MCP). Their **monetizable skill modules** is a model to watch for AIAG's future "skills hub" (currently R&D). Open-sourcing Studio raises the floor on what "agent builder UX" must feel like.
- Sources: [AiX Society — Coze 2.0](https://aixsociety.com/bytedances-coze-2-0-transforming-ai-from-chat-tool-to-intelligent-work-partner/) · [Yuyjo — Coze 3.0](https://www.yuyjo.com/archives/63679) · [coze-studio GitHub](https://github.com/coze-dev/coze-studio)

### 7) Character.ai — the cautionary anti-reference
- Pivoted hard into **aggressive monetization**: **full-screen in-chat ads** (early 2026) and **"Charms"** internal virtual economy ("Roblox-ification") — tip creators, unlock voices, bypass slow-mode.
- **No creator revenue-share program** — users can't earn from creating characters. Sentiment cratering (2.6/5 Android), high-friction age-gating.
- **Read for AIAG:** textbook example of PRODUCT.md's "honest above all / never user-hostile" rule. The lesson: monetizing *against* users (ads, immersion-breaking) destroys trust; AIAG's **author-rent + own-key-free** is the opposite stance. Character.ai *not* sharing revenue with creators is exactly the gap AIAG fills.
- Sources: [AI Insights — how C.ai makes money](https://aiinsightsnews.net/how-does-character-ai-make-money/) · [RoboRhythms — every change is a cost cut](https://www.roborhythms.com/character-ai-new-update/) · [Marlvel intel report](https://marlvel.ai/intel-report/entertainment/ai-character-app)

### 8) DeAI / decentralized-compute networks (managed-Hermes context)
- **Bittensor**: 50+ (toward 128) specialized subnets; Dec 2025 halving (7,200 → 3,600 TAO/day); **Subnet 64 = serverless AI compute with TEE**.
- **Akash**: go-to for AI startups in the "GPU crunch"; instant deploy of Llama/Stable Diffusion.
- **io.net**: aggregates GPUs (incl. Render, Akash) behind familiar SDKs/APIs.
- **Render**: pivoted to primary **generative-AI compute** provider.
- **Read for AIAG:** when managed-Hermes (currently R&D, infra-blocked on a 2GB VPS) needs cheap inference/compute, **Akash / io.net / Bittensor TEE subnets are credible off-the-shelf decentralized GPU sources** — and a TEE subnet would address the eval-runner sandbox SECURITY-TODO. Keep as a provider option, not a dependency (mirrors the Gonka stance).
- Sources: [DEXTools — Bittensor subnets 2026](https://www.dextools.io/tutorials/what-is-bittensor-subnets-dtao-alpha-tokens-explained-guide-2026) · [Herond — top 10 DeAI 2026](https://blog.herond.org/top-10-decentralized-ai-projects-in-2026/)

### 9) Telegram / TON — moving into AIAG's exact lane
- **TON Agentic Wallets** (Apr 28, 2026): open standard — each AI agent gets a **dedicated user-funded wallet, hard spending limits, revocable access**, can transfer/swap/stake/pay subscriptions within budget. Inside Telegram's ~1B users.
- **TON Pay SDK** (Feb 2026): native TON + USDT checkout inside Telegram Mini Apps.
- **Read for AIAG:** **this is the single most consequential delta for us.** AIAG's "agent budget-card (daily + per-call cap + allowlist)" is almost identical to Agentic Wallets — meaning (a) we can likely **adopt the TON standard instead of building budget enforcement ourselves**, and (b) Telegram-native agent spending is becoming a platform primitive, so AIAG's moat must rest on **curation + characters + the agent SPEC + author-rent marketplace**, not on "we let agents spend crypto in Telegram" (which TON now commoditizes). TON Pay SDK also de-risks our crypto-credit top-up flow.
- Sources: [TON agentic wallet standard — news.bitcoin.com](https://news.bitcoin.com/ton-tech-gives-telegram-bots-spending-power-with-new-agentic-wallet-standard/) · [Cryptobriefing — agentic wallets](https://cryptobriefing.com/agentic-wallets-launch-ton-telegram/) · [crypto.news — agentic wallets](https://crypto.news/tons-agentic-wallets-turn-telegram-bots-into-spending-entities/)

### 10) Standards layer — ERC-8004 + A2A + AP2 converging
- **ERC-8004 (trustless agent identity)** live on Ethereum mainnet **Jan 29, 2026**; **200K+ registrations across 20+ chains in 11 weeks**; extends Google's **A2A** with onchain identity/reputation; declares **A2A + MCP endpoints** in its registration file.
- **Google A2A**: 150+ orgs in production by Apr 2026. **AP2** (Agent Payments Protocol) integrates x402.
- **Read for AIAG:** a **portable agent identity + reputation standard** is forming. Long-term, AIAG templates/agents could register an ERC-8004 identity to carry **portable reputation** across marketplaces — a future differentiator vs. walled gardens (Poe/Character.ai). Note our SPEC already references MCP, which 8004 registration files natively advertise.
- Sources: [eco.com — ERC-8004 identity](https://eco.com/support/en/articles/14730445-erc-8004-trustless-agent-identity) · [QuickNode — ERC-8004 dev guide](https://blog.quicknode.com/erc-8004-a-developers-guide-to-trustless-ai-agent-identity/) · [EIP-8004](https://eips.ethereum.org/EIPS/eip-8004)

---

## Where AIAG differentiates (the honest moat)

| Lever | Incumbents | AIAG edge |
|---|---|---|
| **Distribution** | Poe/Coze/Character.ai = standalone apps; Olas Pearl = separate app | **Telegram-native, zero install**, RU-market focus |
| **Personality** | Faceless bots / function tiles (Coze) or roleplay-only (Character.ai) | **Collectible character cards** as the catalog primitive |
| **Creator economics** | Poe takes the spread; Character.ai shares nothing | **Author sets exact rent, AIAG 0% on rent**, earns only on model markup + tools + deploy |
| **Own-key freedom** | Locked to platform billing | **BYOK / own provider = 0 commission** (rule in code) |
| **Speculation** | Virtuals/Fetch = tokenize-and-pump agents | **No agent tokens, no NFT** (removed) — honest utility |
| **Composability** | Coze skills (closed marketplace) | Open **SPEC**: persona + models + skills + tools + **MCP** + memory + cron |

**Risks to internalize:** (1) TON commoditizing in-Telegram agent spending erodes any "we enable crypto agents" pitch — lean on curation/characters/author-rent. (2) Poe going global would pressure the creator-monetization niche. (3) The whole space is **supply-heavy, demand-light** (CoinDesk's x402 read; Character.ai's user revolt) — AIAG's "UI = reality / never user-hostile" stance is a genuine trust differentiator if held.

---

## Top-3 to watch (next sweep)

1. **TON Agentic Wallets + TON Pay SDK** — directly overlaps AIAG's agent budget-card and crypto-credit top-up. Decision to surface for the founder: **adopt the TON standard vs. keep our own enforcement.** Highest-leverage, most time-sensitive.
2. **x402 + tool-broker middleware (Kobaru / Agently) under the Linux Foundation** — the off-the-shelf path for AIAG's deferred paid-tools / tool-broker layer; pairs with our USD-pegged crypto credit. Watch demand (still thin) before investing.
3. **ERC-8004 + A2A/AP2 standards convergence** — portable agent identity/reputation. Optional future differentiator for AIAG templates to carry reputation cross-marketplace; already aligns with our MCP-in-SPEC direction.
