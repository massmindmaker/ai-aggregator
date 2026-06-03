---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: MVP
status: executing
stopped_at: "R0 (Phase 15.1) COMPLETE on branch plan/15.1-r0-billing-identity. Re-cut the R1 milestone into ROADMAP.md from SYNTHESIS.md (Waves 0-3, D-0..D-14, FD-1..FD-8) + monetization.md. Current focus = R1.0 money-correctness foundation (D-0 in progress on branch; D-7/D-8/DEFAULT_MODEL done on branch)."
last_updated: "2026-06-03T00:00:00Z"
last_activity: 2026-06-03 -- R1 milestone re-cut from research SYNTHESIS; focus set to R1.0
progress:
  total_phases: 16
  completed_phases: 1
  total_plans: 10
  completed_plans: 9
  percent: 90
---

# Project State

## Project Reference

See: `.planning/PROJECT.md` (updated 2026-04-26)

**Core value:** Any AI model. One API. Payment in ₽.
**Current focus:** R1.0 — Money-correctness foundation (D-0 gateway-returns-margin)

## Current Position

Milestone: R1 — Money-correct foundation + providers + managed-Hermes test (re-cut 2026-06-03 from `docs/specs/research/SYNTHESIS.md`)
Phase: R1.0 — Money-correctness foundation — IN PROGRESS (on branch)
Status: R0 (Phase 15.1) COMPLETE; R1.0 underway on `plan/15.1-r0-billing-identity`
Last activity: 2026-06-03 -- R1 milestone re-cut from research SYNTHESIS; focus set to R1.0

**R1.0 item status:**
- ✓ **D-7 `safeFetch` egress guard** — done on branch (shipped with R0).
- ✓ **D-8 initData hardening** (timingSafeEqual + 600s expiry + Redis nonce) — done on branch.
- ✓ **DEFAULT_MODEL registry fix** — done.
- ◆ **D-0 single billing authority + gateway-returns-margin** — IN PROGRESS on branch. The keystone; unblocks D-5/D-6/D-8-9/D-11/D-12.
- 📋 **D-1 USD micro-credit + `tg_ledger_entries`** — planned (kill `USD_TO_RUB = 90`, both copies; freeze-window migration of live `tg_user_balances`).

Progress: [█████████░] ~90% (plan-weighted, MVP phases) — R0/Phase 15.1 COMPLETE (worker money path R0-1/2/3/6 + auth hardening R0-4/5 + settleRun integration test). R1 milestone now defines the path forward; R1.0 in progress.

## Why Phase 8 Next

Phases 4/5/6/7 are progressing well in branches but **none can launch without Phase 8** (legal pages + РКН-уведомление + monitoring stack + deploy pipeline finalization). Phase 8 is the launch-blocker; everything else converges into it. Resume Phase 8 first, while letting feature branches naturally complete.

Alternative: `/gsd:execute-phase 2` to finish bare-metal infrastructure (10% remaining) — also a launch prerequisite. Then `/gsd:execute-phase 8`.

## Performance Metrics

**Velocity:**

- Total plans completed: 2 (Phase 1, Phase 3)
- Tags shipped: 3 (`v0.1.0-foundation`, `v0.1.1-foundation-complete`, `v0.2.0-design`)
- Master commits since 2026-04-20: 11
- Active development span: ~1 week

**By Phase:**

