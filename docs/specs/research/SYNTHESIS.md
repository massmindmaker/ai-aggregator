<!-- Lead-architect synthesis of research items R-01..R-12 (each with its adversarial review). Date: 2026-06-03. -->

# SYNTHESIS — AIAG TMA architecture decisions, build order, risks, founder gates

**Author:** lead architect, AIAG TMA · **Date:** 2026-06-03
**Inputs:** R-01 … R-12 (each including its `## Adversarial review`).
**Canon it must obey:** `docs/specs/2026-06-02-WHAT-WE-ARE-BUILDING.md`, `CLAUDE.md`, `SECURITY.md`, `packages/database/CLAUDE.md`, `apps/agent-worker/CLAUDE.md`.

---

## 0. The one paragraph that frames everything

The research, read as a whole, says this: **the money path is the product, and almost every research item is really a question about money correctness.** R-04 (ledger), R-06 (cost mapping), R-07 (streamed usage), R-08 (tool metering), R-11 (creator payout) all converge on a single unresolved fork — **where is "margin" computed and which ledger is authoritative** — and four of them are *blocked* on it. Meanwhile R-05 (legal) reveals a wall the rest of the plan was quietly built against: **selling AI credits for crypto inside the Telegram mobile client violates Telegram ToS and gets the Mini App silently hidden.** So the synthesis has two spines: (1) **fix the single billing authority and make the gateway return realized margin** before building anything that pays anyone; (2) **resolve the Stars-vs-crypto product/legal fork** before building the crypto deposit machinery R-04 designs. Everything else (Hermes infra, Gonka, MCP, runtime, characters) layers cleanly on top once those two are settled. The adversarial reviews were, on balance, **high quality and load-bearing** — they caught the billing-authority hole in R-11, the streamed-usage revenue leak in R-07, the daily-budget bypass in R-08, the false isolation adjective in R-01, the fabricated token-capture in R-02, and the legal severity-inversion in R-05. I lean on them heavily and flag the two places they over-reached.

---

## 1. Firm architecture DECISIONS (with rationale + confidence)

Confidence scale: **High** = code-grounded or primary-source-verified and survived adversarial review; **Medium** = sound direction, one material correction folded in; **Low/Founder** = needs a decision the engineering can't make.

### D-0 — Single billing authority: `tg_user_balances` is the only TMA ledger; the gateway must return realized margin. **(High)**
This is the keystone decision that unblocks R-06, R-07, R-08, R-11. Adopt **R-04 Option B**: `tg_user_balances` (upgraded to a double-entry `tg_ledger_entries` + materialized projection) is the single authority a TMA user sees and is debited from. The gateway is a **white-label upstream + COGS meter**, not a second user-facing ledger. Do **not** fold TMA users into the org-scoped `organizations` ledger (identity, currency, and legal-entity mismatch — R-04 §1.2).

The non-negotiable corollary, surfaced by the **R-11 adversarial review (the strongest catch in the corpus)**: today the worker invents its own price via a hardcoded `PRICING` table × `USD_TO_RUB = 90` and throws away the gateway's real `calcCostRub`. **Margin does not exist as a number the worker can read.** Therefore: **the `:4000` gateway must return, per request, both the charged amount and the upstream cost (or `margin_credits` directly)** — via a response header or a `gateway_transactions`-keyed lookup by `gateway_request_id`. The worker must stop using `estimateCostRub` for billing on the gateway path and debit/accrue off the gateway's authoritative figure. Rationale: R-06, R-07, R-08, R-11 all silently assume a margin that isn't realized; without this they each lose money on every run. Confidence High because it is code-verified across four independent reviews.

### D-1 — Credit unit = USD, stored as integer micro-USD; kill `USD_TO_RUB = 90`. **(High)**
Per R-04 §2: `1 credit = 1 USD`, `BIGINT` micro-USD. Upstream cost is already USD; USDT is a USD stablecoin (1:1 deposit); the foreign entity is USD-exposed. ₽ becomes display-only via the gateway's CBR `fetchUsdRubRate()`. **Correction folded in (R-04 review):** the "no FX risk" claim is half-true — FX risk *moves from the credit to the margin* because COGS at the gateway is ₽-denominated (CBR) while revenue is USDT. Mitigation: reconcile ₽-COGS vs USD-revenue at the house-org boundary, or set markup wide enough to absorb peg/CBR drift. Note the constant is duplicated in `budget.test.ts:7` — change both or the test masks the bug.

