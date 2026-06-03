# Gonka Foundation — Grant Application (DRAFT)

**Date:** 2026-06-03 · **Status:** draft for founder review before submission.
**Maps to:** Gonka Roadmap **Track 2 — Developer and AI agent access** (P1 SDK/agent-runtime · P2 OpenRouter/aggregator adapter · P3 delegated wallets & agent accounts).
**Form fields** (from the shared application sheet) are filled below; `⟨…⟩` = founder to complete.

---

## Form answers (paste-ready)

**Team Name:** AIAG — AI-Aggregator / AIAG Agents (Telegram Mini App)

**GNK Wallet Address:** `⟨gonka1… — founder to provide⟩`
**Discord ID:** `⟨founder to provide⟩`
**Email:** `⟨founder to provide⟩`

**What has your team already built (relevant to Gonka)?**
- A live, OpenAI-compatible **API gateway** (`packages/api-gateway`, Hono/Bun) that proxies multiple upstreams behind one endpoint with per-call metering, markup, and white-label routing — i.e. the aggregator layer Track 2 P2 asks for, already running in production (`ai-aggregator.ru`).
- A **Telegram Mini App agents marketplace** (`apps/tg-miniapp` + `apps/agent-worker`): users discover / run / create AI agents that live in Telegram; per-call crypto-credit billing with atomic ledger, daily-budget guards, and run-start gating (shipped + live; Phase 15 + R0/15.1).
- A **multi-provider model** where each agent picks its provider per model; **bring-your-own-key/provider = zero commission** (commission only on AIAG-supplied models). Gonka is already wired as a selectable provider option (beta) in our provider model.

**What will you deliver for Gonka over the next 3 months?**
Three deliverables, each tied to Gonka's PRIMARY metric (real inference + developer activation + network usage):

1. **Gonka as a first-class provider in our aggregator + agent picker** (Track 2 P2).
   - Gonka models (Qwen3, Kimi, …) selectable in the TMA provider-picker and in the OpenAI-compatible gateway; routed via Gonka's OpenAI-compatible endpoint (building on `gonkalabs/opengnk`).
   - *Acceptance:* a user/agent can pick Gonka and run real inference end-to-end through us.
   - *Metric:* daily Gonka tokens processed via AIAG; # active agents on Gonka.

2. **Delegated agent wallets / agent accounts** (Track 2 P3) — our "agent budget card."
   - Per-agent spending policy (daily cap + per-call cap + tool allowlist), spend within limits without exposing the main key and without per-call confirmation; one-tap delegation revocation + audit log. Backed by Gonka GNK for the Gonka-routed share.
   - *Acceptance:* an agent runs continuously buying Gonka compute within a delegated limit; owner can revoke + audit.
   - *Metric:* # delegated agent wallets active; retained inference after free credits.

3. **Agent-runtime + reference integration** (Track 2 P1) — drive RU demand.
   - Gonka available to agents built on our runtime (stateless loop today; Hermes connect-your-own path) + a public demo + a short technical tutorial in RU.
   - *Acceptance:* public demo agent running on Gonka; tutorial published.
   - *Metric:* developer activation (new builders), real network usage from RU community.

**Why us / fit:** Gonka's Track 2 is almost exactly our existing product. We don't need new scaffolding — we expose Gonka to a RU-speaking agent-builder + Telegram-user base through an already-live aggregator + marketplace, generating the real inference demand Gonka's roadmap prioritizes. Credits/grants tied to measurable usage (your stated model) fit our metered gateway directly.

---

## Internal notes (do NOT submit)

- **Posture:** Gonka = one provider + a grant, NOT a dependency. Keep AIAG/OpenRouter/BYOK paths primary; Gonka adds optionality + GNK upside + a demand-side story for them.
- **Risks to weigh:** GNK volatility (grant paid in GNK); Gonka network early/unstable (their own proxy `gonka-gateway.mingles.ai` flagged unreliable, moving to devshards); limited open models (Qwen3/Kimi). → scope a small **spike** first: confirm Gonka OpenAI-compat endpoint reachability + latency + a test inference through our gateway before committing deliverable #1.
- **Existing building blocks to reuse:** `gonkalabs/opengnk` (SDK), our `packages/api-gateway` adapter pattern, the R0 atomic deduct ledger (becomes the delegated-wallet enforcement).
- **Wireframes:** provider-picker (screen 17, Gonka=free/BYO-GNK), agent budget = delegated wallet (screen 33), top-up TON Connect + HOT Wallet (screen 32) — `docs/wireframes/tma/index.html`.
- **Before submit:** founder fills GNK wallet / Discord / email; decide whether to also pitch the OpenRouter-adapter as a standalone P2 item or bundle under #1.
