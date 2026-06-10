# AIAG Monorepo — Architecture & Risk Audit

**Date:** 2026-06-10
**Scope:** Turborepo `C:\Users\боб\projects\aggregator` (`apps/*`, `packages/*`)
**Auditor focus per project anchor:** billing integrity, provider routing, auth, observability, testing, compliance.

> TL;DR — The single most urgent class of defect is **money-path settlement integrity on the WEB product**: real RUB inflow is currently **unreconcilable / non-crediting** because the wired payment webhook is a stub, no pending payment row is persisted before redirect, and the admin refund endpoint is effectively unauthenticated. On the TMA product, **streamed gateway runs never deliver billing headers**, so the agent-worker silently bills off a local estimate with **zero markup** — invisible margin leakage. Fix the WEB settlement path and the admin refund guard **first**.

---

## 1. System Overview

AIAG operates **two distinct products** over **one shared Postgres** and **one shared OpenAI-compatible gateway**:

| # | Product | Domain | Billing unit | Front door | Money path |
|---|---------|--------|--------------|-----------|------------|
| 1 | **Aggregator WEB** | ai-aggregator.ru | **RUB** | `apps/web` (Next 14) | RUB top-up / subscriptions via Tinkoff + YooKassa → org credits; gateway debits org wallet |
| 2 | **TMA (Telegram Mini App)** | Telegram | **crypto credits** (USD cents, 1 credit = $0.01) | `apps/tg-miniapp` (Next 14, `/tg`) | TON top-up → credit balance; `apps/agent-worker` debits per agent run |

**Shared inference plane:** `packages/api-gateway` (Hono/Bun, `:4000`) is the OpenAI-compatible upstream for **both** products. It resolves model → upstream, routes, proxies, prices in RUB, settles against the org wallet, and emits **authoritative billing headers** (`X-AIAG-Charged-Rub`, `x-aiag-charged-usd-micro`, …) so WEB bills in RUB and the TMA worker bills in USD-micro credits from the gateway's real numbers.

### Apps / Packages map

**Apps**
- `apps/web` — WEB storefront + customer dashboard + admin console + REST API (~150 route handlers). **Money path.**
- `apps/tg-miniapp` — TMA UI + backend API (`app/api/tma/*`). TON top-up, agent CRUD/run, NFT. **Money path.**
- `apps/agent-worker` — BullMQ runtime for the TMA agents marketplace. Per-run tool-calling loop, budget gates, atomic settlement, credit debit, scheduler. **Live credit-debit path.** Standalone (no `@aiag/*` workspace deps).
- `apps/worker` (`@aiag/worker`) — WEB background jobs/crons: upstream poll, contest eval, webhook retry, email, and the money-path crons `closeContestsCron` (prize awards) + `finalizeEarningsCron` (author earnings promotion). **Money path.**

**Packages**
- `packages/api-gateway` — the `:4000` gateway. **Money path.**
- `packages/database` (`@aiag/database`) — single shared Drizzle schema + raw SQL migrations + `aiag_settle_charge` stored fn. **Canonical billing primitives.**
- `packages/shared` (`@aiag/shared`) — revshare/tax money logic, Zod validation, SSRF-hardened `safeFetch`, S3, Startonus TON client. **Money path.**
- `packages/upstream-adapters` (`@aiag/upstream-adapters`) — provider adapter contract + concrete adapters + BYOK. **Imported only by `apps/worker`; the gateway does NOT use it** (see routing findings). **Money path.**
- `packages/tinkoff` (`@aiag/tinkoff`) — Tinkoff Acquiring SDK. **Money path.**
- `packages/yookassa` (`@aiag/yookassa`) — YooKassa REST SDK. **Money path.**
- `packages/email` (`@aiag/email`) — Unisender Go transactional email. Not money path (but money-path templates exist and are unwired).
- `packages/telegram-alerts` (`@aiag/telegram-alerts`) — Telegram Bot API alert sink. Not money path.

---

## 2. Service & Dependency Map

Money-path units are marked **💰**.

