# AIAG → Gonka — The Offer Narrative ("Why Fund Us," from Gonka's Incentive View)

**Date:** 2026-06-04 · **Status:** narrative layer for the grant. Pairs with the paste-ready form in `2026-06-03-gonka-grant-application.md`.
**Purpose:** the *demand-side pitch* — not "give us tokens," but "we bring you the one thing a young decentralized-inference network most needs and can least easily get on its own: **real, sustained, metered inference demand from a market your existing channels don't reach.**"

---

## What Gonka actually rewards (verified 2026-06-04)

Gonka is a decentralized AI-**inference** network (mainnet Sept 2025; ~2,200 developers, ~12,000 GPU-equivalent capacity). GNK (1B fixed; 80% to compute hosts) prices inference, secures Proof-of-Compute governance, and pays fees. Founders' framing (crypto.news / FAQ): compute is foundational infrastructure that should be open, and **developers are the demand side that keeps hosts economically alive.** Their explicit goal is to serve **developers and entire regions structurally underserved by centralized US/Chinese AI platforms** — and to grow *real, verified usage*, not capital lockup.

**The 10,000,000-GNK developer incentive program, three directions (awards ratified by on-chain host-node vote):**
1. **Core Technology Breakthroughs** — up to 300k GNK (e.g. confidential computing).
2. **Infrastructure Optimization** — from 40k GNK (cross-chain bridging, EVM compat, aggregator/access tooling). **← AIAG fits here.**
3. **Ecosystem Security** — bug-bounty pool up to 500k GNK.

**Implication for our pitch:** the program is funded by hosts who only win if compute is *consumed*. So the most persuasive proposal is not "cool tech" — it's **"we are a demand pump."** Everything below is framed as *usage Gonka can measure*, because Gonka's own thesis says usage is what matters.

---

## HEADLINE OFFER (one line)

> **AIAG is a live, OpenAI-compatible demand pump that points Russian-speaking Telegram agent-builders at Gonka inference — sustained per-call demand from a market Gonka's current channels can't reach, metered call-by-call, routed at 0% commission as a real provider (not a dependency).**

Short version for a Discord/forum lede:
> **We don't want compute — we *send* you compute demand. Russian-speaking, Telegram-native, agent-driven, and already metered on a live gateway.**

---

## The 3–4 value props (from Gonka's incentive view)

### 1. Distribution into a region Gonka's thesis names but can't yet reach
Gonka's stated mission is serving regions kept "structurally dependent" on US/Chinese AI infrastructure. **RU is exactly that region** — OpenAI/Anthropic are largely card-and-geo-walled there. AIAG is already live in that market (`ai-aggregator.ru` + a Telegram Mini-App agents marketplace), Russian-language, with crypto-credit billing that sidesteps the card rails Western APIs require. **We are not asking Gonka to build a go-to-market for the RU/Telegram audience; we already are one.** Funding us buys Gonka demand from a segment its own docs flag as underserved, with zero new BD effort on their side.

### 2. Agents = *sustained, repeat* per-call demand, not one-shot traffic
A single agent isn't one inference — it's a loop: every run is multiple model calls, and agents run on schedules and across conversations. Our marketplace turns one onboarded builder into a recurring stream of completions. For a host network whose economics depend on *consumed* compute (not deposits), **agent workloads are the highest-retention demand shape there is** — exactly the "real usage, not capital lockup" Gonka's FAQ says it rewards. Our deliverable metric is deliberately the retention signal Gonka cares about: **GNK-denominated inference retained *after* free credits expire.**

### 3. We are the aggregator/access layer Track 2 describes — already built, not scaffolding
Infrastructure Optimization wants aggregator + developer-access tooling. We already run a production **OpenAI-compatible gateway** (`packages/api-gateway`, `:4000`) with per-call metering, configurable markup, white-label routing, and a single `UpstreamAdapter` interface. **Adding Gonka is a new adapter file, not a new platform** — the `gonka.ts` adapter is built and reviewed; spike PASSED (live `GET /v1/models`: Qwen3-235B + Kimi + MiniMax answering; **p50 244 ms / p95 941 ms** through our path — the feared large-MoE TTFT is a non-issue). Gonka gets a fully-instrumented, metered front-end into a new audience for the cost of *integrating*, not *building*.

