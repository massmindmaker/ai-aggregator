# AIAG TMA — Critical Tech-Stack Evaluation (108-point)

**Date:** 2026-06-02 · **Scope:** `apps/tg-miniapp` + `apps/agent-worker` + the shared gateway billing path (`packages/api-gateway`) · **Method:** code-grounded (4 GSD codebase mappers, file:line evidence in `.planning/codebase/`) + external research (`.planning/research/2026-06-02-tma-stack-external-research.md`) + adversarial code re-verification of the load-bearing financial claim.

> **This is a TECH-STACK rubric, deliberately distinct from the prior scores.** The existing
> **43/108** (functional, 4 tabs × 27, `2026-06-02-tma-functional-stack-roadmap.md`) grades feature
> coverage; the **59/108** (UX, 9-dim, `2026-06-01-tma-108-reframe.md`) grades the wireframe board.
> This one grades the **engineering** behind the agents-marketplace: are the technology choices right,
> and is the implementation financially, securely, and operationally sound?

> **⚠️ Update 2026-06-02 (post-context7 verification).** A follow-up context7 documentation pass
> (`2026-06-02-tma-dev-docs-pack.md`) corrected two things in this doc: (1) the auth critique below —
> `middleware.ts` **does** verify the JWT and overwrite `x-tma-user-id`, so the real auth hole is
> **CVE-2025-29927** (unpatched Next 14.2.15), not a missing verify; (2) a **new critical money bug** —
> jUSDT is 6-decimal, so `toNano()` overpays **1000×**. Vercel AI SDK is **v5** (`Agent`/`stepCountIs`),
> not v6/`ToolLoopAgent`. The total **50/108 is unchanged**; see the dev-docs-pack for the full
> corrections + the gaps that were missing entirely (CVE floor, idempotency, rate-limit, migration
> tracking, DLQ, backup/DR, moderation).

## Headline (verified in code, not memory)

**The agent runtime is financially disconnected from the wallet.** `apps/agent-worker/src/db.ts`
contains **zero references to `tg_user_balances`**. A run debits only the per-agent counter
`agents.spent_today_rub` (`agent-runner.ts:255`) and writes `agent_runs.cost_rub`
(`agent-runner.ts:254`); the budget gates (`agent-runner.ts:172-184, 233-242`) compare against the
agent's own user-set budget, never the prepaid balance, and there is **no `balance_rub > 0` gate**.
Combined with the `kind='aiag'` path calling OpenRouter directly (`agent-runner.ts:21,49`) instead of
the markup gateway at `127.0.0.1:4000`, **agent runs earn zero revenue and zero markup, and a
zero-balance user can run inference for free up to a budget they set themselves.** This single fact
caps the score.

---

## Rubric — 12 dimensions × 9 = 108

Each dimension scored 0–9: **0–3** broken/absent on the critical path · **4–6** works but with material
debt/risk · **7–9** sound, idiomatic, production-grade.