```
                            ┌──────────────────────────────────────────┐
                            │  packages/api-gateway  :4000  💰          │
                            │  (Hono/Bun, OpenAI-compatible)            │
                            │  auth → routing → proxy → price → settle  │
                            └──────────────────────────────────────────┘
                              ▲ (HTTP, billing headers)   │ settleCharge()
       playground SSE proxy   │                           ▼
   ┌─────────────┐            │              ┌──────────────────────────┐
   │ apps/web 💰 │────────────┤              │ packages/database 💰     │
   │ (RUB store) │            │              │ aiag_settle_charge (SQL) │
   └─────────────┘            │              │ tg_* + org credits tables│
        │ @aiag/{tinkoff,     │              └──────────────────────────┘
        │ yookassa,database,  │                         ▲
        │ shared,email,       │   billable run (HTTP)    │ raw postgres tagged templates
        │ telegram-alerts,    │   ┌──────────────────────┴────────┐
        │ worker}             │   │ apps/agent-worker 💰           │
        ▼                     │   │ BullMQ 'agent-run' + scheduler │
   ┌─────────────┐            └───│ settleRun() atomic debit       │
   │ apps/worker │ 💰             │ NO @aiag/* deps (standalone)   │
   │ crons+queues│                └────────────────────────────────┘
   └─────────────┘                         ▲ enqueue (BullMQ Redis)
        │ @aiag/{database,shared,           │
        │ upstream-adapters[unwired]}       │
        │                          ┌────────┴───────────┐
        │                          │ apps/tg-miniapp 💰 │
        │                          │ (TON top-up, agents)│
        │                          │ @aiag/shared (nft)  │
        │                          └────────────────────┘
```

**Key dependency facts**
- `apps/agent-worker` is deliberately **standalone** — it ships **verbatim triplicate copies** of `safe-fetch.ts` and `crypto.ts` (also in `apps/tg-miniapp` and `packages/shared`) with a "keep in sync" comment. Drift risk on an SSRF-critical control.
- `packages/upstream-adapters` is imported **only** by `apps/worker`; the gateway dispatches through its **own** internal `src/upstreams/*` adapters → two divergent adapter sets, root of the routing/dispatch provider mismatch.
- The gateway↔worker billing-header contract is verified only by a **name-equality** contract test, not delivery.
- `packages/database` is a **leaf** (no `@aiag/*` deps) but its Drizzle schema does **not** describe the TMA money tables nor the org credit columns (raw-SQL-only).

---

## 3. Top Risks — Ranked by Severity

Merged & deduped across unit maps and cross-cutting findings. Severity reflects realized business impact (money loss, auth bypass, compliance).

### CRITICAL

**C1. WEB: the wired payment webhook is a stub — users pay RUB and are never credited.**
`/api/payments/topup` and `/api/subscriptions/create` set `notificationUrl = /api/subscriptions/webhook/[provider]`, but that handler only verifies the signature, logs, and returns 200 — it does **not** credit balance (settlement is a "TODO Plan 04" comment). The handler that actually settles (`/api/webhooks/tinkoff`) is wired to **nothing**.
*Locations:* `apps/web/src/app/api/subscriptions/webhook/[provider]/route.ts:67-69,101`; `apps/web/src/app/api/webhooks/tinkoff/route.ts`; `apps/web/src/app/api/payments/topup/route.ts:61`; `apps/web/src/app/api/subscriptions/create/route.ts:64`.

**C2. WEB: no pending payment/subscription row is inserted before PSP redirect → inflow is unreconcilable.**
`orderId` is generated client-side, never stored, and uses `Math.random` (non-crypto) for a financial idempotency token. Even a correct webhook has no row to match on `order_id`.
*Locations:* `apps/web/src/app/api/payments/topup/route.ts:23-27,53`; `apps/web/src/app/api/subscriptions/create/route.ts:19-27,56`.

**C3. WEB: admin manual-refund endpoint is effectively unauthenticated and unaudited.**
Guard is `if (role && role !== 'admin') return 403` — when `session.user.role` is undefined the check is **skipped**, so any logged-in user can trigger a real PSP refund. No DB persistence, no `audit_log` row. It is the only admin route not using `requireAdmin/withAdmin`. Direct path to financial loss.
*Location:* `apps/web/src/app/api/admin/payments/refund/route.ts:37-44`.

**C4. TMA: streamed gateway runs never deliver billing headers → margin-free billing on every stream.**
In `sse.ts` the billing/`X-AIAG-Partial` headers are set **after** the SSE body begins (Hono/Bun flushes headers on first write → `c.header()` is a no-op). The worker reads `x-aiag-charged-usd-micro` to set `billedByGateway=true`; on streamed runs the header is absent, so `billedByGateway` is always false and the worker bills off `estimateCostCredits` (local PRICING, **no markup**). The gateway already debited the house org via `settleCharge`, so the two diverge and realized margin is never captured. The contract test asserts header **name** equality only.
*Location:* `packages/api-gateway/src/streaming/sse.ts:127-139`; reader `apps/agent-worker/src/agent-runner.ts:288-299`.

