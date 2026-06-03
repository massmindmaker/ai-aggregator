# AIAG D-0 money-path — code-VERIFIED 2026-06-03

Closes the open loop from `aiag_session_2026_06_03_driver_handoff.md` ("Wave-0 built + unit-green, NOT deployed, NOT verified"). D-0 keystone code reviewed adversarially for **money correctness** before it ships to live billing. Read-only review (no live-billing code touched). Branch = `feat/wave0-d0-margin` (commits 44d0fcb → 53ea794 → 42f83d5 → f500d9d → ab2cbc9).

## Verdict: D-0 is money-correct and ship-ready. Blocker is OPERATIONAL (pm2 re-pin + founder go), not code.

## What D-0 does (verified correct)
- **Gateway** (`packages/api-gateway`): on each request returns brand-neutral ₽ headers `X-AIAG-Charged-Rub` + `X-AIAG-Upstream-Cost-Rub` (`lib/billing-headers.ts`, wired in `routes/v1/chat.ts` + `streaming/sse.ts`). `upstreamCostRub = upstreamUsd × rate` (NO markup); `totalRub = calcCostRub` (WITH markup) → `margin = charged − upstreamCost > 0`. Keyed to gateway_request_id via echoed `X-Request-Id`.
- **Worker** (`agent-runner.ts`): `callWithFallback` now returns `ChatResult {response, billedByGateway, chargedRub, upstreamCostRub}`. Bills off authoritative gateway charge when present; the instant ANY billable model-call lacks figures (or falls back to OpenRouter) → flips the WHOLE run to local `estimateCostRub` (cumulative tokens) — **never silently mixes, never bills 0**. Tool fees accumulate in `toolFeesRub` (recompute-safe; added on top of either basis). `finalBillableCostRub` floors billable to `MIN_RUN_COST=1₽` (CHARGE-0 fix). External/BYOK stays exactly 0 (no floor).

## Adversarial checks that PASSED
- **allowlist host:port** — both safe-fetch copies do `hostPort = url.port ? host:port : host; allowlist.has(host)||allowlist.has(hostPort)`. `127.0.0.1:4000` and `openrouter.ai` both match → **D-0 does NOT block aiag traffic** (was the highest-risk failure mode).
- **worker reads non-streaming** — `buildBody` sets no `stream` flag → hits chat.ts `/completions` (headers set before `c.json`), not sse.ts. Headers reach the worker. ✓
- **per-request charge summation** — gateway charges per request (per-response tokens); worker sums per iteration = correct total. ✓
- **zero-usage response** — `parseRubHeader` accepts 0 → billedByGateway=true, charged 0 → floored to 1₽ by CHARGE-0. ✓
- **DEFAULT_MODEL fixed** on this branch → `openai/gpt-4o-mini` (registered slug). The latent `nousresearch/hermes-4-405b` 400-Unknown-model bug noted in `/CLAUDE.md` is fixed HERE but NOT on the working branch `plan/15.1-r0-billing-identity`.

## LOW findings (none blocking)
1. **sse.ts billing headers are a no-op** — `c.header()` called after `streamSSE` started won't reach the client. Harmless today (worker uses non-streaming; nginx strips; no client reads them) but dead/misleading code.
2. **Sub-1₽ authoritative charges floored to 1₽** — user debit (`tg_user_balances`) can diverge from gateway authoritative charge (`gateway_transactions`) by up to ~1₽ on tiny requests. Intended MIN_RUN_COST business rule; means "bill the exact authoritative charge" isn't literally true below the floor.
3. **Two duplicated safe-fetch copies** (shared 325L + worker 269L) — consistent today; divergence risk. Worker comment justifies (no shared build at runtime on VPS).
4. **Fallback-flip cross-ledger** — on the rare fallback path, gateway already debited house-org for early gateway-billed iterations but worker bills the user via estimate for the whole run. Documented intent (never mix/never free). Low.
5. **(Pre-existing, NOT D-0) house-org ledger** — gateway `settleCharge` debits house org by `totalRub` (charged WITH markup). Confirm with founder the internal house-org accounting is intended to net the markup. Out of D-0 scope.

