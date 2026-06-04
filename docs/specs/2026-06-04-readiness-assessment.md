# AIAG — Critical Readiness Assessment (2026-06-04)

> Honest, code-grounded re-score per `/CLAUDE.md` real-vs-fantasized discipline.
> Scope: the **APPLICATION** (apps/agent-worker, apps/tg-miniapp, packages/api-gateway, packages/database) + `.planning/STATE.json` (20 shipped).
> Prior scores (tech 50, functional 43) were stale; this supersedes them. Scale = 12 dims × 9 = 108.
> No inflation — where STATE claims a thing shipped but the code says otherwise, the code wins.

---

## Headline finding (read this first)

**The D-0 "gateway returns realized margin" keystone is NOT actually wired — it is broken by a header contract mismatch.**

- Gateway emits (`packages/api-gateway/src/routes/v1/chat.ts:169-170` + `src/lib/billing-headers.ts:17-22`):
  - `X-AIAG-Charged-Rub` and `X-AIAG-Upstream-Cost-Rub` — **rubles, decimal (`.toFixed(4)`)**.
- Worker reads (`apps/agent-worker/src/agent-runner.ts:57-58, 250-256, 284`):
  - `x-aiag-charged-usd-micro` and `x-aiag-upstream-cost-usd-micro` — **USD micro-integer**.
- These names **never overlap** → `parseUsdMicroHeaderToCredits` always returns `null` → `billedByGateway` is **always false** → the worker **always** falls back to the local hardcoded `estimateCostCredits` PRICING table (`agent-runner.ts:127-135, 331-335`).

So in production today: the worker bills off a 7-entry hardcoded price table, NOT the gateway's authoritative charge. The gateway's markup/`gateway_transactions` row and the worker's debit are **two independent cost calculations that can disagree**. STATE.json itself half-admits this ("USD-micro header emission still in backlog → worker falls back to estimate"), but the framing is too soft: the header the worker waits for **does not exist on the gateway at all**, and the one the gateway sends is in a different unit the worker never reads. This is the single biggest production-integrity gap.

Severity is bounded by: BYOK/external = genuinely 0 (verified, see Billing), the `MIN_RUN_COST` floor means it never bills 0, and prod has ~0 live agents. But the moment real agents run on AIAG-supplied models, **margin is unmeasured and the two ledgers drift.**

---

## Dimension scores (12 × 9 = 108)

### 1. Billing integrity — **6/9**
Evidence: `settleRun` (`apps/agent-worker/src/db.ts:514-575`) is genuinely atomic — markCompleted + guarded daily-spend `UPDATE … WHERE spent+cost<=budget RETURNING` + guarded balance debit `UPDATE … WHERE balance>=cost RETURNING` + append-only `tg_ledger_entries`, all in one `sql.begin`; idempotent via `uq_ledger_ref`. BYOK short-circuit (`if (isExternal) return`) verified at settle, sub-agent, and call_agent levels. Topup credit is equally atomic (`topup/check/[id]/route.ts:137-168`).
Biggest gap: **D-0 header mismatch (above)** — the "authoritative charge" path is dead, billing runs on a stale 7-model PRICING table; the gateway's own `aiag_settle_charge` debit and the worker's `tg_user_balances` debit are uncoordinated double-accounting.

### 2. Provider routing — **5/9**
Evidence: `resolveUpstream` (`agent-runner.ts:70-123`) cleanly orders provider_id → external_openai → aiag-gateway → OpenRouter fallback; gonka adapter live + gold-verified through `:4000`.
Biggest gap: **the gateway serves `mock` for any provider whose env key is unset** (`upstreams/registry.ts:21-38`) — openrouter/kie/groq/gonka all silently fall to a deterministic stub if the key is missing, so a misconfigured env yields fake completions that still bill. No "real upstream required" guard.

### 3. Auth — **7/9**
Evidence: TMA JWT is HS256-pinned with iss/aud binding, fail-hard on `TMA_JWT_SECRET` <32 chars (`middleware.ts:7-11, 42-46`); middleware strips spoofed `x-tma-user-id` + `x-middleware-subrequest` and re-injects the verified sub; initData verified with constant-time HMAC + 10-min freshness + future-date rejection (`verify-init-data.ts`); Next pinned 14.2.33. Gateway uses `AIAG_GATEWAY_KEY`.
Biggest gap: **live revocation is a stub** (`jwt-denylist.ts` `isRevoked` per SECURITY.md) — a leaked 24h JWT cannot be killed before expiry; no rotation story.