**C5. WEB: async job + contest-eval sinks are stubs → paid async generations never settle.**
`upstream-poll` and `contest-eval` processors only `logger.info`; they never write `prediction_jobs` / `evaluations`. A paid async generation can complete upstream while the DB job stays non-terminal forever.
*Location:* `apps/worker/src/index.ts:35-53`.

**C6. WEB: silent self-re-enqueue drop in worker queues.**
`(job as any).queue?.add(...)` — if `job.queue` is undefined the retry is silently dropped (no throw, no DLQ). Webhook deliveries / upstream polls can be lost. Also reaches undocumented BullMQ internals.
*Location:* `apps/worker/src/queues/webhook-retry.ts:70-74`; `apps/worker/src/queues/upstream-poll.ts:81-85`.

**C7. Gateway `/metrics` is observability theater — counters defined and served, never incremented.**
Full metric set exists (`aiag_requests_total`, `aiag_settlement_failures_total`, `aiag_balance_exhaustion_total`, …) and is served, but repo-wide there are **zero** `.inc/.observe/.set` call sites. `/metrics` always returns 0 for every series.
*Location:* `packages/api-gateway/src/metrics.ts`; served at `packages/api-gateway/src/index.ts:118`.

### HIGH

**H1. DEFAULT_MODEL bug only half-fixed — TMA template still seeds the unregistered hermes slug.**
The worker `DEFAULT_MODEL` is now `openai/gpt-4o-mini`, but `apps/tg-miniapp/src/lib/agent-templates.ts:69` still ships `defaultModelSlug: 'nousresearch/hermes-4-405b'` (not in the gateway registry). Any agent cloned from the "researcher" template stores that slug → gateway resolver throws 400 → worker falls back to direct OpenRouter (no markup, no white-label, no `gateway_transactions` row). Stale PRICING row at `agent-runner.ts:132` and `budget.test.ts` mask it.
*Locations:* `apps/tg-miniapp/src/lib/agent-templates.ts:69`; `packages/api-gateway/src/routing/resolver.ts:54`; `apps/agent-worker/src/agent-runner.ts:40,132,305-313`.

**H2. Silent OpenRouter fallback bypasses markup + white-label + audit; margin loss invisible.**
When `AIAG_GATEWAY_KEY` is unset, or on any model-not-found, the worker routes directly to OpenRouter with only `console.warn`. No metric, no alert. Also: gateway `PORT` default is `8787` while the worker hardcodes `:4000` — a mismatched env silently triggers this margin-free path.
*Locations:* `apps/agent-worker/src/agent-runner.ts:116-126,305-316`; `packages/api-gateway/src/config.ts:9`.

**H3. Monthly budget has no atomic guard in `settleRun` (only daily does) → concurrent runs overspend the monthly cap.**
Monthly enforcement rests on a stale pre-loop `sumMonthlySpend`. Two concurrent runs read the same value, both pass, both settle. (Balance debit still prevents spending nonexistent money; the *configured monthly ceiling* is not race-safe.) Also `sumMonthlySpend` uses UTC `date_trunc` while daily/scheduler use Europe/Moscow boundaries — month-boundary disagreement.
*Locations:* `apps/agent-worker/src/db.ts:514-574,188,203,307`; `agent-runner.ts:489-495,632`.

**H4. Gateway routing can SELECT a provider it cannot DISPATCH → 503 after a valid pick; and there is NO failover across candidates.**
`getUpstream()` only handles `openrouter|kie|ollama|groq|gonka`; routing/seed reference `together`/`yandex` (which exist only in the unused `packages/upstream-adapters`). A picked `together`/`yandex` upstream throws 503. Separately, `pickUpstream()` is called once and never retried with the failed candidate removed — a transient 502/529 fails the whole request even though multiple candidates exist.
*Locations:* `packages/api-gateway/src/upstreams/registry.ts:40-59`; `routes/v1/chat.ts:63-96`; `routing/engine.ts:92-118`.

