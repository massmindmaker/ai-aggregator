# Codebase Concerns — TMA / Agent-Worker / Billing Path

**Analysis Date:** 2026-06-02
**Scope:** `apps/tg-miniapp/`, `apps/agent-worker/`, `packages/database/migrations/`
**Method:** adversarial code review with file:line evidence

---

## Severity Rankings (top-level summary)

| # | Concern | Severity |
|---|---------|----------|
| 1 | Billing disconnect: agent runs do NOT deduct `tg_user_balances` | Critical |
| 2 | Hardcoded JWT fallback `dev-only-change-in-prod` | Critical |
| 3 | HMAC comparison not timing-safe → hash oracle | High |
| 4 | NFT webhook has no server signature verification | High |
| 5 | connection_type constraint mismatch (RESOLVED in 0022) | High (was) → Confirmed fixed |
| 6 | Daily-budget read → mid-run check → write is non-atomic (TOCTOU race) | High |
| 7 | TON Connect proof verification is a no-op stub | High |
| 8 | SSRF guard incomplete: IPv6 ULA/::ffff bypass, DNS rebind, no egress guard in worker | High |
| 9 | USD_TO_RUB hardcoded at 90; currency unit mismatch between balance and cost | High |
| 10 | P0 billing-bypass claim (aiag via OpenRouter direct) — CONFIRMED by design | Medium |
| 11 | Migration 0026 provider_id/auth_ref not reflected in agent-worker code | Medium |
| 12 | Queue enqueue failure is silently swallowed → run stuck `pending` forever | Medium |
| 13 | Agent DELETE is hard-delete, not soft-delete; breaks FK cascade on active runs | Medium |
| 14 | TON topup reconciliation: last-20-tx window misses delayed TXs | Medium |
| 15 | No rate limiting on any /api/tma/* route | Medium |
| 16 | No observability (no tracing, no structured logging, no error tracking) | Medium |
| 17 | 152-FZ / compliance: no consent flow, no data-deletion endpoint, no OFD receipts | Medium |
| 18 | Agent abuse / prompt injection — no input sanitization, no per-run cost cap | Medium |
| 19 | image_gen graceful fallback silently returns placehold.co URL as a real image | Low |
| 20 | Polling every 1500ms from client — no WebSocket/SSE, O(N) DB queries per tick | Low |

---

## Tech Debt

**P0 billing-bypass — confirmed by design, not a bug but a gap:**
- The original report alleged that `kind='aiag'` runs hit OpenRouter directly "instead of the gateway." This is CONFIRMED but the picture is more nuanced.
  - `apps/agent-worker/src/agent-runner.ts:48-51` — `resolveUpstream()` for `connection_type='aiag'` builds `url = OPENROUTER_URL` (`https://openrouter.ai/api/v1/chat/completions`) directly, using `process.env.OPENROUTER_API_KEY`. The Hono gateway at `127.0.0.1:4000` is **never called**.
  - Impact on AIAG markup: markup the web gateway normally adds is completely absent for agent runs. AIAG pays OpenRouter's price with no margin on agent traffic.
  - Impact on credits: `tg_user_balances.balance_rub` is **never decremented** anywhere in `apps/agent-worker/`. Only `agents.spent_today_rub` and `agent_runs.cost_rub` are updated. The user's prepaid RUB balance is untouched regardless of actual AI spend. This means a user can top up 0 RUB and run agents indefinitely as long as they stay under the monthly/daily RUB budget (which is enforced against a _counter_, not against the actual _balance_).
  - Files: `apps/agent-worker/src/agent-runner.ts:21,48-51,254-255`, `apps/agent-worker/src/db.ts:107-115`
  - Remediation: after `markCompleted`, call `UPDATE tg_user_balances SET balance_rub = balance_rub - ${totalCostRub} WHERE tg_user_id = ...` inside the same transaction; gate run start on `balance_rub >= MIN_RUN_COST`.

**migration 0026 provider_id/auth_ref not wired in agent-worker:**
- Migration `0026_provider_catalog.sql` added `providers` table + `agent_provider_credentials` + four new nullable columns on `agents` (`provider_id`, `model_id`, `auth_ref`, `base_url_override`). The migration comment explicitly states "the worker uses `provider_id IS NOT NULL` as the new path discriminator."
- `apps/agent-worker/src/db.ts` `AgentRow` interface contains none of these fields; `loadAgent()` SELECT does not read them. `resolveUpstream()` only branches on `connection_type`, never on `provider_id`.
- Files: `packages/database/migrations/0026_provider_catalog.sql:84-98`, `apps/agent-worker/src/db.ts:11-27`, `apps/agent-worker/src/agent-runner.ts:33-52`
- Impact: the new provider-picker flow (P0 MVP) will not function. Agents created via the new catalog path will fall through to aiag/OpenRouter with wrong keys.
- Remediation: extend `AgentRow`, update `loadAgent()` SELECT, add branch in `resolveUpstream()` for `provider_id IS NOT NULL` → fetch from `agent_provider_credentials` and decrypt.

**Agent DELETE is hard-delete:**
- `apps/tg-miniapp/app/api/tma/agents/[id]/route.ts:139-145` issues `DELETE FROM agents WHERE id = ...`. On-delete cascades in `0018_agents.sql:21` cascade to `agent_runs`. This destroys run history (billing evidence) and cascades to `agent_memory`.
- The GET/LIST routes already defend `status != 'deleted'` (`apps/tg-miniapp/app/api/tma/agents/route.ts:37`, `apps/tg-miniapp/app/api/tma/agents/[id]/route.ts:45`), indicating soft-delete was intended but not wired to the DELETE handler.
- Remediation: change DELETE handler to `UPDATE agents SET status = 'deleted' WHERE ...`.

---

## Known Bugs

**connection_type CHECK constraint mismatch — RESOLVED in migration 0022:**
- Migration `0021_agents_external_connection.sql:13-14` defined `CHECK (connection_type IN ('aiag','external'))`, but `apps/tg-miniapp/app/api/tma/agents/route.ts:87` and `apps/agent-worker/src/agent-runner.ts:34` both write/expect `'external_openai'`.
- Migration `0022_agents_connection_type_fix.sql` explicitly fixes this: drops the old constraint and re-adds `CHECK (connection_type IN ('aiag', 'external_openai'))`.
- Status: **fixed at DB level** assuming 0022 has been applied (it is the current latest before 0023). The code values `'aiag'` and `'external_openai'` are now valid.
- Residual risk: if any environment is stuck on 0021 without 0022, every external-agent INSERT fails. Verify with `SELECT constraint_name FROM pg_constraint WHERE conname LIKE 'agents_connection_type%';`.

**Queue enqueue failure swallowed silently:**
- `apps/tg-miniapp/app/api/tma/agents/[id]/run/route.ts:60-76` — the BullMQ enqueue block is wrapped in `try/catch` that only `console.error`s on failure. The route returns HTTP 202 with `status:'pending'` regardless of whether the job was actually enqueued.
- If Redis is unreachable (common during restarts), runs are inserted as `pending` but never picked up by the worker. They stay `pending` forever with no user-visible error or timeout.
- Files: `apps/tg-miniapp/app/api/tma/agents/[id]/run/route.ts:60-76`
- Remediation: return HTTP 503 on enqueue failure; add a `failed_to_enqueue` fallback status, or return 500 so the UI retries.

---

## Security Considerations

**Hardcoded JWT fallback secret:**
- `apps/tg-miniapp/app/api/tma/auth/verify/route.ts:9-11` and `apps/tg-miniapp/middleware.ts:4-6`:
  ```ts
  process.env.TMA_JWT_SECRET ?? 'dev-only-change-in-prod'
  ```
- If `TMA_JWT_SECRET` is missing from the prod environment, all JWT operations use a public, known string. Any user who knows this fallback can forge a JWT for any Telegram user ID.
- Risk: complete auth bypass on misconfigured deploys.
- Remediation: throw `Error('TMA_JWT_SECRET is required')` at startup; add startup env-check assertions.

**HMAC comparison is not timing-safe (hash oracle):**
- `apps/tg-miniapp/src/lib/verify-init-data.ts:34`:
  ```ts
  if (computedHash !== hash) return { ok: false, reason: 'hash_mismatch' };
  ```
- JavaScript `!==` string comparison is not constant-time. Timing oracle can in principle leak individual hex bytes via response-time measurement.
- Files: `apps/tg-miniapp/src/lib/verify-init-data.ts:34`
- Remediation: `crypto.timingSafeEqual(Buffer.from(computedHash), Buffer.from(hash))`.

**NFT webhook has no server-side signature — relies on nginx IP allowlist (not enforced in code):**
- `apps/tg-miniapp/app/api/tma/nft/webhook/route.ts:25-29` comment: "Startonus does NOT sign webhooks. Protection via UUID + nginx IP-allowlist (deploy task)."
- The IP allowlist is a deployment-side task with no code enforcement. If nginx is misconfigured or bypassed, any attacker who guesses/extracts a `purchase_id` UUID can send a `minted` event and cause the DB to increment `minted_count` without a real TON payment. There is no second-factor check (e.g. TON txHash verification against on-chain data).
- Files: `apps/tg-miniapp/app/api/tma/nft/webhook/route.ts:29-104`
- Risk: Fake NFT mint; inventory counter corruption.
- Remediation: Verify Startonus callback signatures if Startonus adds them, or independently verify `txHash` against TonCenter before finalizing.

**TON Connect wallet proof verification is a no-op:**
- `apps/tg-miniapp/src/lib/ton-proof.ts:27-32`: `verifyTonProof()` always returns `false` (hardcoded stub). `apps/tg-miniapp/app/api/tma/wallet/link/route.ts:14` comments: "MVP: trusts client-provided address (no strict ton-proof verify yet)."
- A malicious user can link any arbitrary TON address (e.g. a whale's address) to their account. While top-up reconciliation is done via comment tag (not address ownership), linking a false address could enable social engineering or future trust-escalation exploits if address ownership is used for gating.
- Files: `apps/tg-miniapp/src/lib/ton-proof.ts:27-32`, `apps/tg-miniapp/app/api/tma/wallet/link/route.ts:14`
- Remediation: Implement Ed25519 proof verification using `@ton/crypto.signVerify` before marking `is_verified = true`.

**SSRF guard incomplete — DNS rebind, IPv6 ULA, `::ffff:` mapped addresses:**
- `apps/tg-miniapp/src/lib/external-agent.ts:27-57` guards only specific patterns. Gaps:
  1. IPv6 ULA range (`fc00::/7`, `fd00::/8`) is not blocked. Only `::1` is checked.
  2. IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is not checked.
  3. DNS rebind: URL is validated at request time, but the fetch in `probeExternalEndpoint()` and later `callModel()` in the worker resolves DNS again — a DNS rebind between validation and execution can route to a private IP.
  4. The worker-side `callModel()` (`apps/agent-worker/src/agent-runner.ts:117`) has **no SSRF guard at all**; it fetches whatever `external_base_url` is in the DB. Guard is only applied at agent-creation time.
- Files: `apps/tg-miniapp/src/lib/external-agent.ts:20-58`, `apps/agent-worker/src/agent-runner.ts:117`
- Remediation: Add IPv6 ULA/mapped checks; add worker-side URL re-validation before each `fetch`; consider egress firewall rules.

**initData replay window is 24 hours:**
- `apps/tg-miniapp/src/lib/verify-init-data.ts:38-39`: `ageSec > 86400` (24h) is the expiry. Telegram's own docs recommend 1 hour max. A leaked initData is valid for a full day.
- Files: `apps/tg-miniapp/src/lib/verify-init-data.ts:38-39`
- Remediation: reduce to 3600 (1h); Telegram JWTs issued are 24h which already covers the session.

---

## Performance Bottlenecks

**Client-driven polling at 1500ms — N×DB queries while run is active:**
- `apps/tg-miniapp/app/agents/[id]/page.tsx:142`: `setInterval(load, 1500)` fires every 1.5s while any run is `pending` or `running`. Each poll hits `GET /api/tma/agents/{id}` which executes two SQL queries (agent + 20 runs).
- With concurrency=4 in the worker and multiple users polling, this is O(active_users × 2) DB queries/1.5s. Under load (e.g. 100 concurrent users) = ~130 queries/sec from polling alone.
- Files: `apps/tg-miniapp/app/agents/[id]/page.tsx:139-144`, `apps/tg-miniapp/app/api/tma/agents/[id]/route.ts:61-69`
- Remediation: Replace polling with SSE or Telegram Bot push notification (already implemented via `bot-api.ts`) + single "done" refresh.

**TON topup check scans only last 20 transactions:**
- `apps/tg-miniapp/app/api/tma/topup/check/[id]/route.ts:76-77`: `limit=20, sort=desc`. If a user's payment is delayed >20 transactions on a busy wallet, the topup will never confirm and will require manual intervention.
- Files: `apps/tg-miniapp/app/api/tma/topup/check/[id]/route.ts:76-77`
- Remediation: Query by `tx_hash` once hash is known, or increase limit and add a server-side cron reconciler.

**New postgres connection pool per request:**
- Every route file instantiates `postgres(...)` at module load: `apps/tg-miniapp/app/api/tma/agents/route.ts:10`, `apps/tg-miniapp/app/api/tma/agents/[id]/route.ts:7`, `apps/tg-miniapp/app/api/tma/topup/init/route.ts:9`, etc. Next.js serverless restarts cold-start these pools. No shared singleton.
- Remediation: Export a single `sql` instance from a shared db module (e.g. `src/lib/db.ts`) and import it across routes.

---

## Fragile Areas

**Daily budget race condition (TOCTOU):**
- `apps/agent-worker/src/agent-runner.ts:179-184`: `getOrResetDailyBucket()` reads the current `spent_today_rub` in one query. Then mid-run checks compare `daily.spent_today_rub + totalCostRub > daily.daily_budget_rub` (lines 238-240) against the snapshot taken at run start. With `concurrency: 4` in the worker (`apps/agent-worker/src/index.ts:22`), 4 runs for the same agent can begin simultaneously, each reading the same initial `spent_today_rub = 0`, and each proceed up to the full daily budget — potentially spending 4× the limit.
- `getOrResetDailyBucket()` uses `UPDATE … RETURNING` (atomic reset), but the subsequent mid-run spend check is against the stale snapshot, not a re-read.
- Files: `apps/agent-worker/src/agent-runner.ts:179,233-241`, `apps/agent-worker/src/db.ts:85-105`, `apps/agent-worker/src/index.ts:22`
- Remediation: Use `SELECT … FOR UPDATE SKIP LOCKED` on the agent row at run start, or use `UPDATE agents SET spent_today_rub = spent_today_rub + delta WHERE spent_today_rub + delta <= daily_budget_rub RETURNING id` atomically.

**`markCompleted` and `incrementDailySpend` are two separate non-atomic queries:**
- `apps/agent-worker/src/agent-runner.ts:254-255`: `markCompleted()` then `incrementDailySpend()` are sequential awaits. If the process crashes between them, the run is recorded as completed with cost_rub but the daily counter is NOT incremented. Next run starts with stale (too-low) spend figure.
- Files: `apps/agent-worker/src/agent-runner.ts:254-255`, `apps/agent-worker/src/db.ts:188-215`
- Remediation: Wrap both in `sql.begin()` transaction, or merge into a single UPDATE+UPDATE CTE.

**Soft-delete inconsistency: GET uses `status != 'deleted'` but DELETE handler uses hard DELETE:**
- As noted above: `apps/tg-miniapp/app/api/tma/agents/[id]/route.ts:139-145` hard-deletes; the rest of the routes filter `status != 'deleted'`. This means the DB constraint/cascade behavior is inconsistent with the intended soft-delete model.
- Files: `apps/tg-miniapp/app/api/tma/agents/[id]/route.ts:139-145`

---

## Scaling Limits

**BullMQ queue not bounded — no max queue depth:**
- `apps/tg-miniapp/app/api/tma/agents/[id]/run/route.ts:70`: `queue.add('run', { runId }, { removeOnComplete: 100, removeOnFail: 100 })` has no `jobsInQueue` check. A malicious user (or bug loop) can fill Redis with unlimited jobs.
- Files: `apps/tg-miniapp/app/api/tma/agents/[id]/run/route.ts:70`
- Remediation: Add per-user rate limit and global queue depth check before enqueue.

**No per-user concurrent run limit:**
- Nothing prevents the same user from submitting 100 runs in rapid succession. All enqueue successfully and consume worker capacity.
- Remediation: Gate `INSERT INTO agent_runs` on count of `status IN ('pending','running')` for that user.

---

## Dependencies at Risk

**USD_TO_RUB hardcoded at 90:**
- `apps/agent-worker/src/agent-runner.ts:24`: `const USD_TO_RUB = 90;`
- As of 2026-06, USD/RUB ≈ 80–95 depending on market conditions. A 10% rate deviation means AIAG under- or over-charges users and misallocates cost. No integration with the live rate service used elsewhere (`apps/tg-miniapp/src/lib/ton-rate.ts` uses CoinGecko for TON/RUB).
- Files: `apps/agent-worker/src/agent-runner.ts:24,133`
- Remediation: Fetch USD/RUB from CoinGecko or CBR at worker startup with periodic refresh (same pattern as `getTonRubRate()`).

**CoinGecko for TON rate — single point of failure, free tier:**
- `apps/tg-miniapp/src/lib/ton-rate.ts:8-20`: Uses `api.coingecko.com` free endpoint with 60s TTL. CoinGecko free tier has aggressive rate limits. Stale-on-error fallback (`return cache.rub`) is correct but if the server restarts with no cache and CoinGecko is down, topup init fails with HTTP 502.
- Files: `apps/tg-miniapp/src/lib/ton-rate.ts:8-20`
- Remediation: Add a secondary rate source (e.g. CoinMarketCap, hard-coded floor).

**OpenRouter pricing table is static and manually maintained:**
- `apps/agent-worker/src/agent-runner.ts:56-64` defines 7 model prices; all others fall back to `FALLBACK_PRICE`. OpenRouter updates pricing frequently. Stale prices → incorrect billing.
- Files: `apps/agent-worker/src/agent-runner.ts:56-65`
- Remediation: Fetch from OpenRouter `/api/v1/models` at startup and cache.

---

## Missing Critical Features

**No `tg_user_balances` deduction on agent run completion:**
- This is the most critical billing gap. A user tops up RUB into `tg_user_balances`, but that balance is only read in `GET /api/tma/wallet` for display. Agent runs track cost only in `agent_runs.cost_rub` and `agents.spent_today_rub`. The prepaid balance is never debited.
- Effect: unlimited agent usage even after balance reaches 0, until the monthly/daily budget (a separate per-agent counter) hits its cap.
- Files: `apps/agent-worker/src/agent-runner.ts:254-256`, `apps/agent-worker/src/db.ts` (no `tg_user_balances` reference anywhere)

**No rate limiting on any `/api/tma/*` route:**
- No middleware, no IP-based throttle, no per-user request quota. Every endpoint is unbounded.
- Files: `apps/tg-miniapp/middleware.ts` (JWT verify only, no rate limit)

**No observability:**
- Zero structured logging, zero distributed tracing, zero error tracking (no Sentry, Datadog, OpenTelemetry). Worker errors go to `console.error`. Failed runs are detectable only by querying `agent_runs.status = 'failed'` manually.
- Files: `apps/agent-worker/src/index.ts:27-29`, `apps/agent-worker/src/agent-runner.ts` (console.error only)

---

## Test Coverage Gaps

**Zero tests for agent-worker:**
- No `*.test.ts` files exist anywhere under `apps/agent-worker/`. The billing logic, budget enforcement, upstream resolution, and tool dispatch are entirely untested.
- Risk: Critical — billing bugs and security issues go undetected.
- Priority: Critical

**No tests for TMA API routes:**
- No test files under `apps/tg-miniapp/app/api/`. The `initData` verification, JWT issuance, agent CRUD, topup flow, and NFT webhook are untested.
- Risk: High — auth regressions, double-credit bugs ship silently.
- Priority: High

**Tests exist only for `apps/web/`:**
- `apps/web/src/__tests__/` has ~20 test files covering the web app. TMA and agent-worker have zero coverage.

---

## 152-FZ / Compliance Gaps

**No personal data consent flow:**
- TMA stores `first_name`, `last_name`, `username`, `photo_url`, `language_code` from Telegram initData in `tg_users` (`packages/database/migrations/0016_tg_users.sql:2-7`) with no user consent screen, no privacy policy link, and no data processing agreement flow.
- Risk: 152-FZ Article 9 requires informed consent before processing personal data. Fine up to 300,000 RUB per violation (2024 amendments).

**No data deletion endpoint:**
- No API exists for a user to delete their account, runs, and stored data. GDPR Article 17 and 152-FZ Article 14 right-to-erasure requirements are not met.

**No OFD/fiscal receipts for RUB top-up:**
- `apps/tg-miniapp/app/api/tma/topup/init/route.ts` accepts RUB payments (via TON) but issues no fiscal receipt. Russian law (54-FZ) requires a fiscal receipt for any cash-equivalent payment from a Russian resident if turnover > ~2.4M RUB/year.
- Files: `apps/tg-miniapp/app/api/tma/topup/init/route.ts`, `apps/tg-miniapp/app/api/tma/topup/check/[id]/route.ts`

---

## Currency / Unit Confusion

**Three parallel balance representations, not unified:**
- `tg_user_balances.balance_rub` — user prepaid balance in RUB (NUMERIC 14,4)
- `agents.spent_today_rub` / `agents.budget_rub_monthly` — per-agent cost counter in RUB
- `tg_topups.amount_nano_ton` / `tg_topups.amount_rub` — top-up ledger in both nano-TON and RUB
- `agent_runs.cost_rub` — per-run cost in RUB

- There is no canonical "credit unit." Balance in RUB and spend in RUB are the same denomination but are never connected via code. The UI shows `balance_rub` from the wallet endpoint; the worker tracks `spent_today_rub` independently. There is no gate that prevents running when `balance_rub < estimated_cost`.

**USD→RUB conversion happens only in agent-worker, not in pricing display:**
- `apps/agent-worker/src/agent-runner.ts:130-134` converts USD→RUB using hardcoded 90. The TMA UI displays budgets in RUB but was set by the user without knowing the conversion. OpenRouter charges in USD. The model pricing table is USD; final user cost is in RUB. No consistent pipeline.

---

*Concerns audit: 2026-06-02*