### 4. Runtime — **3/9**
Evidence: the "agent runtime" is honestly a stateless BullMQ→gateway loop (`agent-runner.ts`), concurrency 4, MAX_ITERATIONS 12, graceful MCP attach. It works for what it is.
Biggest gap: **there is no managed runtime** — no per-user process, no persistence between runs beyond the `agent_memory` KV + last-10 history; managed-Hermes is `blocked` on a 16GB box that doesn't exist. Everything the product *markets* as "your agent lives in Telegram" is this one loop. Honest, but thin.

### 5. Data model — **5/9**
Evidence: D-1 credit unit is clean (BIGINT cents, killed USD_TO_RUB=90); append-only ledger + cached balance commit together; per-kind idempotency indexes. Schema is coherent.
Biggest gap: **`tg_topups` columns (`amount_nano_ton`, `comment_tag`, `confirmed_at`) are assumed to pre-exist** — no migration in `migrations/` creates that table; 0029 only *renames* its `amount_rub`→`amount_credits`. The schema's real prod state is undocumented (untracked migrations, see Deploy/Ops). `agent_runs.tg_user_id` is `::bigint` but joined against UUID agent ids — works, but the mixed key types (bigint tg_user, uuid agent/run) are a footgun.

### 6. Observability — **3/9**
Evidence: gateway has a `logRequest` stream + metrics.ts; worker logs the D-0 margin line (which never fires, see #1) and run lifecycle to stdout/pm2.
Biggest gap: **no metrics, no alerting, no dashboards on the money path.** Margin is logged only on the dead gateway-authoritative branch, so realized margin is currently **un-observable in prod**. No structured error aggregation; a billing drift would be silent.

### 7. Testing — **4/9**
Evidence: worker has 3 focused tests incl. `run-settle.integration.test.ts` (the load-bearing atomicity test) + `resolve-upstream` + `budget`; gateway has ~14 unit/middleware tests (pricing, routing, auth, antiFraud, moderation, transborder).
Biggest gap: **apps/tg-miniapp has ZERO tests** (0 `.test.ts` files) — every money-touching API route (topup reconcile, rent payout, clone, author income) is untested; and the one test that would have caught the D-0 header mismatch (`resolve-upstream.test.ts:198`) tests the worker's *reader* against a hand-written `x-aiag-charged-usd-micro` header — it never asserts against what the **gateway actually emits**, so the contract break passed CI green.

### 8. Deploy/Ops — **3/9**
Evidence: skill `aiag-deploy` documents the recipe; CI rsync for web/gateway.
Biggest gap: **migrations are manual and UNTRACKED on prod** (no applied-migrations table; `packages/database/CLAUDE.md` confirms), **tma + agent-worker are built by hand on the VPS** (CI doesn't build them), pm2 needs a **manual `pm2 restart` after every deploy** (ownership trap, in backlog), and a worker is noted "waiting restart". Single 2GB box runs 5 procs. Releasing is fragile and human-gated; the branch `feat/r1.0-wave0-consolidated` is **not merged to master**.

### 9. Security — **7/9**
Evidence: SSRF guard (`safeFetch`) on every user-influenced fetch in worker + gateway with allowlist + anti-rebind + redirect re-validation; BYOK keys AES-256-GCM; PKCE/CSRF on MCP-OAuth (reviewed PASS); repo made private; white-label brand kept to server logs only; constant-time initData compare.
Biggest gap: **tracked SECURITY-TODOs remain** — provider_id SSRF re-validation (R1-7), eval-runner nsjail, VPS root password, jwt live-revocation stub; plus the gateway `gp-` Gonka key was pasted in chat and needs rotation (founder task).

### 10. Error handling — **6/9**
Evidence: worker degrades gracefully everywhere — MCP attach failure → built-in tools, unknown tool → neutral result, model-not-found → OpenRouter fallback, sub-agent error → neutral 0-cost; settle failures map to typed reasons (`insufficient_balance_settle`, `budget_exceeded_daily_settle`); toncenter failures return `pending` not 500.
Biggest gap: **the OpenRouter fallback bills via local estimate with no margin and no white-label markup**, and a gateway that silently returns `mock` (see #2) produces a "successful" run that still debits — failure modes that look like success on the money path.

### 11. Scalability — **4/9**
Evidence: BullMQ + Redis, worker concurrency 4, scheduler is a single resident 60s tick with an atomic claim (`claimDueSchedules` advances next_run_at in the same UPDATE → multi-instance safe).
Biggest gap: **single 2GB VPS, single worker process, no horizontal story.** The scheduler tick is in-process on `index.ts`; if the worker is down, schedules silently don't fire (no liveness/alert). `fetchUsdRubRate` per-request with a `.catch(() => 92)` hardcoded fallback rate. Fine for ~0–100 users, not for a public launch.

### 12. Compliance — **2/9**
Evidence: transborderGate + moderation + PII middleware exist on the gateway (RU web side).
Biggest gap: **explicitly "not factored now"** (founder 2026-06-03). TMA crypto path has no KYC/AML, no terms enforcement, raw `tg_user_id` exposed as the public author handle (backlog: opaque handle), no withdrawal/payout legal structure (FD-2 unresolved). Acceptable per founder decision, but a real public money launch needs this.

---

## Re-scored totals

| Scale | Prior (stale) | **Now (2026-06-04)** |
|---|---|---|
| **Functional / 108** | 43 | **52** |
| **Technical / 108** | 50 | **55** |

Functional moved up (publish/clone/rent/author-income/schedules/skills/A2A/TON-init all genuinely ship and verify), but is held well below "good" by: the dead D-0 margin path, the mock-upstream fallback, no managed runtime, and zero TMA tests. Technical edged up on the clean D-1 ledger + atomic settle + solid auth/SSRF, but is dragged by untracked manual deploys, no observability, and the header contract break.

---

## What is genuinely production-solid
- `settleRun` atomicity + the D-1 ledger (guarded UPDATE…WHERE…RETURNING + co-committed append-only ledger + idempotency). This is the best part of the codebase.
- Auth chain: HS256-pinned JWT, header stripping, constant-time initData, Next 14.2.33 CVE pin.
- SSRF posture: `safeFetch` consistently applied with allowlists on every user-influenced hop.
- BYOK = exactly 0 charge, enforced at every billing entry point (run, sub-agent, call_agent).
- TON topup reconcile is atomic + idempotent (status guard + ledger).

## What is fragile / risky
- **D-0 margin path is dead code** (header name+unit mismatch) → billing runs on a stale 7-model PRICING table; gateway and worker keep two uncoordinated cost figures.
- **Mock upstream is the silent default** when a provider env key is missing → fake completions that still bill.
- **Worker is a single process** with the scheduler embedded; "waiting restart" noted; no liveness alerting → scheduled runs silently stop if it's down.
- **No tracked migrations** + manual VPS builds + manual pm2 restart → deploys are human-gated and drift-prone; real prod schema state is undocumented.
- **Zero tests in tg-miniapp** — every money route (rent payout, clone, topup) is untested; the existing worker test mocks the *expected* header, so it never caught the contract break.
- Branch not merged to master; the whole R1.0 wave lives on `feat/r1.0-wave0-consolidated`.

## Top-5 fixes before a real public launch
1. **Fix the D-0 header contract (P0, money).** Pick ONE unit+name. Either make the gateway emit `x-aiag-charged-usd-micro`/`x-aiag-upstream-cost-usd-micro` (worker already reads them) in `routes/v1/chat.ts` + `lib/billing-headers.ts`, or change the worker to read the `*-Rub` headers — but USD-micro is correct given D-1 is USD-cents. Then add a **contract test that asserts the gateway's actual emitted headers parse in the worker** (the current test only checks the reader against a fabricated header). Until this lands, realized margin is unmeasured.
2. **Kill the silent mock-upstream fallback on the live path** (`upstreams/registry.ts`). For a billable AIAG run, a missing provider key must **fail the request**, not return a deterministic stub that still debits. Gate `mock` behind `AIAG_FORCE_MOCK=1` only.
3. **Make deploys tracked + repeatable.** Add an applied-migrations table (even a simple `schema_migrations(version, applied_at)`), automate the `pm2 restart` (run procs under `aiag`), and get tma/agent-worker into CI build. Document the real prod schema (incl. the un-migrated `tg_topups` columns). Then **merge `feat/r1.0-wave0-consolidated` → master.**
4. **Add money-path observability + worker liveness.** Emit realized margin as a metric (once #1 is fixed) and alert on: worker down, scheduler tick stalled, settle failures, balance/ledger divergence. Right now a billing drift or a dead worker is invisible.
5. **Add tests to tg-miniapp money routes.** At minimum: topup reconcile idempotency (no double-credit under concurrent polls), rent payout (renter debit == author credit, 0% AIAG), and clone-of-paid → 402. These are the highest-value untested surfaces.

### Honorable mentions (do before scale, not blocking)
- Live JWT revocation (replace `isRevoked` stub). · Opaque author handle (stop leaking raw `tg_user_id`). · Rate-limit publish/clone. · Rotate the pasted Gonka `gp-` key. · Replace the `.catch(() => 92)` hardcoded USD/RUB fallback rate on the gateway with a cached last-good value.