**H5. White-label brand leak in the STREAMING path.**
The non-stream OpenRouter adapter strips `provider`/`system_fingerprint`/`native_finish_reason`, but the SSE proxy forwards each chunk verbatim — `stream:true` clients see the real provider and upstream model id. Also `X-AIAG-Upstream` echoes the concrete provider name on responses and is not in the documented edge strip list; and the non-stream `model` field is never rewritten to the AIAG slug.
*Locations:* `packages/api-gateway/src/streaming/sse.ts:56-72`; `routes/v1/chat.ts:185,198`; `upstreams/openrouter.ts:84-104`.

**H6. Gateway daily USD cap is TOCTOU and denominated in COST not CHARGE.**
Rate-limit middleware does a read-only `used >= cap` check; the `INCRBYFLOAT` happens later in settle, so concurrent requests all pass before any increment. The increment uses raw `upstreamUsd` (no markup), so an org can drive marked-up spend of `cap × markup` before tripping. Streaming path never increments the cap at all. Same non-atomic pattern for the per-session budget.
*Locations:* `packages/api-gateway/src/middleware/rate-limit-plan04.ts:66-76`; `routes/v1/chat.ts:140-163`; `routing/policies.ts:8-34`.

**H7. Gateway FX fallback silently bills at hardcoded 92 ₽/USD during a CBR outage.**
`rate = await fetchUsdRubRate().catch(() => 92)` at the route level masks even the Redis `last_known` fallback in `cbr.ts`. Every charge mispriced during an outage. Streaming output tokens are also estimated from `delta.length/4` when usage is absent → over/under-billing, divergent from the non-stream path.
*Locations:* `packages/api-gateway/src/routes/v1/chat.ts:115,120`; `streaming/sse.ts:62-70,94-108`.

**H8. WEB: deployed nginx vhost does NOT strip `x-middleware-subrequest` / `x-tma-user-id` (CVE-2025-29927 edge defense missing).**
The strip directives exist only in the reference snippet `infra/nginx/tg-miniapp.conf`; the live `ops/nginx/aiag-tma.conf` `/tg` block lacks them. Handlers read `x-tma-user-id` directly. If middleware is ever bypassed (the CVE), a client-supplied user id reaches handlers.
*Location:* `ops/nginx/aiag-tma.conf:51-61` vs `infra/nginx/tg-miniapp.conf:45,50`.

**H9. Gateway wires the WEAKER `authMiddleware` (query-param `api_key`, no format check) instead of hardened `auth-plan04/requireApiKey`.**
`createGateway` mounts `middleware/auth.ts`, which accepts `?api_key=` (leaks into nginx logs / Referer / history), does no `sk_aiag_live_*` format gate, and returns verbose key-status in error bodies. The hardened `requireApiKey` (Redis-cached, prefix-regex, header-only) is not mounted.
*Locations:* `packages/api-gateway/src/index.ts:74-79`; `middleware/auth.ts:12-32,66-77`.

**H10. Two divergent gateway implementations coexist; the legacy `createGateway` (package `main`) has no real billing, CORS `*`+credentials, and unauthenticated `/metrics`.**
Risk of an integrator wiring the legacy proxy onto the money path.
*Location:* `packages/api-gateway/src/index.ts:40-287` (esp. 45-60, 118-123, 150-189).

**H11. TMA: TON top-up reconciliation is client-poll-only with no server backstop, and scans only the last 20 txs.**
If the tab closes (or poll times out at 10 min) before confirm, the topup stays `pending` forever and the paying user is never credited. Under burst, a valid payment scrolls past the 20-tx window. No `expired` transition is ever written. Rate is locked at init from CoinGecko with no expiry/voiding of stale quotes.
*Locations:* `apps/tg-miniapp/app/api/tma/topup/check/[id]/route.ts:74-131,117-127`; `topup/init/route.ts:63-101`; `src/lib/ton-rate.ts:20-32`.

**H12. WEB: legacy Tinkoff refund webhook updates `refunded_*` but never reverses balance / writes a refund ledger row → refunded users keep credited funds.**
*Location:* `apps/web/src/app/api/webhooks/tinkoff/route.ts:154-177`.

**H13. WEB: admin step-up session is enforced ONLY by the `/admin/*` page layout, NOT by `/api/admin/*` routes.**
`withAdmin/requireAdmin` check only NextAuth `role==='admin'`, not the step-up cookie. Destructive admin APIs are callable with a normal admin session, bypassing the password step-up the UI implies.
*Location:* `apps/web/src/lib/admin/guard.ts:12-20` vs `apps/web/src/app/admin/layout.tsx:30-33`.