## CONSOLIDATED + pushed 2026-06-03 (session 2)
Wave0 stack consolidated onto a clean branch **`feat/r1.0-wave0-consolidated`** (= `plan/15.1-r0-billing-identity` + 7 commits), **pushed to origin**. Cherry-pick of the 6 wave0 commits was conflict-free (money-path files had ZERO divergence on the working branch since merge-base `7a3560c`). 7th commit = the auth_date fix below.
- **Typecheck:** consolidated branch is type-clean. The only `tsc --noEmit` failures are **pre-existing repo-wide `TS6059 rootDir` noise** (shared `@aiag/typescript-config` leaks `rootDir` into telegram-alerts/api-gateway/shared) — NOT caused by D-0, and `tsup` builds ignore it (so prod builds fine). Separate cleanup ticket: fix the base tsconfig `rootDir`/`extends`.
- **Fix applied (commit 3a37a0c):** D-8 future-dated `auth_date` — `verify-init-data.ts` only checked `ageSec > max`, so a future timestamp got an unbounded freshness window. Now rejects `ageSec < -60s` (60s clock-skew tolerance so legit logins survive VPS↔Telegram skew). Low real exploitability (check runs after HMAC → needs bot secret to forge) but cheap hardening matching Telegram's reference.
- **NOT fixed (tracked lows, touching live path = risk > reward):** budget mid-run cutoff uses unfloored `totalCostRub` vs floored `billable` at settle (no money loss — worst case a zero-token run fails `budget_exceeded_daily_settle`); margin `console.info` logs gateway authoritative model-margin pre-floor (defensible — floor/toolFees aren't model margin); sse.ts billing headers are a no-op after stream start (dead code, no consumer); bot-token-missing returns 503 not module-throw.

## DEPLOY GATE (session 2 stop point) — blocked on 2 things, neither auto-resolvable
1. **VPS unreachable from this machine** — `ssh aiag-vps` (routes via ProxyCommand `connect -H 127.0.0.1:10809`) times out at banner exchange → local VPN/SOCKS proxy is DOWN. User must bring up the VPN/proxy. Do NOT rapid-retry (fail2ban bans the exit IP).
2. **Standing founder pause on the live-billing deploy** + the one-time **pm2 re-pin (F2)** is still pending on the box (per driver-handoff: symlinks swapped but pm2 still runs old absolute paths).

**Deploy is workflow_dispatch-ONLY** (`.github/workflows/deploy-production.yml` has no `push:` trigger — pushing the branch is safe). New pipeline builds all apps on the runner (no manual VPS build) and deliberately runs NO migrations (D-0 has none).

### Ready deploy recipe (once VPN up + founder go):
1. One-time on box (if not done): `cp ops/ecosystem.config.cjs /srv/aiag/shared/` ; `chown -R aiag:aiag /srv/aiag/{tma,agent-worker}` ; `pm2 delete gateway agent-worker tma && pm2 start /srv/aiag/shared/ecosystem.config.cjs --only gateway,agent-worker,tma` (breaks the absolute-path trap).
2. Confirm `AIAG_GATEWAY_KEY` set in `/srv/aiag/shared/.env` (grep -c, don't print).
3. Trigger workflow_dispatch: `ref=feat/r1.0-wave0-consolidated`, `apps=gateway,agent-worker,tma`.
4. Verify: gateway `:4000` returns `X-AIAG-Charged-Rub`/`X-AIAG-Upstream-Cost-Rub` on a test request; run the deferred 15.1-01 VPS checks (zero-balance reject / paid-run writes gateway_transactions + debits / picker routes). Rollback = re-pin pm2 to prior release (clean — no migration).

## Next action (founder-gated)
Consolidate the wave0 stack (safefetch+DEFAULT_MODEL → D-0 margin → D-8 initData) onto the working line + deploy via pm2 re-pin (the `aiag_session_2026_06_03_driver_handoff.md` pm2 absolute-path trap fix: `ops/ecosystem.config.cjs` → `/srv/aiag/shared/`, then `pm2 delete <app> && pm2 start ecosystem --only <app>`). Then run the deferred 15.1-01 VPS verification. Requires `AIAG_GATEWAY_KEY` in `/srv/aiag/shared/.env`.
