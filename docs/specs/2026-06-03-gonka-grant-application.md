# Gonka Foundation — Grant / Developer-Incentive Application

**Date:** 2026-06-03 · **Status:** near-submittable. Founder fills the `⟨…⟩` placeholders, then submit.
**Supersedes draft:** `2026-06-03-gonka-grant-application-draft.md`.
**Research backing:** `docs/specs/research/R-03.md` (Gonka spike findings) + synthesis decision **D-4**.

## Which program this targets
Gonka runs a **10,000,000-GNK developer incentive program** across three directions, with awards decided by **on-chain host-node voting** (sources below). Of those three, our work is **"infrastructure optimization / ecosystem"** (developer & AI-agent access — an OpenRouter/aggregator-style adapter + delegated agent wallets), which maps to Gonka's roadmap **Track 2 — Developer and AI agent access** (P1 SDK/agent-runtime · P2 OpenRouter/aggregator adapter · P3 delegated wallets & agent accounts). We apply against that direction.

> Note for founder: confirm the live submission channel before sending. As of 2026-06-03 the public process is "discuss + submit via **Discord**, rewards ratified by on-chain host-node vote." If a dedicated form/forum exists, paste this content into it; otherwise post the "Form answers" block in the developer/grants Discord channel and tag the team.

---

## Form answers (paste-ready)

**Team / Project Name:** AIAG — AI-Aggregator / AIAG Agents (Telegram Mini App)

**One-line:** A live, OpenAI-compatible aggregator + a Telegram-native AI-agent marketplace for the Russian-speaking market — we expose Gonka as a selectable inference provider and route real agent demand to it.

**GNK Wallet Address (`gonka1…`):** `⟨founder to provide — bech32 gonka1… created via inferenced/Keplr/Leap⟩`
**Discord ID / handle:** `⟨founder to provide⟩`
**Contact email:** `⟨founder to provide⟩`
**Repo / demo (optional):** `⟨ai-aggregator.ru — confirm whether to share the @aiaggbot TMA link / a public repo URL⟩`

**Which incentive direction:** Infrastructure optimization / ecosystem — developer & AI-agent access (Gonka Roadmap Track 2: aggregator adapter + delegated agent wallets + agent-runtime reference integration).

**What has your team already built (relevant to Gonka)?**
- A live, **OpenAI-compatible API gateway** (`packages/api-gateway`, Hono/Bun, `:4000`) that fronts multiple upstreams behind one endpoint with **per-call metering, configurable markup, and white-label routing** — i.e. exactly the aggregator layer Track 2 P2 describes. Running in production at `ai-aggregator.ru`.
- A **Telegram Mini App agents marketplace** (`apps/tg-miniapp` + `apps/agent-worker`): users discover, run, and create AI agents that live inside Telegram. Per-call crypto-credit billing on an **atomic ledger** with **daily-budget guards** and **run-start gating** (shipped + live; Phase 15 + R0/15.1, with `settleRun` atomicity covered by integration tests).
- A **multi-provider model** where each agent picks its provider per model; **bring-your-own-key/provider carries zero commission** (commission applies only to AIAG-supplied models). The gateway already abstracts upstreams via a single `UpstreamAdapter` interface — adding Gonka is a new adapter, not new scaffolding.
- **Current Gonka build state (honest):** the **money path is done** on branch (D-0 — the gateway returns realized margin per call) and our **SSRF egress guard `safeFetch` is done**. The **Gonka provider adapter is PLANNED, not yet built** — the concrete plan is to copy our existing `openrouter.ts` (OpenAI-compatible, white-label-stripping) to a new `gonka.ts`, change the base URL + key source, and register a Gonka upstream. We are applying to fund/validate exactly this integration.

**What will you deliver for Gonka over the next 3 months?**
Three deliverables, each tied to Gonka's primary outcome (real inference + developer activation + sustained network usage). **Each has a measurable usage metric.** Deliverable #1 is gated by a pre-commit spike (below).

> Spike acceptance is a hard precondition for #1: verify a real Gonka endpoint's **reachability, live model list (`GET /v1/models`), and measured p50/p95 latency** for a Qwen3-235B completion routed through our gateway **before** committing the integration timeline.