**H14. WEB: abuse/CSAM reports are not persisted — compliance gap.**
`/api/report` only `console.log/error` (CSAM marked URGENT but still stderr). `moderation_reports` INSERT is a TODO. No durable, queryable record; no real alert sink.
*Location:* `apps/web/src/app/api/report/route.ts:50-58`.

**H15. Tinkoff webhook signature uses non-constant-time comparison + no replay/idempotency at SDK boundary.**
`calculatedToken.toLowerCase() === receivedToken.toLowerCase()` is a timing side channel; `parseWebhook` gives no event-id/dedupe hook, and the consumer credits balance + inserts a deposit row non-atomically without checking prior `confirmed` status → a replayed CONFIRMED webhook double-credits.
*Locations:* `packages/tinkoff/src/utils.ts:36-37`; `client.ts:251-273`; consumer `apps/web/src/app/api/webhooks/tinkoff/route.ts:88-152`.

**H16. YooKassa: webhook IP whitelist off-by-default + spoofable; refund events bypass server verification.**
`YOOKASSA_ENFORCE_IP` defaults off and the IP derives from attacker-controllable `X-Forwarded-For`. `verifyAndFetch` returns client-supplied `event.object` verbatim for any `refund.*` event (no re-fetch) — a forged `refund.succeeded` is trusted.
*Locations:* `apps/web/src/app/api/subscriptions/webhook/[provider]/route.ts:72-79`; `packages/yookassa/src/client.ts:196-209`.

**H17. Worker: contest prize blob trusted blindly → arbitrary RUB payout rows.**
`closeContestsCron` casts `contests.prizes` jsonb `(p.amount)::numeric` into `prize_awards.amount_rub` with no non-negative/cap/budget validation. A bad blob mints arbitrary payable rows.
*Location:* `apps/worker/src/queues/close-contests-cron.ts:94-115`.

**H18. Worker: SSRF in webhook-retry + eval-runner; eval-runner can RCE on non-Linux.**
Webhook fetcher POSTs to arbitrary job `url` (no allowlist); eval-runner `fetch`es arbitrary submission `file.url` **before** sandboxing (full network). On `platform !== linux` it runs `python3 evaluator.py` with **no sandbox**.
*Locations:* `apps/worker/src/queues/webhook-retry.ts:35-62`; `apps/worker/src/eval-runner/runner.ts:60-64,71-105`.

**H19. Shared: `authorShareRub()` rounding is mathematically wrong; revshare tier threshold is gross/net-ambiguous.**
`Math.round(marginRub * tierPct) / 100` rounds `margin*percent` before dividing by 100, not `margin*pct/100`. No rounding-direction policy, accumulated drift unaudited. Separately, the volume-tier threshold input mixes "gross" vs "author total" with no type-level unit.
*Locations:* `packages/shared/src/revshare.ts:90-92,42-68`.

**H20. NDFL withholding has no atomicity/idempotency on `cumulativeYtdRub` → concurrent payouts under-withhold tax.**
Two payouts with a stale YtD can both land in the 13% band; platform is the tax agent and liable.
*Location:* `packages/shared/src/tax.ts:41-61`.

**H21. Database: TMA money tables + org credit columns are invisible to the Drizzle schema (dual source of truth).**
`tg_user_balances`, `tg_topups`, `agents`, `agent_runs`, `tg_ledger_entries`, `template_rentals`, `rent_charges` exist only as raw SQL; `organizations.subscription_credits/payg_credits/...` exist only in `0004` and are absent from `src/schema/organizations.ts` (which `aiag_settle_charge` reads). `db:generate` would try to DROP them. No FKs on the entire TG money graph (`tg_user_id` is a bare BIGINT everywhere).
*Locations:* `packages/database/src/schema/organizations.ts` vs `migrations/0004_gateway_core.sql:30-33`; `migrations/0018,0019,0029,0032`.

**H22. Database: Drizzle journal vs raw migrations are two conflicting tracking systems; prod has no applied-migrations table.**
`drizzle/meta/_journal.json` has 1 entry; `migrations/` has 0004–0038 hand-run SQL. `drizzle-kit push` would clobber prod. `aiag_settle_charge` is not built/imported and is hand-applied — the gateway could call a stale function.
*Locations:* `packages/database/drizzle/meta/_journal.json`; `migrations/`; `src/functions/settle-charge.sql`.

