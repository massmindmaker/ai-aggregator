# Gonka Grant — Action Plan (founder-readable)

**Date:** 2026-06-03 · **Goal:** submit AIAG to Gonka's developer-incentive program and ship a real Gonka integration.
**Backing docs:** `docs/specs/2026-06-03-gonka-grant-application.md` (paste-ready form) · `docs/specs/research/R-03.md` (technical spike) · `CLAUDE.md` (commission + white-label rules).

---

## TL;DR — what this is

Gonka is a **decentralized AI-compute Layer-1** (token **GNK**, mainnet live, PoW 2.0). It runs an **active 10,000,000-GNK developer incentive program** in 3 categories:

| Category | Reward | Decided by |
|---|---|---|
| Core breakthroughs | up to **300K GNK** | on-chain host-node **voting** |
| Infrastructure optimization | from **40K GNK** | on-chain host-node **voting** |
| Security bounties | up to **500K GNK** | on-chain host-node **voting** |

**There is NO formal application form.** You PROPOSE in **GitHub Discussions** (`gonka-ai/gonka` discussion **#795**), **promote in Discord** (`discord.gg/RADwCT2U6R`), and host nodes **vote** to fund it.

**Our fit:** AIAG already runs (LIVE on prod) an OpenAI-compatible gateway + a Telegram agents marketplace + a BYOK provider-picker + MCP skills + an atomic credit ledger. That is almost exactly Gonka's **"Infrastructure optimization / ecosystem"** ask (an aggregator adapter + delegated agent wallets). We don't build new scaffolding — we expose Gonka to a Russian-speaking agent-builder audience and route real inference demand to it. **Our category = Infrastructure optimization (from 40K GNK).**

**Posture (firm):** Gonka = **one optional provider + a grant, NOT a dependency.** AIAG / OpenRouter / BYOK paths stay primary.

---

## Critical path to SUBMIT (read top to bottom)

The proposal can be POSTED before the code is built — Gonka funds proposals, not finished products. The fastest route to a submitted proposal is the **left column (founder)** alone. The **right column (dev)** makes the proposal credible and is what we actually deliver. Do **A1 → A5 first** to submit; the dev work (B) runs in parallel and turns the promise into a live demo.

| # | (A) FOUNDER — process / non-technical (only you can do) | (B) DEV — I build |
|---|---|---|
| **1** | **A1 · Create the GNK wallet** (5–10 min) — install **Keplr or Leap** browser extension, create/import an account, add the Gonka chain, copy your **`gonka1…`** bech32 address. This is THE required field on the proposal. *(Alt: `inferenced create-client` CLI — heavier; Keplr/Leap is faster.)* | **B1 · Build the Gonka adapter** — copy `packages/api-gateway/src/upstreams/openrouter.ts` → `gonka.ts`; point base URL at GonkaGate (`https://api.gonkagate.com/v1`); key from `GONKA_API_KEY`; **keep white-label stripping verbatim** (`provider`, `system_fingerprint`, `native_finish_reason`, `message.reasoning`). |
| **2** | **A2 · Join Discord + get a handle** (5 min) — join `discord.gg/RADwCT2U6R`, set a username, find the dev/grants channel. Copy your **Discord handle** for the proposal + so you can promote it. | **B2 · Register the upstream** — add `case 'gonka':` in `packages/api-gateway/src/upstreams/registry.ts` (return `gonkaUpstream` if `GONKA_API_KEY` set, else `mockUpstream`). |
| **3** | **A3 · Get a GonkaGate API key + $10 trial** (10 min) — register at `gonkagate.com/en/register`, claim the **$10 free credit**, copy the **`gp-…`** key. Send it to me (or drop into `/srv/aiag/shared/.env`) so I can run the spike. ⚠️ Heads-up: GonkaGate charges **5% on deposit + 10% on usage**, and needs **~$20 min deposit** beyond the trial for sustained demo traffic — the $10 covers the smoke test only. | **B3 · Seed the model slug** — prod migration (manual, per deploy notes): `upstreams` row `provider='gonka'`; `models` slug `gonka/qwen3-235b`; `model_upstreams` → `upstream_model_id='Qwen/Qwen3-235B-A22B-Instruct-2507-FP8'`. **Slug must exist or routing 400s.** Don't hardcode price — set from measured cost. |
| **4** | **A4 · Decide the GonkaGate-fee question (FD-6)** (5 min, one decision) — the 10% usage fee **stacks on our 1.25 markup** → effective ≈ **1.375**. Choose: **(a) absorb** the 10% (margin hit) or **(b) surface** it in the seeded price. Tell me which; I seed accordingly. | **B4 · Run the pre-commit SPIKE** (go/no-go gate). Verify, in order: `GET /v1/models` returns live slugs → measure **p50/p95 latency** on 10–20 Qwen3-235B completions → route through **our `:4000`** (`model=gonka/qwen3-235b` via `AIAG_GATEWAY_KEY`) → confirm **ledger debit + markup + white-label stripped** → **fallback test** (seed a 2nd `model_upstreams` row, kill Gonka, confirm failover, no hard-fail). |
| **5** | **A5 · POST the proposal** (15–20 min) — paste the "Form answers" block from `2026-06-03-gonka-grant-application.md` (wallet + Discord + contact email filled in) into **GitHub Discussions `gonka-ai/gonka` #795**, then **promote it in Discord** and tag the team. Optionally share `ai-aggregator.ru` / the `@aiaggbot` TMA link. **This is the submission.** | **B5 · Build the public RU demo agent** — one demo agent running on Gonka through our marketplace + a short **Russian tutorial** ("run a Telegram agent on decentralized Gonka compute"), linked from the proposal as proof. Strengthens the host-node vote. |

**Minimum to be SUBMITTED:** A1, A2, A3, A5 (A4 only matters once we seed price). **Minimum to be CREDIBLE in the vote:** + B1–B4 (spike green) and ideally B5 (live demo).

---

## (A) Founder task list — expanded (process only; each is one concrete sitting)

1. **A1 — GNK wallet** *(5–10 min)*: Keplr/Leap extension → new account → add Gonka chain → copy `gonka1…` address. **Output:** wallet address string.
2. **A2 — Discord** *(5 min)*: join `discord.gg/RADwCT2U6R` → set handle → locate dev/grants channel. **Output:** Discord handle.
3. **A3 — GonkaGate key** *(10 min)*: `gonkagate.com/en/register` → claim **$10** → copy **`gp-…`** key → hand to dev. **Output:** API key (for the spike).
4. **A4 — Fee decision (FD-6)** *(5 min)*: absorb vs surface the 10% usage fee. **Output:** one word — "absorb" or "surface".
5. **A5 — Post + promote** *(15–20 min)*: contact email ready → fill the 3 placeholders in the form doc → post to **GitHub Discussions #795** → promote in **Discord** → tag team. **Output:** live proposal URL.

> Things ONLY you can do (identity/custody/relationship): own the GNK wallet, hold the Discord identity, agree to the GonkaGate fees with your card/funds, make the margin call (A4), and put the proposal under your name. Everything else is mine.

---

## (B) Dev deliverables — what I build (mapped to the proposal's 3 deliverables)

1. **Gonka as a first-class provider** (weeks 1–4) — adapter `gonka.ts` + registry + seeded slug + fallback row; selectable in the TMA provider-picker and the `:4000` gateway. **Gated by the B4 spike.** *Metric: Gonka tokens/day via AIAG; distinct agents running ≥1 Gonka call; p50/p95 latency.*
2. **Delegated agent wallets / budget card** (weeks 4–8) — per-agent daily-cap + per-call-cap + tool-allowlist on our R0 atomic ledger; one-tap revoke + audit log; backed by a dedicated Gonka wallet (or `GONKA_WALLETS` pool). **Note: no Gonka-native delegation API exists — we build the enforcement layer.** *Metric: active delegated wallets; GNK inference retained after free credits expire.*
3. **Agent-runtime reference + RU activation** (weeks 6–12) — Gonka available to agents on our runtime + **one public RU demo agent on Gonka** + a Russian tutorial. *Metric: new builders creating a Gonka-using agent; tutorial-referred sessions/tokens.*

---

## Known traps (do not skip)

- **Latent bug, fix before any Gonka demo:** `DEFAULT_MODEL = nousresearch/hermes-4-405b` is **not** in the gateway registry → 400 "Unknown model". A registered `gonka/*` slug must exist or routing 400s.
- **Models:** only **`Qwen/Qwen3-235B-A22B-Instruct-2507-FP8`** is dependably live; **GPT-OSS-120b** added via governance. Keep "Kimi/MiniMax/others" SOFT until `GET /v1/models` confirms they answer. **Never hardcode the model list.**
- **Grace period likely ALREADY metered** (v0.2.12 fee machinery is landing) — verify real per-token cost before seeding price; do NOT assume free.
- **Do NOT co-locate the opengnk Docker proxy on the prod VPS** (2GB RAM / 5 pm2 procs) — an OOM takes down the money path. Self-host path = separate/throwaway host, off prod.
- **Track 2b (holding end-users' raw GNK private keys) = OUT OF SCOPE** until a vetted KMS/HSM path exists — irreversible on-chain theft, no revocation. Not "deferred" — out.
- **White-label is a hard rule:** the Gonka adapter must strip provider-revealing fields exactly like `openrouter.ts`.

---

## Sources
- 10M-GNK program, 3 categories (300K / from-40K / 500K), host-node voting, GitHub Discussions #795 + Discord `discord.gg/RADwCT2U6R`: fresh web research 2026-06.
- GonkaGate broker (`https://api.gonkagate.com/v1`, `gp-` key, $10 free, 5%+10% fees, ~$20 min deposit): `gonkagate.com/en` + R-03 adversarial review.
- Live models (Qwen3-235B + GPT-OSS-120b), grace period, opengnk self-host, direct-network ECDSA/`gonka1` auth: `docs/specs/research/R-03.md`.
- Our build blocks: `packages/api-gateway/src/upstreams/{openrouter,registry,interface}.ts`, `src/routing/resolver.ts`, R0 atomic ledger; rules in `CLAUDE.md` + `SECURITY.md`.
