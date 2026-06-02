---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: MVP
status: executing
stopped_at: Completed 15.1-02-PLAN.md (CVE-2025-29927 + JWT hardening — R0-4/5). VPS verification deferred.
last_updated: "2026-06-02T10:12:00Z"
last_activity: 2026-06-02 -- Phase 15.1 plan 02 executed (auth hardening: CVE patch, HS256 pin, fail-hard secret, nginx directive)
progress:
  total_phases: 16
  completed_phases: 1
  total_plans: 10
  completed_plans: 8
  percent: 80
---

# Project State

## Project Reference

See: `.planning/PROJECT.md` (updated 2026-04-26)

**Core value:** Any AI model. One API. Payment in ₽.
**Current focus:** Phase 15.1 — R0 TMA billing + identity truth

## Current Position

Phase: 15.1 (R0: TMA billing + identity truth) — EXECUTING
Plan: 3 of 3 (15.1-01 + 15.1-02 complete; next: 15.1-03 integration test)
Status: Executing Phase 15.1
Last activity: 2026-06-02 -- 15.1-02 auth hardening complete (CVE-2025-29927 + JWT hardening R0-4/5)

Progress: [████████░░] ~85% (plan-weighted) — Phase 15.1 auth hardening closed: Next.js 14.2.33 (CVE-2025-29927), HS256-pinned jwtVerify with iss/aud, fail-hard TMA_JWT_SECRET on both auth surfaces, x-tma-user-id + x-middleware-subrequest strip in middleware, iss/aud/jti on token issuance, JWT denylist wiring (T-15.1-10 deferred), nginx snippet. Code static-verified (tsc clean); VPS deploy + nginx apply + curl tests deferred per no-local-runtime. Next: 15.1-03 (integration test suite).

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
| 15.1. R0 TMA billing+identity | 2/3 | unit suites added (tsc-clean; vitest run deferred to VPS) | ◐ In Progress — 15.1-01 worker money path + 15.1-02 auth hardening complete. VPS verification + 15.1-03 (integration test) pending |

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

### Roadmap Evolution

- 2026-06-02: Phase 15 (Telegram Mini App) added to ROADMAP.md — was shipped (commit 88f5eab) but never documented in the roadmap.
- 2026-06-02: Phase **15.1** inserted after Phase 15: **R0 — TMA billing + identity truth** (emergency fixes from the 50/108 tech-stack eval) — **URGENT**. SOT: `docs/specs/2026-06-02-tma-tech-remediation-roadmap.md`.

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

Last session: 2026-06-02 (executed 15.1-02 — auth hardening; branch `plan/15.1-r0-billing-identity`)
Stopped at: Completed 15.1-02-PLAN.md (R0-4/5). 5 task commits (b37fe0e, dd5b17c, 1c8f4a8, c463f1c, 8e78b35) + SUMMARY. tsc clean; VPS deploy + nginx apply + curl tests deferred (no-local-runtime).
Resume file: None — next is `/gsd:execute-phase 15.1` for 15.1-03 (integration test suite)

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