**H23. Upstream-adapters: USD→RUB rate frozen at construction; CircuitBreaker implemented but never wired; float money rounding.**
`this.usd_rate = process.env.USD_RUB_RATE ?? 95` captured once → bills all requests at boot-time FX. `CircuitBreaker` is orphaned (only `withRetry` runs) → failing providers retried forever, never tripped. Money rounded via `Math.round(usd*rate*100)/100`.
*Locations:* `packages/upstream-adapters/src/base/UpstreamAdapterBase.ts:58,144,119-120`; `base/circuit-breaker.ts`.

**H24. Telegram-alerts: no fetch timeout → a hung Telegram connection holds the Next.js webhook handler open indefinitely.**
Called via `Promise.all` over all firing alerts; one stall blocks the request.
*Location:* `packages/telegram-alerts/src/bot.ts:35`.

**H25. Testing: inbound payment webhook routes, all of `apps/tg-miniapp`, and the template→registry consistency have ZERO tests; settleRun atomicity tests `skipIf` silently skip in CI.**
The single highest-value money mutation (webhook → credit) is untested; the crypto→USD top-up conversion entry point is untested; `run-settle.integration.test.ts` skips entirely when `TEST_DATABASE_URL` is unset (skip = green).
*Locations:* `apps/web/src/app/api/webhooks/tinkoff/route.ts` (no test); `apps/tg-miniapp/src` (no `*.test.*`); `apps/agent-worker/src/__tests__/run-settle.integration.test.ts:25,60`.

**H26. Observability: gateway `/readiness` returns hardcoded `db:ok, redis:ok`; no structured logging / error tracking / tracing anywhere.**
A node with a dead DB still reports ready → LB routes billable traffic to a broken instance. Only `console.*` + fire-and-forget usage logging; gateway `onError` has no request-ID correlation, no Sentry.
*Locations:* `packages/api-gateway/src/index.ts:100-106,260`; `middleware/logging.ts:63`.

### MEDIUM (summarized)

- **JWT live-revocation is a permanent no-op** — `isRevoked` is a stub and is never called by TMA middleware; a leaked 24h JWT cannot be killed. (`apps/tg-miniapp/middleware.ts:39-55`; `src/lib/jwt-denylist.ts:64-93`)
- **initData replay defense fails OPEN** on Redis outage (`auth/verify/route.ts:34-54`).
- **Wallet linking trusts client address** — `ton-proof.ts` unused, `is_verified` hardcoded false (`wallet/link/route.ts:14-39`).
- **NFT webhook unauthenticated/unsigned** — defense is only an unguessable UUID + a separate nginx allowlist (`nft/webhook/route.ts:22-101`).
- **Agent run route does NO credit pre-auth** — zero/negative-balance user can trigger billable calls; deduction deferred to worker (`agents/[id]/run/route.ts:36-78`).
- **Per-handler postgres pools in tg-miniapp** — dozens of route files each open a pool → connection exhaustion risk.
- **`aiag_mode` cast `as Mode` with no validation** — unknown mode silently treated as `balanced` (`routes/v1/chat.ts:62`; `engine.ts:107-117`).
- **Resolver caches model→candidate (incl. price/markup) for 600s with no invalidation** → stale routing/pricing after config change (`routing/resolver.ts:10`).
- **Two competing adapter packages** — gateway `upstreams/*` vs unused `packages/upstream-adapters` (maintenance trap, two white-label scrubs) (routing finding).
- **Upstream adapter errors thrown as plain `Error`** → generic 500 masks real upstream 429/5xx (`upstreams/openrouter.ts:33,63,139,190`).
- **`settleCharge` succeeds but `logRequest` is fire-and-forget + swallows errors** → charged request with no durable usage/audit row (`routes/v1/chat.ts:165`; `logging/stream.ts:23-51`).
- **`safeFetch` IP-pinning only works on Node (undici); degrades on Bun — and the gateway runs on Bun** → TOCTOU DNS-rebind window in the runtime that routes to admin-controlled URLs (`packages/shared/src/safe-fetch.ts:27-31,241-266`).
- **`safeFetch` re-sends Authorization/body across cross-host redirects** (`safe-fetch.ts:285-321`).
- **Kie adapter returns `credits=0` for hidden-priced models** → exclusive media served free (`upstream-adapters/src/adapters/kie.ts:197-211`).
- **Replicate passthrough markup=1.0** — all commission deferred to an out-of-band worker that may not exist (`adapters/replicate.ts:104,303-340`).
- **`uploadToS3` defaults ACL `public-read`** (`packages/shared/src/s3.ts:28-49`).
- **`tg_user_balances` 0029 rename guard covers only balances+runs, not `tg_topups`/`agents`** → 100× ₽↔cent reinterpretation risk if applied with rows present (`migrations/0029_usd_ledger.sql:19-97`).
- **YooKassa/Tinkoff money handled as floats**; `users.balance` is `text` (`yookassa/src/utils.ts:6-15`; `database/src/schema/users.ts:53`).
- **Tool-fee `cost_rub` mislabel** in agent-worker — value is integer credits, not rubles (`apps/agent-worker/src/tools.ts:284-301`).
- **agent-worker observability is `console.*` only**; no metrics/tracing on the live money path.
- **Worker Redis no TLS/auth**; queue payloads (webhook bodies, emails) unencrypted.
- **Money-path receipt/renewal emails are dead/unwired** (`packages/email`); the worker email queue uses a stub transport (54-ФЗ receipt gap).
- **`/api/playground/run` guest rate-limit is in-process Map** — bypassable at scale; refunds AIAG-borne gateway cost (`playground/run/route.ts:8-33`).