| Phase | Plans | Tests | Status |
|-------|-------|-------|--------|
| 1. Foundation | 1/1 | 44/44 | Complete + deployed |
| 2. Infrastructure | 1/1 | n/a | Complete — VPS bare-metal + HTTPS + apps + monitoring disabled per user |
| 3. Design System | 1/1 | n/a | Complete + deployed (post-MUI purge, hero CA restored 2026-04-27) |
| 4. Gateway | 1/1 | 57/58 | Complete — gateway live (node-runtime entry fixed) |
| 5. Upstreams | partial | n/a | Merged — wiring exists, real API keys still TODO |
| 6. Marketplace | 1/1 | n/a | Complete + deployed (RSC `f is not a function` fixed 2026-04-27) |
| 7. Supply | partial | n/a | Merged — submission UI exists, eval-runner sandbox still TODO |
| 8. Launch | 1/1 | n/a | Complete — pm2 + nginx + GitHub Actions SSH rsync deploy, ai-aggregator.ru live |
| 14. Contest→Marketplace Admin | 7/7 code, 6/7 deployed | n/a | ◆ Admin half on master, migration 0014 applied on VPS; web/gateway/worker deploy blocked on CI pipeline debt — see `.planning/phases/14-contest-marketplace-admin/14-07-SUMMARY.md` |
| 15.1. R0 TMA billing+identity | 3/3 | unit + integration suites (tsc-clean; vitest run deferred to VPS) | ✓ Complete — 15.1-01 worker money path + 15.1-02 auth hardening + 15.1-03 settleRun integration test. VPS verification deferred (no-local-runtime). |

## Accumulated Context

### Decisions