| # | Dimension | Score | One-line verdict |
|---|-----------|------:|------------------|
| 1 | Language & monorepo foundation | **7** / 9 | TS + Turbo + clean package split is right; Bun/Node story is muddled, npm not Bun, `bullmq` version drift (5.27 vs 5.76) |
| 2 | Agent runtime & execution model | **6** / 9 | Stateless BullMQ tool-loop is the correct, cheap default for I/O-bound agents; but no memory beyond KV, no streaming, no cancel, hardcoded 12-iter / default model |
| 3 | Provider abstraction & gateway routing | **3** / 9 | Gateway is the right design but the agent path **bypasses it**; migration 0026 provider tables are **unwired in the worker** → the P0 provider-picker can't function |
| 4 | Billing & financial integrity | **2** / 9 | Gateway's `aiag_settle_charge` is excellent — but the agent path uses none of it: no balance debit, no markup, TOCTOU 4× overspend, non-atomic settle, hardcoded FX |
| 5 | Auth, security & secrets | **3** / 9 | AES-256-GCM BYOK is correct; but routes trust a spoofable `x-tma-user-id`, JWT has a public dev-fallback secret, HMAC not timing-safe, TON-proof is a no-op |
| 6 | Crypto rails (TON / USDT / x402) | **6** / 9 | TON Connect + Startonus + idempotent comment-tag credit work; x402 correctly reserved; fragile deposit-watch (last-20 window, CoinGecko SPOF), unverified wallet links |
| 7 | MCP / tools architecture | **5** / 9 | Only 4 static tools today (DDG-scrape `web_search`, calc, Kie `image_gen`, KV `memory`); but the planned MCP-SDK Streamable-HTTP gateway is the correct 2026 choice |
| 8 | Data layer (Postgres / migrations) | **5** / 9 | Sound Postgres core; but a split paradigm (raw `postgres-js` for TMA/worker vs Drizzle for web), manual untracked prod migrations, per-request connection pools |
| 9 | Streaming, realtime & reliability | **4** / 9 | Gateway SSE w/ partial-settle is great; the TMA path is 1500ms polling, swallows enqueue failures (runs stuck `pending` forever), no queue bound, no per-user run cap |
| 10 | Observability & ops | **3** / 9 | Gateway has prom-client + pino; TMA + worker have **zero** tracing/structured-logging/error-tracking on the money path; deploy is manual-migration + pm2 name drift |
| 11 | Testing & quality | **3** / 9 | ~20 tests in `apps/web` only; **zero** for TMA routes and agent-worker — billing, auth, budgets entirely untested; code style otherwise clean & idiomatic |
| 12 | Compliance & legal architecture | **3** / 9 | No 152-ФЗ consent / no data-deletion / no OFD receipt; two-entity split identified but unbuilt — and from **Jul 1 2026** the RU licensed-intermediary regime makes it mandatory |
| | **TOTAL** | **50 / 108** | Right architectural bets, dangerously thin execution on the money/trust path |

**Band:** 50/108 = *"Strong skeleton, sound choices, unsafe core."* The stack **picks** (TypeScript,
Hono OpenAI-compatible gateway, BullMQ, Postgres, TON Connect, and the planned MCP-SDK / Mastra / Vercel-AI
/ grammY / Langfuse additions) are almost all correct and externally validated. The **execution** on the
three things a paid agents-marketplace must get right — billing integrity, auth, observability — is where
it bleeds points. Cross-check: the functional 43/108 and UX 59/108 independently land on the same gaps
(supply/creator side, observability, currency soup, runtime fiction).

---

## Per-dimension detail

### 1 — Language & monorepo foundation — 7/9
**Good:** TypeScript 5.5 everywhere; Turborepo build graph; clean package boundaries
(`packages/api-gateway`, `packages/database`, `packages/shared`); `transpilePackages` correctly set for
the Telegram/TON SDKs.
**Debt:** the "Bun monorepo" framing is aspirational — tg-miniapp runs `next start` on Node, worker runs
`node dist`, only the gateway *can* run on Bun; package manager is npm. `bullmq` is `^5.27.0` in
tg-miniapp/agent-worker but `^5.76.6` in `apps/worker` (`STACK.md`) — align via lockfile. Two Postgres
clients coexist (`postgres-js` and `pg`/Drizzle).
**Fix:** decide Bun-or-Node per service explicitly; unify `bullmq`; document the postgres-js-vs-Drizzle boundary.

### 2 — Agent runtime & execution model — 6/9
**Good:** `runAgent()` (`agent-runner.ts:159`) is a clean, stateless, max-12-iteration tool-calling loop
with monthly+daily budget gates, history replay (`loadHistory`, last 10), and DM notify. For I/O-bound
LLM agents this is the correct, cheap design — no premature microVM/k3s isolation. External research
confirms: keep it as default, layer Mastra as a *library* (Apache-2.0, not Elastic-v2) for memory/workflows.
**Debt:** no token streaming to the client; no run cancellation; `MAX_ITERATIONS`/`DEFAULT_MODEL` hardcoded
(`agent-runner.ts:22-23`); memory is KV-only (`agent_memory`), no semantic recall; `code_interpreter`
intentionally stubbed (fine).
**Fix:** add SSE token streaming + a Redis cancel-flag; pgvector recall (research §4 row 8); make model/iter config-driven.