### LOW (selected)

- `apps/web` next pinned via caret `^14.2.34` (drift below CVE floor possible); tg-miniapp pinned exact.
- Payment provider credentials fall back to `placeholder_*` instead of failing fast (`apps/web/src/lib/payments/providers.ts:130-143`).
- Global coverage threshold 50%, not tiered for money/auth code (`vitest.config.ts:24-31`).
- e2e is smoke-only (no money/auth journeys).
- `deepClone` via `JSON.parse(JSON.stringify)` drops Date/BigInt (`packages/shared/src/index.ts:209`).
- Telegram bot token in URL path (log-leak risk); missing-config path returns `ok:true`.

---

## 4. Per-Dimension Assessment

| Dimension | Rating | Headline |
|-----------|--------|----------|
| **Billing / Money-Path Integrity** | **medium → weak in practice** | WEB inflow is non-crediting & unreconcilable (C1/C2); TMA streamed runs bill margin-free (C4); refund reversals missing (H12); FX/markup denomination bugs (H6/H7); float money throughout. |
| **Auth & Security** | **medium** | CVE edge strip missing on live nginx (H8); weaker gateway auth wired (H9); admin step-up & refund guard bypass (C3/H13); JWT revocation a no-op; SSRF guard degrades on Bun (the gateway's own runtime). |
| **Provider Routing & Gateway** | **weak** | Routing can pick an undispatchable provider (H4); no failover; two divergent gateway impls (H10) and two adapter packages; white-label leaks in streaming (H5); unknown-model returns 400 not 404. |
| **Observability & Testing** | **medium** | `/metrics` never incremented (C7); `/readiness` faked (H26); no structured logging/tracing; the money-mutation webhook + tg-miniapp + template-registry consistency untested; settle tests skip in CI (H25). |
| **Data Model & Migrations** | **weak** | TMA money tables + org credit columns absent from Drizzle (H21); two conflicting migration trackers, no prod ledger (H22); no FKs on the TG money graph; `settle-charge.sql` hand-applied & unversioned; ₽↔cent rename guard incomplete. |
| **Compliance** | **weak** | CSAM/abuse reports not persisted (H14); 54-ФЗ fiscal receipts unwired (email + Tinkoff/YooKassa receipt mapping); upstream error bodies (possible PII/keys) kept in `AdapterError.raw`. |

---

## 5. Prioritized Recommendations

Founder directive: **fix the money path first.** Ordered by business impact, fastest-to-stop-bleeding first.

### P0 — Stop active money loss / leakage (this week)
1. **Wire WEB settlement correctly (C1+C2).** Insert a `payments`/`subscriptions` pending row (crypto-random idempotency key) **before** redirect; point `notificationUrl` at the handler that actually settles, and implement settlement in the canonical webhook: idempotent credit + `balance_transactions` insert keyed on `order_id`/`payment_id` inside one transaction. Then delete the divergent handler so only one exists.
2. **Lock down the admin refund endpoint (C3).** Replace the `if (role && ...)` guard with `requireAdmin`/`withAdmin`, persist the refund, and write an `audit_log` row. Treat undefined role as denied.
3. **Fix streamed gateway billing headers (C4).** Emit all billing/`X-AIAG-Partial` headers **before** the first `writeSSE` (provisional charge up front, or a trailer the worker reads). Add an integration test asserting the worker receives `x-aiag-charged-usd-micro` (i.e. `billedByGateway===true`) on a streamed completion.
4. **Make the OpenRouter fallback + missing gateway key LOUD (H2).** In prod, fail hard (or gate behind an explicit `ALLOW_DIRECT_OPENROUTER` defaulting off) when `AIAG_GATEWAY_KEY` is unset; emit `fallback_runs_total` / `margin_free_credits_total`. Align gateway `PORT` default to 4000 (or make the worker's gateway URL env-configurable) and add a worker→gateway startup healthcheck.
5. **Eliminate the hermes default-model trap (H1).** Change `agent-templates.ts:69` to a registered slug, delete the stale PRICING row, and add a CI assertion that every `defaultModelSlug` and worker PRICING key resolves in the gateway `models` registry.

### P1 — Close billing-correctness & refund holes (next 1–2 weeks)
6. **Refund reversal (H12) + Tinkoff replay idempotency (H15)** — reverse balance + write a `refund` ledger row; make the webhook idempotent (dedupe on payment id + status guard); switch token comparison to `crypto.timingSafeEqual`.
7. **YooKassa: verify refund events server-side + enforce IP/signature (H16).** Re-fetch on `refund.*`; default `YOOKASSA_ENFORCE_IP` on; stop trusting raw `X-Forwarded-For`.
8. **Gateway cap denomination + TOCTOU (H6) and FX fallback (H7).** Increment the daily cap by the **charged** amount (and in the streaming path); make FX failures hard (use the Redis `last_known` instead of a literal 92); pick one streaming-usage source of truth.
9. **Monthly budget atomic guard (H3).** Move monthly enforcement into the `settleRun` transaction as a guarded conditional, mirroring the daily guard; align daily/monthly timezones.
10. **Wire `/metrics` + real `/readiness` (C7/H26)** and add the missing worker sinks (C5) and webhook-retry drop guard (C6) — these are billing-correctness as much as observability.

### P2 — Routing, white-label, schema integrity (this month)
11. **Consolidate to one gateway impl + one adapter package (H10/H4).** Retire `createGateway`/legacy proxy; make dispatch data-driven from the same provider set as routing; validate candidate providers before `pickUpstream`; add a startup assertion that `upstreams.provider ⊆ dispatch registry`. Add a failover loop (retry next candidate on 502/503/529; settle only the success).
12. **Mount hardened `requireApiKey`, drop `?api_key=` (H9); generic error bodies.**
13. **Plug white-label leaks (H5).** Centralized chunk scrubber shared by stream + non-stream; rewrite `model` to the AIAG slug; strip/remove `X-AIAG-Upstream` from client responses.
14. **Bring money tables under one source of truth + FKs (H21) and add a prod applied-migrations ledger (H22).** Add FKs on the TG money graph (`ON DELETE RESTRICT`); generate typed rows for `db.ts`; version/deploy `settle-charge.sql` with a checksum check.

### P3 — Auth, compliance, testing hardening
15. **CVE edge strip on live nginx (H8)** — merge the header-strip directives into `ops/nginx/aiag-tma.conf`, consolidate to one vhost, add a deploy assertion.
16. **Wire JWT `isRevoked` + add logout/ban kill switch; shorten 24h TTL.**
17. **Persist CSAM/abuse reports + real alert sink (H14); wire 54-ФЗ receipt emails and Tinkoff/YooKassa per-item receipt mapping.**
18. **Fix `authorShareRub` rounding to integer minor-units (H19); add atomicity to NDFL YtD (H20).**
19. **Testing floor:** provision `TEST_DATABASE_URL` in CI and fail if the settle suite skips; add route tests for both webhook handlers (credit-once, bad-sig rejected, duplicate idempotent); add tg-miniapp top-up conversion + auth tests; tiered coverage thresholds (85%+) for money/auth packages.

---

*All paths are relative to `C:\Users\боб\projects\aggregator`. Severity reflects realized money/auth/compliance impact, not code volume.*