### 4. Our agent budget-card *is* Gonka's delegated-wallet roadmap, in production form
Gonka's developer-access roadmap points at delegated wallets / agent accounts (spend within limits, no per-call signing). We already shipped the enforcement layer: an **atomic-deduct ledger with per-agent daily caps, per-call caps, tool allowlists, and one-tap revocation** (R0/15.1, `settleRun` covered by integration tests). Back it with a Gonka wallet and it's a **reference implementation of "delegated agent compute spend on Gonka"** — a primitive Gonka wants demonstrated but doesn't yet ship natively. We de-risk their roadmap with a live, audited example instead of a design doc.

---

## Honesty guardrails (keep these in the pitch — they make it credible, not weaker)

- **0% commission on Gonka, by rule.** Our commission applies only to AIAG-*supplied* models; a user routing their own provider (Gonka included) is charged **zero** — it's enforced in code (`if (isExternal) return`). So we profit when *we* supply a model, **not** when we send a call to Gonka. That removes the obvious "they're just reselling us" objection: we have no markup incentive to push Gonka; we route it because it's a genuinely good provider for our users.
- **Provider, not dependency.** AIAG/OpenRouter/BYOK paths stay primary; a Gonka outage fails over (fallback `model_upstreams` row), never hard-breaks an agent. This protects *our* users — and signals to Gonka we won't over-promise a captive funnel we can't sustain.
- **Metered, not "free-on-assumption."** We treat Gonka as metered and will verify real per-token cost before seeding price; the grace-period-is-free era is ending and we won't build on a price that's about to change.
- **No over-claim on models.** Qwen3-235B is the dependably-live anchor; others stay "as `/v1/models` confirms them."

---

## Grant criteria we must explicitly address in the submission

Gonka's process is **discuss + submit (Discord), awards ratified by on-chain host-node vote.** Host nodes vote — and hosts only earn from *consumed compute* — so write to the host's self-interest. Address each of these head-on:

1. **Which of the 3 directions** — name it: **Infrastructure Optimization** (aggregator/developer-access adapter + delegated agent wallets). The 40k-GNK-floor track. Don't leave the reviewer to guess.
2. **Measurable, usage-tied deliverables** — every deliverable must carry a metric Gonka can verify on-chain/network-side: **tokens/day routed to Gonka via AIAG; # distinct agents with ≥1 Gonka call; # active delegated agent wallets; inference retained after free credits expire; p50/p95 latency.** Awards are usage-tied; lead with the numbers our ledger already records.
3. **Real demand, not vanity** — frame as *net-new* inference from a *net-new* audience (RU/Telegram), not traffic shifted from elsewhere. Hosts care about incremental consumption.
4. **What's already built vs. planned (honest split)** — Done: live gateway + metering + white-label, atomic ledger + budget guards, the `gonka.ts` adapter (built+reviewed), spike PASS (reachability + latency). Planned/funded-by-this-grant: gateway-routed Gonka demo deploy, delegated-wallet Gonka backing, public demo agent + RU tutorial. Credibility comes from *not* claiming the planned parts ship today.
5. **Spike evidence** — include the 2026-06-04 numbers (3 live slugs; Qwen3-235B p50 244/p95 941 ms). It proves we measured before promising — the posture host-voters reward.
6. **Self-custody / security honesty** — explicitly scope **out** holding end-users' raw secp256k1 GNK keys until a vetted KMS/HSM path exists (irreversible-theft liability ≠ API-key liability). Naming this *strengthens* the Ecosystem-Security-adjacent credibility rather than pretending it's solved.
7. **GNK-denominated, not USD-denominated, success** — the award is GNK and our promise is *usage*, deliverable regardless of token price. State that we deliver the work independent of GNK price — it reassures host-voters the demand is real, not a treasury play.
8. **Region/underserved fit (their words, our match)** — quote their own "structurally underserved regions" framing and show RU/Telegram is a literal instance. This is the single most differentiating line vs. a generic aggregator applicant.

---

## Sources
- Gonka 10M-GNK program, 3 directions + on-chain host-node vote: Odaily, KuCoin, Phemex (2026); reward bands (Core ≤300k / Infra ≥40k / Security ≤500k).
- Gonka mission / underserved-regions / developers-as-demand-side: `crypto.news` "Inside Gonka's vision," gonka.ai FAQ (GNK utility: collateral/governance/fees/pricing; developers = pure consumers, no collateral; grace period ending).
- Tokenomics (1B GNK, 80% hosts, Proof-of-Compute): gonka.ai/tokenomics.pdf, github gonka-ai/gonka.
- Internal: `2026-06-03-gonka-grant-application.md` (form + spike + risks), `docs/specs/research/R-03.md`, SYNTHESIS D-4 / FD-6, `packages/api-gateway/src/upstreams/gonka.ts`, migration `0030_gonka_provider.sql`.