### 3 — Provider abstraction & gateway routing — 3/9
**Good:** the Hono gateway *is* the right "AIAG-as-a-provider" rail — OpenAI-compatible, with `upstreams`/
`models`/`model_upstreams` routing and a white-label scrubber on the web catalog.
**Broken:** `resolveUpstream()` (`agent-runner.ts:33-52`) is a binary `aiag | external_openai` branch where
`aiag` → `OPENROUTER_URL` directly; the gateway is never in the path. Migration `0026_provider_catalog.sql`
added `providers` / `agent_provider_credentials` / `agents.provider_id|auth_ref|...`, but `AgentRow`
(`db.ts:11-27`) and `loadAgent()` (`db.ts:50-65`) **don't read them**, and `resolveUpstream` never branches
on `provider_id` → the just-shipped P0 provider-picker has **no worker support** (`CONCERNS.md` #11).
**Fix:** wire `provider_id IS NOT NULL` → load+decrypt `agent_provider_credentials`; route `kind='aiag'`
through `127.0.0.1:4000/v1` with `AIAG_GATEWAY_KEY` (also closes #4) — and, per research, point any managed
Hermes at the same gateway so its billing flows through AIAG too.

### 4 — Billing & financial integrity — 2/9 (the critical dimension)
**Good (and unused):** `packages/database`'s `aiag_settle_charge` (SELECT-FOR-UPDATE + in-lock idempotency +
dual sub/payg bucket) is genuinely production-grade. The gateway SSE path even partial-settles on client
abort. **None of it touches agent runs.**
**Broken — verified in code:**
- **No wallet debit:** `db.ts` has zero `tg_user_balances` references; runs only touch `spent_today_rub`
  (`agent-runner.ts:255`) and `cost_rub` (`:254`).
- **No balance gate:** budgets check the agent's own user-set counters (`:172-184, 233-242`), not the
  prepaid balance → free inference at zero balance.
- **No markup:** aiag → OpenRouter direct (`:21,49`) skips the gateway's margin entirely.
- **TOCTOU 4× overspend:** `daily.spent_today_rub` snapshot (`:179`) re-checked stale under `concurrency:4`.
- **Non-atomic settle:** `markCompleted` then `incrementDailySpend` are two awaits (`:254-255`) — crash
  between leaves cost recorded but counter un-incremented.
- **Hardcoded FX:** `USD_TO_RUB = 90` (`:24`) and a static 7-model `PRICING` map (`:56-64`).
**Fix:** route through the gateway so `aiag_settle_charge` runs; add `aiag_deduct_tool_call` (idempotency
key = `tool_call_id`); gate run-start on `balance_rub >= MIN_RUN_COST`; make daily-spend an atomic
`UPDATE ... WHERE spent+delta <= budget RETURNING`; source FX from the gateway's CBR rate.

### 5 — Auth, security & secrets — 3/9
**Good:** AES-256-GCM BYOK key storage (`crypto.ts`, IV|ct|tag, `TMA_KEY_ENCRYPTION_KEY`) is correct and the
key is never returned (only a `***abcd` hint); SSRF guard `validateExternalUrl()` exists. **And — corrected
post-context7 — the auth design is actually sound:** `middleware.ts` matches `/api/tma/:path*`, requires a
Bearer JWT, `jwtVerify`s it, and **overwrites `x-tma-user-id` from the verified `sub`** (`middleware.ts:27-38`),
so a client cannot spoof the header under normal Next.js. (The earlier "spoofable header / no per-request
verify" framing from the arch map was **wrong**.)
**Broken (the real holes — worse, and partly missed first pass):**
- **CVE-2025-29927 (critical):** Next.js **14.2.15** is below the patched floor — the `x-middleware-subrequest`
  header bypasses middleware entirely → the JWT check is skipped and routes then trust the client's
  `x-tma-user-id` = **full impersonation**. The design is right; the unpatched runtime defeats it.
- **Dev-fallback secret:** `middleware.ts:5` and `auth/verify/route.ts` fall back to the public
  `'dev-only-change-in-prod'` → total forge on a misconfigured deploy (this key now verifies *every* request).
- `jwtVerify` doesn't pin `algorithms:['HS256']`; no JWT revocation/denylist; 24h initData window; HMAC `!==`
  not `timingSafeEqual` (`verify-init-data.ts:34`); `verifyTonProof()` is a `return false` stub; NFT webhook
  unsigned (IP-allowlist only).
**Fix:** **patch Next.js → ≥14.2.33** + strip `x-middleware-subrequest` at nginx; **fail hard** if
`TMA_JWT_SECRET` unset; pin `algorithms:['HS256']` + iss/aud; short-lived JWT + Redis denylist;
`timingSafeEqual`; 1h window; real Ed25519 ton-proof (needs `public_key` + `state_init` + the
pubkey↔stateInit-hash↔address check); verify NFT `txHash`.
*(Score stays 3/9 — the impersonation conclusion holds via the CVE; the mechanism + fix are corrected.)*

### 6 — Crypto rails (TON / USDT / x402) — 6/9
**Good:** `@tonconnect/ui-react` 2.4.4 connect + topup; comment-tag deposit match with an idempotent
`UPDATE ... WHERE status='pending'` guard against double-credit; NFT via Startonus. Research: KEEP — native
RU-friendly rail; x402 correctly reserved-only.
**Debt:** topup check scans only last-20 txs (delayed payment never confirms); CoinGecko free tier is a
single point of failure for the rate; wallet links accept any address (`is_verified=FALSE`, stub proof);
no canonical credit unit across `balance_rub` / `spent_today_rub` / `amount_nano_ton` (currency soup).
**Fix:** query by tx-hash + server-side reconciler cron; TonAPI Webhooks (research §8.7) instead of polling;
secondary rate source; one canonical credit unit (USDT-credit ≈ ₽).

### 7 — MCP / tools architecture — 5/9
**Now:** `tools.ts` ships 4 static tools (`web_search` = DDG HTML scrape, `calc`, `image_gen` = Kie, `memory`
= KV); `code_interpreter` stubbed. No DB-driven tools, no broker, no MCP server. Adequate for a demo, not a
supply marketplace.
**Plan (validated):** build `apps/mcp-gateway` on `@modelcontextprotocol/sdk@^1.29` **`WebStandardStreamableHTTPServerTransport`**
under Hono, per-request `McpServer` factory keyed by `agentId`, `authInfo` bearer from
`agent_provider_credentials`; SSE transport is deprecated; **mcp-context-forge is a federation proxy, NOT a
minting SDK** — don't treat it as a drop-in (research §5).
**Fix:** ship the MCP gateway + the key-broker rail (Firecrawl first) + per-call `aiag_deduct_tool_call`.

### 8 — Data layer (Postgres / migrations) — 5/9
**Good:** Postgres is the right single datastore (keeps memory/vectors RU-resident); tagged-template
`postgres-js` parameterizes queries (prepared-statement rule largely honored); migrations are append-only,
never hard-delete.
**Debt:** two paradigms (raw `postgres-js` for TMA/worker vs Drizzle for web/crons) with `agents`/`agent_runs`
having **no Drizzle schema**; prod migrations are manual/untracked with numbering drift (0021→0022 fix,
0026 unwired); each route module instantiates its own `postgres(...)` pool (no singleton) → cold-start pool
churn (`CONCERNS.md` perf).
**Fix:** shared `sql` singleton module; a lightweight migration tracker on prod; document the ORM boundary.

### 9 — Streaming, realtime & reliability — 4/9
**Good:** the gateway's `streamSSE` with partial-settle-on-abort is the hardest realtime problem already solved.
**Broken:** the TMA agent page polls `GET /agents/{id}` every 1500ms (`page.tsx:142`) — O(active_users×2)
queries; the run enqueue wraps BullMQ in a try/catch that only `console.error`s and still returns 202
(`run/route.ts:60-76`) → if Redis is down, runs are `pending` **forever** with no user signal; no queue-depth
bound, no per-user concurrent-run cap.
**Fix:** SSE/Redis-pubsub run-status keyed by `runId` (research §4 row 6); return 503 on enqueue failure +
a `failed_to_enqueue` status; bound the queue and per-user in-flight runs.

### 10 — Observability & ops — 3/9
**Good:** the gateway exports `prom-client` + pino + a `gateway_transactions` audit; pm2 + nginx deploy is
stable.
**Broken:** TMA + agent-worker have **zero** structured logging, tracing, or error tracking — `console.*`
only; failed runs are findable only by manually querying `agent_runs.status='failed'`. For a product that
moves money per call, the money path is unobservable. Deploy still needs manual prod migrations + pm2
process-name fixups (`infra` memory).
**Fix (validated):** OpenTelemetry spans across worker→gateway→tool keyed by one `traceId`/`runId`; **adopt
self-hosted Langfuse** (MIT, OTel-native); **avoid Helicone** (maintenance mode since Mar 2026); the new
`tool_calls` table doubles as the durable per-call audit feeding the run-trace screen.

### 11 — Testing & quality — 3/9
**Good:** code is idiomatic and readable; ownership checks (`WHERE tg_user_id = ...`) are consistent;
parameterized SQL throughout.
**Broken:** **zero** tests under `apps/agent-worker` and `apps/tg-miniapp/app/api` — billing, budget
enforcement, upstream resolution, initData verify, JWT issuance, topup, and the NFT webhook are all
untested; the ~20 tests live only in `apps/web` (`TESTING.md`). The auth pattern also violates the project's
own `getAuthenticatedUser()` rule (header trust instead of verified identity).
**Fix:** unit tests for `resolveUpstream`/`estimateCostRub`/budget math; an integration test for the
enqueue→worker→settle path against the gateway; a contract test for initData/JWT.

### 12 — Compliance & legal architecture — 3/9
**Good:** the strategy docs understand the landscape precisely (two-entity split, ЦФА/УЦП, 152-ФЗ, x402 posture).
**Broken in code:** no PDN consent flow before storing Telegram profile fields in `tg_users` (152-ФЗ Art. 9);
no data-deletion endpoint (Art. 14); no OFD/54-ФЗ receipts for RUB top-ups. Research adds urgency: the
**Jul 1 2026 RU licensed-intermediary regime** bars RF entities from accepting crypto for services and makes
the **two-entity split a hard legal requirement** (liability from Jul 1 2027); x402-rs self-hosting from an RU
ИП carries sanctions/MSB risk.
**Fix:** consent screen + data-export/erasure endpoints + OFD receipts on the RF entity; keep all crypto
settlement on the foreign entity; legal review before any inbound x402.

---

## Top 10 critical fixes (ranked — feeds the remediation roadmap)

1. **[P0, financial] Route `kind='aiag'` through the `:4000` gateway** so `aiag_settle_charge` runs → restores markup + white-label + audit.
2. **[P0, financial] Debit `tg_user_balances` per run + gate run-start on balance** — stop giving away free inference.
3. **[P0, security] Patch Next.js → ≥14.2.33 (CVE-2025-29927 middleware bypass)** + strip `x-middleware-subrequest` at nginx; **fail hard** if `TMA_JWT_SECRET` unset; pin `algorithms:['HS256']`. *(The JWT-verify middleware already exists and overwrites `x-tma-user-id` — the gap is the unpatched runtime + the public dev-fallback secret, not a missing verify.)*
4. **[P0, financial] Atomic daily-spend** (`UPDATE ... WHERE spent+delta<=budget RETURNING`) to kill the 4× TOCTOU overspend; wrap settle+increment in one tx.
5. **[P0, correctness] Wire migration 0026 provider columns into the worker** or the shipped provider-picker silently misroutes.
6. **[P1, security] Implement Ed25519 ton-proof; verify NFT webhook `txHash`; timing-safe HMAC; 1h initData window.**
7. **[P1, reliability] Fail loudly on enqueue error (503 + status); bound queue + per-user in-flight runs.**
8. **[P1, observability] OpenTelemetry + self-hosted Langfuse across worker→gateway→tool; build the run-trace from `tool_calls`.**
9. **[P1, money] One canonical credit unit; live FX (CBR) instead of hardcoded 90; secondary TON-rate source; tx-hash deposit reconciliation.**
10. **[P2, legal] 152-ФЗ consent + data-deletion + OFD receipts on the RF entity; formalize the two-entity split before Jul 1 2026.**

---

## Corrected stack picks (from external research — supersede prior synthesis where they differ)

| Library | Version | License | Verdict |
|---|---|---|---|
| `@mastra/core` | 1.37.1 | Apache-2.0 (`ee/` excepted) | ADOPT as library (no Elastic-v2 problem; avoid CLI on Bun; never import `ee/`) |
| `ai` (Vercel AI SDK) | **v5 stable** per context7 (research saw 6.0.194 — verify `npm view ai version`) | Apache-2.0 | ADOPT — primitive is **`Agent` + `stepCountIs`**, NOT `ToolLoopAgent`; `createOpenAICompatible` → `:4000` |
| `@modelcontextprotocol/sdk` | 1.29.0 | MIT | ADOPT (`WebStandardStreamableHTTPServerTransport`; spec 2025-11-25; SSE deprecated) |
| `mcp-context-forge` | 1.0.2 | Apache-2.0 | CAUTION (federation proxy, **not** a minting SDK; heavy Python + 2nd auth) |
| `grammy` | 1.43.0 | MIT | KEEP (Business Connection is HTTP-native — "agent in your DMs", no MTProto) |
| `@tonconnect/ui-react` | 2.4.4 | Apache-2.0 | KEEP (use TonAPI Webhooks for deposit-watch) |
| `x402` (foundation V2) | V2 | Apache-2.0 | ADOPT client-side only / CAUTION server-side (Base/Solana ≠ TON) |
| `x402-rs` | v1.3.0 | Apache-2.0 | CAUTION — legally AVOID self-hosting from the RU entity (self-custodies signer key) |
| Langfuse | 3.177.x | MIT (core) | ADOPT for observability; AVOID Helicone (maintenance mode); CAUTION LiteLLM (Mar-2026 PyPI compromise) |

**Hermes (`NousResearch/hermes-agent`, MIT):** GO conditional, **R&D only** — per-user pod isolation + memory
caps + scheduled restarts + pinned release + base-URL pointed at the `:4000` gateway. Note: the prior
synthesis's assumed `/api/local-providers|/api/models|/api/skills/install|...` endpoints **do not exist**;
real surface is `PUT /api/config|/config/raw`, `POST /api/model/set`, `GET/POST/DELETE /api/mcp/servers`,
`PUT /api/skills/toggle` + `POST /api/skills/hub/install`, `/api/cron/jobs`.

**agentic.market:** steal the machine-readable discovery surface (`GET /v1/services` + `/search` + `llms.txt`)
and the Service/Endpoint object model with `1P`/`3P` + `exact`/`upto` pricing — but **the "live metrics on
every card" feature does not exist** (price-only); use server-side ranking + aggregate hero stats instead.

---

*Tech-stack 108 evaluation — 2026-06-02. Evidence: `.planning/codebase/*.md`, `.planning/research/2026-06-02-tma-stack-external-research.md`, direct code re-verification of `agent-runner.ts` + `db.ts`.*