Full log in `.planning/PROJECT.md` Key Decisions and `.planning/intel/decisions.md` (verbatim D#1–D#14).

Recent decisions affecting current work (all 2026-04-24):

- **D#12** Drop Supabase → Timeweb managed PG + NextAuth + S3 (152-ФЗ + RAM economy)
- **D#13** Drop Docker entirely → bare-metal apt + systemd
- **D#14** Drop Dokploy → pm2 + nginx + GitHub Actions SSH rsync (Capistrano-style releases)

Phase 15.1 (2026-06-02):

- **15.1-01a** Worker money path uses READ COMMITTED + guarded `UPDATE … WHERE <guard> RETURNING` (per-row lock + WHERE-guard = double-spend/over-budget safe), NOT SERIALIZABLE and NO 40001 retry loop. settleRun = markCompleted + atomic daily-spend guard + balance debit in one `sql.begin`.
- **15.1-01b** Debit `tg_user_balances` (the live spendable table credited by topup-check + migration 0019), NOT `tg_users`. MIN_RUN_COST = 1₽ run-start floor.
- **15.1-01c** `agent_provider_credentials.enc_key` (TEXT) decoded as base64 — the BYOK write route (future plan) MUST store `encryptSecret(key).toString('base64')`. No write route exists yet; this sets the contract.
- **15.1-01d** aiag runs route through `http://127.0.0.1:4000/v1/chat/completions` with `AIAG_GATEWAY_KEY`; OpenRouter direct stays ONLY as the documented degraded fallback on gateway 404/model_not_found. White-label: error labels never leak "openrouter" on the aiag path.
- **15.1-02a** `isRevoked` in jwt-denylist.ts uses Upstash REST API over fetch (Edge-safe) when `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` are set; stubs false otherwise. R0 non-blocking — alg-pin + CVE patch + fail-hard secret are the blocking layer.
- **15.1-02b** JWT fail-hard guard is a module-level throw (not route-level) so the process refuses to serve ANY route when `TMA_JWT_SECRET` is missing or < 32 chars — not just the auth route.
- **15.1-02c** isRevoked fails-open on Upstash errors (returns false) to avoid locking out all users on transient Redis blips; stricter fail-closed policy deferred to T-15.1-10.
- **15.1-03a** Integration test uses TEST_DATABASE_URL (never DATABASE_URL/prod); gated by `describe.skipIf(!TEST_DATABASE_URL)`; synthetic tg_user_id in 9_000_000_000+ reserved range; afterEach cleanup by generated id. No test logic leaked into db.ts (sql was already exported by Plan 01).
- **15.1-03b** Dedicated test-local postgres client (postgres(TEST_DATABASE_URL)) for seeding/assertions; settleRun uses module-level sql — operator sets DATABASE_URL=TEST_DATABASE_URL when running integration suite on VPS so both clients target the same test DB.

### Roadmap Evolution

- 2026-06-02: Phase 15 (Telegram Mini App) added to ROADMAP.md — was shipped (commit 88f5eab) but never documented in the roadmap.
- 2026-06-02: Phase **15.1** inserted after Phase 15: **R0 — TMA billing + identity truth** (emergency fixes from the 50/108 tech-stack eval) — **URGENT**. SOT: `docs/specs/2026-06-02-tma-tech-remediation-roadmap.md`.
- 2026-06-03: **Milestone R1 re-cut** into ROADMAP.md from `docs/specs/research/SYNTHESIS.md` (lead-architect synthesis of R-01..R-12 + adversarial reviews, build order Waves 0-3, decisions D-0..D-14, founder gates FD-1..FD-8) + `docs/specs/2026-06-03-monetization.md`. R0 (Phase 15.1) marked the completed predecessor. Phases R1.0 (money foundation) → R1.1 (deposits + tool money) → R1.2 (jetton + runtime + delivery) → R1.3 (managed-Hermes test + creator economy). Brief: `.planning/R1-MILESTONE.md`.

R1 (2026-06-03):

- **R1-thesis (SYNTHESIS §0)** The money path is the product. Build money-correctness (D-0 margin authority, D-1 USD ledger) BEFORE anything that pays anyone (D-5/6/8/9/11/12 are blocked on D-0). Build crypto deposit *plumbing* (ledger/reconciler/jetton) now (correct under both Stars and crypto); keep the *surface/currency* founder-gated (FD-1).
- **R1-FD-1** Stars-vs-crypto: resolved direction = **multi-crypto now (TON + others), Stars deferred** (founder 2026-06-03). Gates deposit UX surface (R1.2), not the plumbing.
- **R1-FD-2** Withdrawable credits: **OPEN**. Gates author/user cash-out (R1.3 withdraw leg); author-rent accrual ships regardless (fixed author-set sum is deterministic, not margin-derived).
- **R1-monetization** Author rent = pass-through, **NO % cut** (founder 2026-06-03, `docs/specs/2026-06-03-monetization.md`): renter pays the exact author-set sum, author receives it in spendable credits; AIAG revenue = model markup + tools + deploy only.

### Pending Todos

None captured via GSD yet (workflow just bootstrapped today).

### Blockers/Concerns

External (waiting on user):

- **AIAG_GATEWAY_KEY (NEW, 15.1-01)** — a gateway api-key (`sk_aiag_live_…`) for the AIAG house org must be added to `/srv/aiag/shared/.env`. Without it aiag agent runs fail with `upstream_misconfigured` (AIAG_GATEWAY_KEY not set). Blocks all aiag run traffic + the 15.1-01 VPS verification.
- **15.1-01 VPS verification (deferred, no-local-runtime)** — zero-balance reject / paid-run writes gateway_transactions + debits balance / 4-run concurrency budget hold / picker routes. Steps in `.planning/phases/15.1-r0-tma-billing-identity-truth-emergency-fixes-from-the-108-e/15.1-01-SUMMARY.md` (VPS verification section). Run after `pm2 restart agent-worker`.
- **Real upstream API keys** — OpenAI / YandexGPT / GigaChat / Anthropic. Without them /v1/chat/completions returns mock-or-401. Highest-priority next milestone.
- **Payment integration end-to-end test** — Tinkoff sandbox keys + a successful test charge against `/api/payments/*`.
- **S3 bucket** — `aiag-storage` not created in Timeweb. Blocks Phase 5 image storage, Phase 6 uploads, Phase 7 submissions (REQ-INF-011).
- **VPS RAM** — 2GB tight (web 92MB + gateway 26MB + PG + nginx). Recommend 4GB upgrade before traffic.
- **DNS** — `www.` and `api.` A-records not added in Beget. Blocks subdomain certs.

Internal:

- **STATE.md not SDK-parseable** — `gsd-sdk query state.advance-plan` errors with "Cannot parse Current Plan or Total Plans from STATE.md" (the Position block still had `--phase`/`--name` placeholders from a prior interpolation bug). The 15.1-01 close updated STATE.md/ROADMAP.md manually. `roadmap.update-plan-progress 15.1` also returned no-matching-checkbox. Cleanup ticket: normalize the Position block to the format the SDK state handlers expect.
- **provider_id SSRF (accepted this phase, tracked R1-7)** — the worker provider_id branch fetches a user-controlled `base_url_override`; full SSRF re-validation (IPv6 ULA / DNS-rebind) deferred to R1-7 per threat T-15.1-05.
- **Eval-runner sandbox** (nsjail) — Phase 7 submission scoring still uses unsanitised exec. SECURITY-TODO before opening contests publicly.
- **VPS root password** — SECURITY-TODO change/disable (key auth already active).
- **deploy.sh pm2 process name** — script looks for `web`/`gateway`, actual pm2 names are `aiag-web`/`aiag-gateway`. Manual `ln -sfn` + `pm2 restart aiag-web` required after each deploy. Cleanup ticket.

Recently fixed (2026-04-27):

- NextAuth v5 UntrustedHost / "Failed to parse URL /login?error=Configuration" → `trustHost: true`.
- Postgres "server does not support SSL connections" on register → ssl=false for localhost URLs in `createDb`.
- Marketplace 500 / `TypeError: f is not a function` digest 2370859535 → moved `computeFacets` from `'use client'` FilterPanel into `lib/marketplace/facets.ts`.
- Hero animation missing → ported Brian's-Brain CA from `brain/Projects/AIAG/Wireframes/animations/hero-demo-v2.html` to `apps/web/src/components/HeroAnimation.tsx`.

## Deferred Items

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| UI | Storybook + visual regression suite | Moved to v2.0 | 2026-04-24 (Phase 3 close) |
| UI | MUI cleanup on 7 legacy pages | Moved to plan-03b | 2026-04-24 (Phase 3 close) |
| Auth | Password reset email flow | Deferred to post-deploy smoke | 2026-04-22 (Phase 1 close, Task 3) |
| Eval | Model file (weights) submissions | Phase 2 / v2.0 | 2026-04-18 (D#7 fixed predictions-only MVP) |
| Infra | nsjail eval sandbox upgrade | SECURITY-TODO Phase 2 | 2026-04-24 |

## Session Continuity

Last session: 2026-06-02 (executed 15.1-03 — settleRun integration test; branch `plan/15.1-r0-billing-identity`)
Stopped at: Phase 15.1 COMPLETE. 15.1-03: 1 task commit (97afe5d) + SUMMARY. tsc clean; vitest skips 4 cleanly. VPS green run deferred.
Resume file: None — Phase 15.1 complete. Next: merge `plan/15.1-r0-billing-identity` to master, then VPS deploy + integration green run.

**Next milestone candidates** (pick one to focus):

1. Real OpenAI / YandexGPT keys → live `/v1/chat/completions` end-to-end
2. Tinkoff sandbox payment test → close Phase 5 monetization loop
3. S3 bucket provisioning → unblock image upload + submission flows
4. nsjail eval-runner sandbox → unblock public contests

**Last release:** `20260427T024519Z-1e346f7` deployed to ai-aggregator.ru — but commit hash is misleading; actual code shipped includes uncommitted master tip `ee0824d` (deploy was done with built artefacts before the commits were pushed; matches by content)

**Worktrees in play (parallel work possible):**

- `C:\Users\боб\projects\aggregator` — `exec/plan-03-design` (current shell, 4ad927f)
- `C:\Users\боб\projects\aggregator-master-check` — `master` (314397d, used for this bootstrap commit)
- `C:\Users\боб\projects\aggregator-plan-04` — `exec/plan-04-gateway`
- `C:\Users\боб\projects\aggregator-plan-05` — `exec/plan-05-upstreams`
- `C:\Users\боб\projects\aggregator-plan-06` — `exec/plan-06-marketplace`
- `C:\Users\боб\projects\aggregator-plan-07` — `exec/plan-07-supply`
- `C:\Users\боб\projects\aggregator-plan-08` — `exec/plan-08-launch`

**VPS production:** `5.129.200.99` (Timeweb ru-1, Ubuntu 24.04, 2GB RAM). SSH `aiag-vps`. PG 16.13 + Redis 7 + Nginx + certbot + Node 24 + Bun + pm2. БД `aiag` (26 tables applied). HTTPS active on apex `ai-aggregator.ru`.

**Planned Phase:** 15.1 (R0: TMA billing + identity truth) — 3 plans — 2026-06-02T09:35:47.541Z