### D-2 — Managed-Hermes runtime: Daytona-first for tool execution, but re-price honestly; the resident orchestrator is the real cost. **(Medium)**
Adopt R-01's platform ranking — **Daytona on-demand sandboxes (Hermes-native `terminal.backend: daytona`), Modal documented fallback, kube-green rejected (it's a clock, not a doorbell), self-host hardened-Docker only as the RF-legal stopgap.** That ranking survived review intact (F2/F3/F8 confirmed).

**But the R-01 adversarial review demolished the economics, correctly, and I adopt its correction:** the Daytona/Modal backend sandboxes **only shell/tool execution**; the `hermes gateway` agent loop **stays resident on our host and pins 300–600 MB idle** — exactly the always-on-per-user cost the "idle ≈ free / $0.30–2/mo" figure claimed to eliminate. **Drop that planning figure.** The real Phase-0 question is not "does it hibernate" (answer: no) but **"can one resident `hermes gateway` multiplex many users, or is it one process per agent?"** — that determines whether this hits the F6 RAM ceiling anyway. Also: Daytona is **shared-kernel Docker by default**, not "structural" microVM isolation — Kata/microVM (or E2B/Fly) is required *before* any untrusted public-template tenant. Cross-machine isolation from `/srv/aiag/shared/.env` does hold (different host).

**Confidence Medium, not High**, precisely because the headline economics were wrong; the platform choice is right, the cost model must be rebuilt from a Phase-0 measurement.

### D-3 — Hermes control-plane: co-located authed sidecar + file-writes; talk to the loopback dashboard API directly (no token capture); never fork. **(High on direction, with two recipe corrections)**
Adopt R-02's core: Hermes' dashboard **is** a writable FastAPI control-plane (~50 endpoints: `PUT /api/config`, `/api/env`, skills, MCP, cron, messaging, credentials, plus `POST /api/gateway/restart`, `POST /api/ops/backup`). Persona/`SOUL.md` has no endpoint → file write. **Reject the fork** (permanent merge tax, zero capability gain). Build a sanitizing exporter (strip `.env`/`auth.json`/`memories/`/`sessions/`/inline MCP tokens) before any public template.