1. **Gonka as a first-class provider in our aggregator + agent picker** (Track 2 P2) — *weeks 1–4.*
   - Add `packages/api-gateway/src/upstreams/gonka.ts` (copy of `openrouter.ts`) and register a `gonka` upstream; seed `models` / `model_upstreams` for the live slug(s) — **`Qwen/Qwen3-235B-A22B-Instruct-2507-FP8`** confirmed live, plus **`OpenAI GPT-OSS-120b`** now added via governance voting — and discover the rest at runtime via `GET /v1/models` (never hardcode the list). Selectable in the TMA provider-picker and in the OpenAI-compatible gateway; white-label stripping preserved.
   - *Acceptance:* a user/agent can pick Gonka and run real inference end-to-end through us, with the ledger correctly metering and a **fallback upstream row** present so a Gonka outage does not hard-fail an agent run.
   - **Metric:** daily Gonka tokens processed via AIAG (`tokens/day`); # of distinct agents that executed ≥1 Gonka call; p50/p95 Gonka completion latency.

2. **Delegated agent wallets / agent budget card** (Track 2 P3) — *weeks 4–8.*
   - Per-agent spend policy (daily cap + per-call cap + tool allowlist); an agent spends within limits **without exposing the main key** and **without per-call confirmation**; one-tap delegation revocation + audit log. Built on our R0 atomic-deduct ledger as the enforcement layer, backed by a dedicated Gonka wallet (or a `GONKA_WALLETS` pool) for the Gonka-routed share.
   - *Acceptance:* an agent runs continuously, buying Gonka compute within a delegated limit; owner can revoke and audit every spend.
   - **Metric:** # of delegated agent wallets active; GNK-denominated inference **retained after free credits expire** (the real "did they keep using Gonka" signal).

3. **Agent-runtime reference integration + RU activation** (Track 2 P1) — *weeks 6–12.*
   - Gonka available to agents built on our runtime (today a stateless loop; the connect-your-own-Hermes path stays the cheap option) + **one public demo agent** running on Gonka + a short **technical tutorial in Russian** ("run a Telegram agent on decentralized Gonka compute").
   - *Acceptance:* public demo agent live on Gonka; RU tutorial published and linked from our marketplace.
   - **Metric:** developer activation (new builders who created a Gonka-using agent); real network usage attributable to the RU community (sessions + tokens from tutorial-referred agents).

**Why us / fit:** Gonka's Track 2 is almost exactly our existing product. We do not need new scaffolding — we expose Gonka to a Russian-speaking agent-builder and Telegram-user base through an already-live aggregator + marketplace, generating the real inference demand the incentive program rewards. Awards tied to measurable usage fit our metered gateway directly: every metric above is something our ledger already records.

---

## Spike plan (pre-commit gate for deliverable #1)
Small, time-boxed verification before any integration timeline is promised. Adopted from R-03 + the D-4 review.