**Two corrections from the R-02 review, both adopted:**
1. **The `_SESSION_TOKEN` HTML-scrape mechanism is fabricated** — on loopback the dashboard serves writable endpoints with *no session at all* (issue #34202). The sidecar calls the loopback API directly; drop all token-capture / re-capture-on-restart machinery.
2. **The launch recipe is stale** — `--insecure` is now an explicit *public-bind footgun*, not a loopback flag. Use `hermes dashboard --no-open --host 127.0.0.1` (NO `--insecure`); never set `HERMES_DASHBOARD_INSECURE=1`. Pin the installed version and re-verify `/api/*` against the binary.
3. **Security invariant:** loopback `/api/env` is unauthenticated, so any skill/MCP code inside the agent's own sandbox can read its `.env`. The sandbox must hold **only that agent's own gateway key**, never `/srv/aiag/shared/.env`, and must constrain the agent's own tool egress.

### D-4 — Gonka: GO, but as ONE optional provider, not a dependency. Track 1 (GonkaGate markup upstream) is the spike; opengnk BYO-wallet is the grant narrative. **(High)**
Adopt R-03: copy `openrouter.ts` → `gonka.ts` (95% identical, OpenAI-compatible), seed `model_upstreams`, register `Qwen/Qwen3-235B-A22B-Instruct-2507-FP8` (the one reliably-live model), discover the rest via `GET /v1/models` at runtime, keep white-label stripping. **Corrections from the R-03 review, all adopted:**
- GonkaGate fee = **5% deposit + 10% usage**, key format `gp-...`, ~$20 min deposit beyond the $10 trial. The 10% **stacks on our 1.25 markup** → ~1.375 effective; decide explicitly whether to absorb or surface it.
- Treat Gonka as **metered now**, not free — the grace period is operationally ending; verify real per-token cost before seeding price.
- **Do NOT co-locate the opengnk Docker proxy on the 2 GB prod VPS** (OOM would take down the money path) — separate host or skip for the spike. Track 2b (holding users' raw secp256k1 keys) is **out of scope until a KMS exists**, not merely deferred.
- Add a **fallback `model_upstreams` row** for any `gonka/*` slug as an acceptance gate (don't assume failover).

### D-5 — Real runtime: layer onto the existing loop (do NOT rip it out). AI SDK + pgvector + OTel→free-tier. But do not stream the billed call. **(Medium — one critical correction)**
Adopt R-07's stack: `ai` + `@ai-sdk/openai-compatible` with `baseURL=127.0.0.1:4000` (keeps gateway/markup/white-label), pgvector in our existing Postgres for semantic memory, OpenTelemetry spans → Grafana Cloud free tier. **Reject Helicone self-host** (ClickHouse needs 8 GB — impossible on 2 GB) and SigNoz-on-prod-box. Keep `agent_runs` as the cost ledger; OTel is for latency/traces only.

**Critical correction from the R-07 review, adopted as a Phase-1 gate (not a risk):** OpenAI-compatible **streams return `usage: null`** unless `stream_options.include_usage` is set, and our primary gateway (LiteLLM) has documented buggy streamed usage. Streaming the *billed* call risks settling a real AIAG run at **₽0**. Therefore: **do not stream the call that produces the billed `usage`** — either keep settlement non-streaming (`generateText`) and stream a separate display pass, or force `include_usage`, block settlement until the trailing usage chunk arrives, and **fall back to `estimateCostRub` (never 0) when usage is missing.** Also: the AI SDK `maxSteps` loop hides the per-iteration mid-run budget cutoffs and tool-cost accrual that the current loop enforces — re-implement via `onStepFinish`, don't just set `maxSteps: 12`. **Defer bot streaming entirely** (the worker's `bot-api.ts` is a raw fetch with no grammY and no `ctx`); ship TMA-WebApp SSE only. Bound pgvector explicitly (cap rows/agent, small-`m` HNSW, set `maintenance_work_mem` for the build, measure Postgres RSS before/after).

### D-6 — Provider picker / catalog: ONE registry (the gateway tables), native adapters in the gateway, worker stays OpenAI-only — EXCEPT route BYO native-protocol keys through the gateway. **(Medium — one design hole fixed)**
Adopt R-06: build catalog-sync from `models.dev/api.json` as a BullMQ daily job feeding the **gateway** `models`/`model_upstreams` (not a third `models_catalog`). **Convert `/1M → /1k` at sync time** (the single most likely 1000× money bug). Native Anthropic adapter + Google-via-OAI-compat base live in the gateway behind `UpstreamAdapter`; stub Bedrock/Azure. Mark stale models `status` (never hard-delete); gate billing on `status='live'`.

**Design hole fixed (R-06 review):** "worker stays OpenAI-only" silently breaks a **BYO Anthropic/Google key** — the worker would POST OpenAI-shape to `api.anthropic.com` (not OpenAI-compatible) → 404. Fix: route **all** native-protocol traffic — AIAG-supplied *and* BYO — *through the gateway* via the existing `x-upstream-key` BYOK seam, so the gateway's native adapter does the translation with the user's key. **Unify the two BYOK mechanisms** (gateway `x-upstream-key` vs worker `agent_provider_credentials`) into one before building. Thread the new `adapter` field through resolver→engine→route (not just `registry.ts`), and strip the `X-AIAG-Upstream` response header for native adapters (white-label leak the body-stripping misses).

### D-7 — SSRF egress guard (R1-7): build `safeFetch` (resolve-then-pin), ship FIRST among security items. **(High)**
Adopt R-06 §E unchanged and confirmed by both R-06 and the R1 plan: the create-time regex is defeated by DNS-rebind; the worker fetches a user-controlled `base_url` with a decrypted key and zero runtime check. Build `safeFetch`: HTTPS-only, `dns.lookup(all)`, reject the full blocked-range set (IPv6 ULA `fc00::/7`, IPv4-mapped, octal/decimal, CGNAT — all currently missing), **pin the connection to the validated IP** to close the rebind window, re-validate on every redirect hop, allowlist `127.0.0.1:4000` + `openrouter.ai`. Apply it to the worker external/`provider_id` branches **and** the gateway `proxy.ts`/native-adapter fetch (under D-6 user base_urls now reach the gateway).

### D-8 — initData hardening (R1-3): manual `timingSafeEqual` patch + short `expiresIn` + Redis one-shot nonce. Do NOT rely on the dependency for constant-time compare. **(High — review flipped the recommendation)**
The **R-10 adversarial review made the most decisive single catch**: `@telegram-apps/init-data-node@2.0.10` uses a plain `!==` string compare internally — the *exact* non-constant-time defect R-10 flagged in our code. Adopting the dependency as the "primary fix" would leave Defect 1 unfixed. **Therefore flip it:** apply the **manual patch** in `verify-init-data.ts` — length-checked `crypto.timingSafeEqual` (fixes the timing oracle) + `TMA_INITDATA_MAX_AGE_SEC` default 600s (fixes the 24h replay window) + a **Redis one-shot nonce** `SET hash 1 NX EX 600` (the only true replay defense, promoted from "optional" to default since Redis is already running and initData is used exactly once). Use the package only for `parse()`/error types if desired, and still re-verify the hash ourselves.

### D-9 — Tool broker (R-08a): build the in-process reserve→execute→settle/refund broker now; it fixes a real revenue leak. **(High — with two corrections)**
Adopt R-08a as essentially ready-to-build: two tables (`tools` catalog + `tool_calls` ledger), `(run_id, llm_call_id)` idempotency, Firecrawl as first metered tool, refund-on-error. It closes a **confirmed bug**: a costly tool (Kie `image_gen` ~6.5₽) that runs in a later-failed run is never charged (`markFailed` writes no debit). **No crypto needed.** Two corrections from the R-08 review, both adopted:
1. **Daily-budget bypass (correctness gap):** moving tool money out of `totalCostRub` makes tool spend skip the `agents.spent_today_rub` guard. The broker's per-call debit must **also** atomically increment `spent_today_rub` with the same guarded `UPDATE … WHERE spent_today_rub + price <= daily_budget_rub RETURNING`.
2. **Idempotency is a "before enabling retries" prerequisite, not a live fix** — the worker runs `attempts: 1` (no retries) today; keep it and document that the broker's safety depends on it.

### D-10 — x402 outbound (R-08b): DEFER until real demand; when built, fix the custody model first. **(Medium — review corrected a load-bearing error)**
The **R-08 review caught a load-bearing custody error:** x402's `exact`-EVM scheme is **non-custodial** — the *payer* signs the EIP-3009 authorization, USDC flows buyer→seller directly, and the **facilitator only pays gas, never holds/moves the USDC.** So "the facilitator wallet fronts USDC / drain risk" is wrong; the facilitator key is gas-only. The genuine drain surface is a **separate, thin, hard-capped USDC spend wallet** (per-run + per-day ceilings enforced *before* `/settle`), which the design omitted. When R-08b is eventually built: facilitator = gas-only 127.0.0.1 broadcaster; a distinct capped spend wallet signs authorizations; treat the spend wallet as the risk register's primary surface. Resolve D-0 (single billing authority) **before** R-08b adds a third money flow.

### D-11 — MCP: two layers kept separate. Outbound (OAuth 2.1 + PKCE + RFC 8707) via the official SDK is the showcase; inbound needs a per-agent token that does not yet exist. **(Medium — prerequisite surfaced)**
Adopt R-09: use the official `@modelcontextprotocol/sdk` (it correctly implements PKCE/`resource`/`iss`/audience — the security foot-guns), mount inbound on Hono `/mcp` and outbound `Client` + `auth()` in the worker; **do not deploy IBM mcp-context-forge** (Python, 2 GiB request — won't fit 2 GB); **do not operate an Authorization Server in phase 1** (consume tokens, don't issue). Encrypted `mcp_oauth_credentials` reusing the AES-256-GCM `crypto.ts` pattern. **Corrections from the R-09 review, adopted:**
- **The "per-agent bearer we already mint" does not exist** — agent→gateway uses a single shared `AIAG_GATEWAY_KEY`. Inbound MCP per-agent isolation needs a **new `agent_tokens` table + minting endpoint first** (re-sequence).
- **Inbound tools are not free** — `image_gen`/`web_search` cost real money; exposing them to external MCP clients is uncapped spend with no `settleRun` on the path. Phase-1 inbound = **zero-cost tools only** (`calc`, `memory`); defer paid tools inbound until metered.
- Outbound (Notion first) is the genuinely-needed OAuth work and the report nails it — make it the showcase.

### D-12 — Creator template economy (R-11): credit-native twin of the web rev-share, share-of-MARGIN not gross, payout in spendable credits. BLOCKED on D-0. **(Medium — blocked, plus correct a false "reuse" claim)**
Adopt R-11's strategy wholesale — it is the best-reasoned anti-casino design in the corpus: **no per-template token / no bonding curve** (the Virtuals failure), **per-transaction deterministic accrual** (not GPT-Store's opaque pool), **share of OUR markup margin** (floored at 0 — a template can never make us lose money), **payout in spendable credits to `tg_user_balances`** (no fiat/KYC rail, stays on-entity), **self-deal exclusion in the accrual hook**, **rank by realized margin from distinct *funded* cloners** (faking rank costs the attacker real money that becomes our margin — structurally impossible to wash-trade), **single-hop attribution** (no recursive royalty farming). **But the R-11 review proved it is not buildable until D-0 lands** (margin isn't a readable number) and caught a **factual error to correct, not copy:** the *existing* web `aiag_settle_charge` accrues on **GROSS** (`_total_rub × tier`), not margin — so "reuse the margin principle verbatim from the web side" is reusing a principle the web side doesn't implement. Audit whether that web hook is a latent over-payment bug before copying. Additional gates from the review: exclude BYOK-fixed-fee runs (they're `isExternal=false` but have no spread); specify a concrete dust floor; namespace template slugs per author (squatting); sweep author credits in a separate pass from the cloner-debit (lock ordering on `tg_user_balances`).

### D-13 — Telegram delivery (R-10 phase 3): grammY Business mode as a separate pm2 process; deliver-after-settle. **(Medium — two hard gates)**
Adopt R-10's grammY-in-Telegram-Business architecture (OFFICIAL, no MTProto, no ban risk; `business_connection_id` lets our bot act as the user's account). Separate `apps/tg-bot` pm2 process (webhook), reuse the `agent-run` BullMQ pipeline, deliver after settle (fire-and-forget). **Two gates from the R-10 review, elevated from open questions:** (1) **who pays** when a customer messages the user's business chat and our agent answers — a hard precondition, not a footnote (it ties to D-0); (2) **quantify Premium-gated reach** before committing (Business requires the end-user to have Telegram Premium + manually add the bot) — this may favor the "bring-your-own-bot-token" model instead. In the outbound worker path, pass `business_connection_id` explicitly (no `ctx` to auto-attach). Fix the ₽→credit copy in `buildRunCompletedMessage` in the same pass.

### D-14 — Character portrait/voice (R-12): content recipe over the live Kie jobs adapter; THREE input-shape gaps; phase the talking card behind a verified schema. **(Medium)**
Adopt R-12's pipeline (reference-sheet identity anchor → nano-banana-pro portraits → kling-2.6 ambient loop → ElevenLabs voice → optional Kling-Avatar talking card), all on the existing white-labelled Kie jobs transport. **Corrections from the R-12 review, adopted:**
- It's **three** `input`-shape gaps, not two: image `image_input[]`, video `image_urls[]`+`sound`, **and** audio remap `{prompt}`→`{text, voice, stability, similarity_boost, style, speed, language_code}` (the voice-tuning knobs are currently dropped).
- **Edit only `api-gateway/src/upstreams/kie.ts`** — the `packages/upstream-adapters` "curated" adapter is a dead/legacy non-jobs path; the `0.015` price row there is not in the money path.
- **Kling AI Avatar field names are unverified** (source 403'd) → **gate the talking card on a logged-in doc read**; ship the ambient loop first.
- Consistency % (85–90) are **blog-grade marketing, not measured** — don't anchor budgets on them; instrument real keep-rate in prod. Costs are ~2–3× the headline for talking cards (~$1.6–2.0 upstream); decide who eats drift-reject generations (recommend: don't bill rejects, cap free regens at 2). Re-host all Kie asset URLs to our S3/CDN (white-label).

---

## 2. Recommended BUILD ORDER

Sequenced so that money-correctness foundations land before anything that moves money, security bug-fixes ship early and cheap, crypto/legal-gated work waits on the founder, and the heaviest infra (managed Hermes) is de-risked by a measurement spike before commitment.

### Wave 0 — Money-correctness foundation + cheap security bugs (blocks the most)
These have the highest unblock-ratio and several are confirmed bugs.

1. **D-0 single billing authority + gateway-returns-margin.** Gateway surfaces `margin_credits` (or charged + upstream cost) per request keyed by `gateway_request_id`. Worker stops billing off `estimateCostRub` on the gateway path. *This single change unblocks D-5, D-6, D-8/D-9, D-11, D-12.*
2. **D-1 USD micro-credit anchor + `tg_ledger_entries`** double-entry + projection; one-way-conservative, freeze-window, dry-run-first migration of the live `tg_user_balances` (R-04 review). Kill `USD_TO_RUB = 90` (both copies).
3. **D-8 initData hardening** (manual `timingSafeEqual` + 600s `expiresIn` + Redis nonce). Tiny, security-critical, no dependencies.
4. **D-7 `safeFetch` egress guard.** Highest-severity must-ship; small and parallelizable.
5. **Fix `DEFAULT_MODEL`** registry bug (`nousresearch/hermes-4-405b` 400s) — a precondition flagged by R-05/R-06/R-07/R-09. Seed+assert one controlled slug; don't "verify post-sync."

### Wave 1 — Reconnect the deposit and tool money paths (no crypto-legal dependency)
6. **D-4 Gonka Track 1** (GonkaGate markup upstream + fallback row) — fastest "new provider" win, validates D-6 seams.
7. **D-9 tool broker (R-08a)** with the daily-budget-increment fix — closes the confirmed unbilled-tool leak.
8. **R-04 deposit reconciler** — server-side `lt`-watermark cron (authoritative) + TonAPI webhook (push) + client poll demoted to UX. Fixes the four documented funds-loss modes. **(Engineering can build this regardless of the Stars decision; it is correct in both Structure A and C.)**
9. **D-6 catalog-sync + native adapters + BYOK unification** — feed gateway tables, `/1k` conversion + CI assertion, route BYO native keys through the gateway.

### Wave 2 — Jetton + real runtime + delivery (still no founder-money gate)
10. **R-04 jetton USDT-on-TON** with the corrected `0x0f8a7ea5` transfer-init shape, `forward_ton_amount ≥ 0.05 TON`, master allowlist + `get_wallet_address` fake-jetton defense, per-user deposit addresses as the real loss-mode-2 fix.
11. **D-5 real runtime** — Phase 0 (`CREATE EXTENSION vector` + `agent_memory_vectors`), Phase 1 AI-SDK swap **with the non-streaming-billed-call gate**, Phase 2 TMA SSE, Phase 3a homegrown recall (Mastra only if 3a proves value), Phase 4 OTel.
12. **D-11 MCP** — re-sequenced: `agent_tokens` first, then inbound zero-cost tools only, then outbound Notion OAuth showcase.

### Wave 3 — Managed Hermes (gated on a measurement spike) + creator economy
13. **D-2/D-3 Managed-Hermes Phase 0 spike** — stand up ONE real Hermes with `backend: daytona` pointed at `:4000`; **measure resident-gateway RAM and whether one gateway multiplexes many users** (the real cost question), resume latency, and a week's bill. *Do not build the provisioner until this measurement says the resident-orchestrator cost is acceptable.* Then sidecar control-plane (D-3) for closed beta ≤20 agents.
14. **D-12 creator template economy** — only after D-0; substrate (publish/clone/lineage tables) first, then the margin-authoritative accrual hook with the BYOK/external/fallback zero-accrual tests.
15. **D-13 grammY Business delivery** — after the inbound-billing decision (founder) and the Premium-reach number.
16. **D-14 character pipeline** — ambient card first (3 input-shape fixes), voice second, talking card gated on the verified avatar schema.

### Deferred / R&D (explicitly not now)
- **D-10 x402 outbound** — defer to real demand; correct custody model when built.
- **Gonka opengnk self-host (Track 2a)** — off the prod VPS; separate host or skip.
- **Gonka Track 2b** (raw user keys), **template cash-out**, **MCP Authorization Server**, **Mastra**, **Helicone/SigNoz self-host**, **mcp-context-forge** — all gated on a second box or a legal structure that does not yet exist.

---

## 3. Cross-cutting RISKS

**RK-1 — The 2 GB single VPS is the binding physical constraint, and three items quietly exceed it.** Managed-Hermes resident orchestrators (R-01 review: 300–600 MB *each*, on our host), pgvector HNSW build RAM (R-07 review), and any self-hosted observability/forge/proxy (R-03/R-07/R-09) compete with the live money path on the same box. Mitigation: a **hard prod-RAM ceiling gate** before enabling each, measure RSS before/after, and treat "needs a second box" as the honest answer for managed-Hermes-at-scale, opengnk, SigNoz, and context-forge.

**RK-2 — Margin authority is the single point every money feature depends on.** If D-0 is half-done (e.g. gateway returns charge but not upstream cost), R-08/R-11 pay creators/tools out of *cost* and the platform loses money on every run; R-07 streaming can settle at ₽0. Mitigation: D-0 is Wave-0 #1, with the invariants `margin ≥ 0` and `author_share ≤ margin` enforced by CI, and "accrue 0 when margin unavailable, never guess."

**RK-3 — Telegram ToS wall vs the entire crypto-credit design (the cross-cutting legal risk).** R-05 shows the crypto-credits-in-TMA model is **not shippable on the Telegram mobile client** (silent de-listing). R-04's whole deposit machinery, R-08b, R-11 cash-out, and the "crypto credits not ₽" canon all assume a rail Telegram prohibits on mobile for digital goods. Mitigation: resolve the Stars-vs-crypto fork (FD-1) before building deposit UX; the reconciler/ledger/jetton *plumbing* is safe to build (correct under both structures), but the *surface and currency* are founder-gated.

**RK-4 — Two-entity legal boundary is assumed by code that doesn't enforce it.** $-billed compute (Daytona/Modal), USDC treasury, crypto deposits must sit on the foreign entity; RF-user PD primary-collection must be on RF infra (152-FZ is **extraterritorial** — R-05 review raised this severity; the current single foreign 2 GB VPS holding RF-user records is non-compliant as drawn). Mitigation: founder/counsel must stand up the entity split and PD-localization before managed-Hermes or crypto goes live for real users.

**RK-5 — White-label leakage across every new adapter and asset.** Native Anthropic/Google adapters (D-6), Gonka (D-4), Kie media URLs (D-14), and the `X-AIAG-Upstream` header (D-6 review) all risk leaking the upstream brand. Mitigation: per-adapter response normalization + brand-field stripping, **re-host Kie assets to our S3/CDN**, and a test asserting no `anthropic/google/gemini/claude/kling` substring (body *and* headers) on AIAG-routed calls.

**RK-6 — Secrets isolation inside the agent boundary.** Hermes loopback `/api/env` is unauthenticated (D-3), the worker fetches with decrypted keys (D-7), MCP/x402 hold user tokens (D-10/D-11), and templates carry executable skill scripts (D-3). Mitigation: per-agent isolation boundary holds only that agent's own key; `safeFetch` everywhere; sanitizing exporter + skill secret-scan; AES-256-GCM at rest with a key-rotation story before holding many users' tokens.

**RK-7 — Version/spec drift on fast-moving dependencies.** Hermes v0.15 "velocity" cadence (R-02), MCP SDK (R-09), models.dev shape (R-06), Kie hidden pricing + unverified avatar schema (R-12), Gonka DevShards migration (R-03). Mitigation: pin every external version, re-verify endpoints against the actual binary/API before writing integration code, gate unverified schemas (Kling Avatar) behind a logged-in read.

**RK-8 — Prod migrations are manual and untracked; the app role can't ALTER.** Every new table/column (D-1, D-6, D-8 nonce, D-9, D-11, D-14) needs `sudo -u postgres psql aiag` and verification of live prod state before assuming sequence numbers. The live-balance ₽→USD migration (D-1) is the most dangerous: freeze-window, conservative, idempotent guard-row, dry-run the SUM-invariant on a prod dump first.

---

## 4. Decisions that genuinely require the FOUNDER (money / legal / brand)

These cannot be made by engineering; several block whole waves.

**FD-1 — Stars-vs-crypto product surface (THE blocker, R-05).** Is the Telegram mobile surface a must-have? Pick a structure:
- **Structure C (recommended by R-05 + its review):** dual-rail, single non-withdrawable USD-pegged credit ledger — **Stars on mobile** (route Star top-ups to desktop/web where the cut is ~3–4% vs ~32%; model the **21-day hold + 1,000-Star floor** as working capital), **USDT/TON on web/desktop**; **BYOK/own-provider is a first-class compliance lane** on mobile (no AIAG digital good sold → no Stars mandate). Demote Structure B ("crypto-native mobile-thin") to **not recommended** — silent de-listing risk with none of the casino margins that justify it. This decision gates all crypto deposit UX (D-13 inbound, R-04 surface, x402, cash-out).

**FD-2 — Are AIAG credits withdrawable/transferable, or strictly non-withdrawable prepaid SaaS? (R-05, R-04 Q4, R-11 Q3).** Non-withdrawable single-merchant prepaid SaaS is the single highest-leverage compliance choice — it keeps AIAG out of VASP/e-money/161-FZ. Withdrawable balances trigger licensing almost everywhere. This decides template **cash-out** (D-12), user wallet **withdrawals**, and the foreign-jurisdiction license question.

**FD-3 — Foreign jurisdiction + entity split + PD localization (R-05, R-01, RK-4).** Which foreign entity (UAE/VARA vs EU-MiCA vs offshore), can it open a fiat off-ramp, and where does RF-user PD primary-collection live (must be RF infra)? Gates managed-Hermes-for-real-users (D-2, $-billed) and any crypto inflow. Get written legal opinions in RF (259/161/152-FZ) and the chosen jurisdiction before any user money moves.

**FD-4 — Default `author_share_bps` for the creator economy (R-11 Q1).** 15% of margin is the placeholder; founder call balancing creator incentive vs platform margin (Poe lets creators price; GPT-Store pays a thin pool — we sit between). Tunable per-template by design.

**FD-5 — Inbound-billing for Telegram Business / business-chat answers (R-10 Q4).** When a customer messages the user's business chat and our agent answers, whose balance is debited and at what markup? A hard precondition for D-13, not an open question.

**FD-6 — Gonka fee treatment (R-03 review).** Absorb GonkaGate's 5%+10% (margin hit under the 1.25 markup → ~1.375 effective) or surface it in the seeded price? And which is the grant deliverable-#1 demo (Track 1 vs the BYO-wallet narrative)?

**FD-7 — Talking vs ambient character card as default, and stock vs cloned voices (R-12).** Talking cards cost ~2–3× and need a script + per-card voice; cloned voices/faces raise consent + 152-FZ biometric exposure. Recommend ambient default, stock ElevenLabs voices, founder-owned faces; talking + cloning as explicit/paid consented actions.

**FD-8 — x402 self-host vs hosted facilitator, and whether to run an outbound USDC rail at all (R-05, R-08).** Hosted (Coinbase/Stripe/Circle) keeps AIAG nearer the low-regulatory "payer" role; self-hosting + a spend wallet increases the money-handling footprint. Defer either way until demand exists (D-10).

---

## 5. Where the adversarial reviews HELD vs over-reached

**Held up and load-bearing (I adopted these):**
- R-11: margin isn't computable in `settleRun` — the corpus's most important catch (drives D-0).
- R-07: streaming the billed call can settle at ₽0 — a revenue leak mislabeled as "drift."
- R-08: x402 is non-custodial (facilitator = gas-only); tool spend bypasses the daily budget.
- R-01: "idle ≈ free" is false (resident orchestrator stays on our host); Daytona is shared-kernel, not "structural" isolation.
- R-02: the `_SESSION_TOKEN` capture is fabricated; `--insecure` recipe is stale.
- R-10: the recommended init-data dependency uses `!==` internally — adopting it would *not* fix the timing oracle. Flipped the recommendation.
- R-05: 152-FZ is extraterritorial (severity raised); the КоАП fine is a pending 2026 bill, not live law (urgency reframed, recommendation unchanged); BYOK is a compliance lane; desktop-Stars economics (~3–4%) materially improve Structure C.
- R-06: the BYO-native-key path is broken under "worker stays OpenAI-only"; `/1M→/1k` is a real 1000× bug.
- R-09: the "per-agent bearer we already mint" doesn't exist; inbound tools aren't free.
- R-12: it's three input-shape gaps; the legacy Kie adapter isn't in the money path; avatar schema unverified.

**Over-reached / I did NOT fully defer to the review (flagged):**
- **R-05 review, Structure-A vs C nuance:** the review's desktop-Stars carve-out (~3–4%) is real but it also concedes you **cannot force** mobile users to buy on desktop and that steering them may brush Telegram/Apple anti-steering rules (its own added Q8). I treat the desktop-economics optimization as *upside, not the plan* — Structure C still imports the mobile-Stars cut for users who buy in-app, and FD-1 must decide with eyes open, not assume the cheap path.
- **R-07 review, "real usage may be WORSE than the PRICING estimate":** correct as a caution, but the review slightly overstates it into doubting streamed usage wholesale. The right resolution is the gate I adopted (validate gateway streamed-usage fidelity on 20 real runs; keep `estimateCostRub` as the charged value until proven) — i.e. neither "real usage is always better" (the report) nor "don't trust it" (the review), but "measure, then decide."
- **R-04 review, dual-indexer corroboration:** the review calls the report's two-indexer-before-credit design over-engineered for a 2 GB box and recommends single-indexer + on-chain finality for MVP. I agree and adopt the simpler MVP — but keep TonAPI as the *push* (webhook) wake, not as a mandatory second confirmation, so we get low latency without the "one indexer lags → stuck" failure mode.

Net: the reviews were strong enough that the synthesis is materially safer than any single report taken at face value — most importantly, it refuses to build any payout/tool/streaming feature until the gateway returns an authoritative margin (D-0), and it refuses to build crypto deposit UX until the founder resolves the Telegram-ToS fork (FD-1).