1. **Pick the path:** spike via the **GonkaGate broker** (`https://api.gonkagate.com/v1`, `Bearer gp-…` key, prepaid USD, $10 free credit) — fastest green, no wallet plumbing in the gateway. In parallel keep the **direct/opengnk BYO-wallet path** as the "decentralized / pay-in-GNK = zero-commission" narrative, but **off the prod VPS** (see risks).
2. **Verify reachability + models:** `GET /v1/models` on the chosen endpoint; confirm exactly which slugs respond (Qwen3-235B, GPT-OSS-120b, and whether Kimi/MiniMax answer). Never hardcode the list.
3. **Measure latency:** run 10–20 Qwen3-235B completions, record p50/p95 TTFT and total latency (large MoE → expect higher TTFT than small OpenRouter models; measure, don't assume).
4. **Route through OUR gateway:** `curl :4000/v1/chat/completions` with `model=gonka/qwen3-235b` via `AIAG_GATEWAY_KEY` → real completion; verify ledger debit + markup applied + white-label fields stripped.
5. **Fallback test:** seed a second `model_upstreams` row for the same slug; kill the Gonka path and confirm an agent run fails over rather than hard-erroring.
6. **Go/no-go:** only after 1–5 are green do we commit deliverable #1's timeline. If latency/uptime is unacceptable, Gonka stays an optional/labeled-beta provider and we report findings to the Foundation rather than over-promise.

---

## Internal notes (do NOT submit)

**Posture:** Gonka = **one optional provider + a grant, NOT a dependency.** Keep AIAG/OpenRouter/BYOK paths primary; Gonka adds optionality + GNK upside + a demand-side story for the Foundation. This is the explicit D-4 decision.

**Build-state truth to keep honest in the form:**
- **Done:** D-0 money-path margin (gateway returns realized margin) — on branch `plan/15.1-r0-billing-identity`, **not yet merged to master**. `safeFetch` SSRF guard — done.
- **Planned, not built:** the Gonka adapter (`gonka.ts`). Do **not** claim it ships today. The form says "PLANNED" deliberately.
- **Latent bug to fix before any Gonka demo:** `DEFAULT_MODEL = nousresearch/hermes-4-405b` is not in the gateway registry → 400 "Unknown model". A registered `gonka/*` slug must exist or routing 400s (slug-must-exist rule).

**Risks to weigh (and how the application already hedges them):**
1. **GNK volatility** — the award is paid in GNK; treasury value swings. The application promises *usage metrics*, not a GNK price; we can deliver the work regardless of token price. Decide internally whether/when to convert.
2. **Network early / unstable** — DevShards migration (v0.2.12); the legacy proxy `gonka-gateway.mingles.ai` is flagged unreliable; `node4.gonka.ai:8000` "can hang" (use port 443, no `:8000`). Hedge: GonkaGate broker path + a fallback upstream row; never make a `gonka/*` agent hard-depend on Gonka.
3. **Grace-period economics** — inference was free during the ~180-epoch grace window, but fee machinery (v0.2.12) is landing now → **treat Gonka as metered, verify real per-token cost before seeding `model_upstreams` price.** Do not seed a "free" price on assumption.
4. **GonkaGate fees stack on our markup** — broker takes **5% on deposit + 10% on usage**; key format is `gp-…`; ~$20 min deposit beyond the $10 trial. The 10% stacks on our default 1.25 markup → ~1.375 effective. **Founder decision (FD-6):** absorb the 10% (margin hit) or surface it in the seeded price. Don't let it silently compress margin.
5. **VPS capacity** — prod box is 2 GB RAM / 5 pm2 procs. **Do NOT co-locate the opengnk Docker proxy on prod** (an OOM would take down the money path). Track 2a self-host → separate/throwaway host, or skip for the spike.
6. **Private-key custody (Track 2b)** — holding end-users' raw secp256k1 GNK keys is a different liability class than API keys (irreversible on-chain theft, no revocation). **Out of scope until a vetted KMS/HSM path exists** — not merely "deferred."
7. **Single-model overclaim** — Qwen3-235B is the dependably-live model; GPT-OSS-120b was added via governance. Keep "Kimi/MiniMax/others as the network adds them" soft until `/v1/models` confirms they answer.

**Reusable building blocks:** `gonkalabs/opengnk` (MIT proxy/SDK); our `packages/api-gateway` `UpstreamAdapter` pattern (`openrouter.ts` is the template — see lines 73–96 for the exact white-label stripping to copy verbatim); the R0 atomic-deduct ledger → becomes the delegated-wallet enforcement layer.

**Wireframes:** provider-picker (screen 17, Gonka = free / BYO-GNK), agent budget = delegated wallet (screen 33), top-up TON Connect + HOT Wallet (screen 32) — `docs/wireframes/tma/index.html`.

**Open questions before submit (founder):**
- Fill GNK wallet / Discord / email / (optional repo+demo URL).
- FD-6: absorb vs surface the GonkaGate 10% usage fee; and which path is deliverable-#1's demo (broker Track 1 for speed vs BYO-wallet for the decentralized narrative — ideally both).
- Confirm the live submission channel (Discord post vs a dedicated form/forum) and whether to bundle the OpenRouter-adapter as a standalone P2 line item or under deliverable #1.
- Ask Gonka whether a **native delegated-wallet / agent-account primitive** is on their P3 timeline (none is documented today) — affects deliverable #2's "wallet-native" framing.

---

## Sources (grant process re-verified 2026-06-03)
- Gonka 10M-token developer incentive program (three directions; on-chain host-node voting): Phemex News, KuCoin, Odaily flash (2026).
- Developer quickstart (genesis nodes `node1–3.gonka.ai:8000`; account via `inferenced`/Keplr/Leap; private-key-signature auth; live models **Qwen/Qwen3-235B-A22B-Instruct-2507-FP8** + **OpenAI GPT-OSS-120b**; grace-period zero-cost; Discord support): `https://gonka.me/developer/quickstart/`, `https://gonka.ai/docs/developer/quickstart/`.
- GonkaGate broker (`https://api.gonkagate.com/v1`, `gp-` key, $10 free, 5%+10% fees): `https://gonkagate.com/en` (per R-03 + review).
- Internal: `docs/specs/research/R-03.md`; `docs/specs/research/SYNTHESIS.md` (D-4, FD-6); `packages/api-gateway/src/upstreams/{openrouter,interface,registry}.ts`; `CLAUDE.md` (commission + white-label rules).
