---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: MVP
status: executing
stopped_at: production stable, all 10 surveyed routes return 200 OK with zero console errors. Hero CA animation live.
last_updated: "2026-06-02T09:35:47.575Z"
last_activity: 2026-05-08 -- Phase --phase execution started
progress:
  total_phases: 16
  completed_phases: 1
  total_plans: 10
  completed_plans: 7
  percent: 70
---

# Project State

## Project Reference

See: `.planning/PROJECT.md` (updated 2026-04-26)

**Core value:** Any AI model. One API. Payment in ₽.
**Current focus:** Phase --phase — 14

## Current Position

Phase: --phase (14) — EXECUTING
Plan: 1 of --name
Status: Executing Phase --phase
Last activity: 2026-05-08 -- Phase --phase execution started

Progress: [██████░░░░] ~60% — Phases 1–3 + Phase 8 deployment shipped; Phases 4–7 merged into master via `v0.5.0-mvp-integration` and partially live (web + gateway). Still missing: real upstream API keys, payment integration test, S3 bucket, eval-runner sandbox.

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

## Accumulated Context

### Decisions

Full log in `.planning/PROJECT.md` Key Decisions and `.planning/intel/decisions.md` (verbatim D#1–D#14).

Recent decisions affecting current work (all 2026-04-24):

- **D#12** Drop Supabase → Timeweb managed PG + NextAuth + S3 (152-ФЗ + RAM economy)
- **D#13** Drop Docker entirely → bare-metal apt + systemd
- **D#14** Drop Dokploy → pm2 + nginx + GitHub Actions SSH rsync (Capistrano-style releases)

### Roadmap Evolution

- 2026-06-02: Phase 15 (Telegram Mini App) added to ROADMAP.md — was shipped (commit 88f5eab) but never documented in the roadmap.
- 2026-06-02: Phase **15.1** inserted after Phase 15: **R0 — TMA billing + identity truth** (emergency fixes from the 50/108 tech-stack eval) — **URGENT**. SOT: `docs/specs/2026-06-02-tma-tech-remediation-roadmap.md`.

### Pending Todos

None captured via GSD yet (workflow just bootstrapped today).

### Blockers/Concerns

External (waiting on user):

- **Real upstream API keys** — OpenAI / YandexGPT / GigaChat / Anthropic. Without them /v1/chat/completions returns mock-or-401. Highest-priority next milestone.
- **Payment integration end-to-end test** — Tinkoff sandbox keys + a successful test charge against `/api/payments/*`.
- **S3 bucket** — `aiag-storage` not created in Timeweb. Blocks Phase 5 image storage, Phase 6 uploads, Phase 7 submissions (REQ-INF-011).
- **VPS RAM** — 2GB tight (web 92MB + gateway 26MB + PG + nginx). Recommend 4GB upgrade before traffic.
- **DNS** — `www.` and `api.` A-records not added in Beget. Blocks subdomain certs.

Internal:

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

Last session: 2026-04-27 (hero animation + bug sweep — see `brain/Projects/AIAG/Sessions/2026-04-27-hero-anim-bugs.md`)
Stopped at: production stable, all 10 surveyed routes return 200 OK with zero console errors. Hero CA animation live.
Resume file: `brain/Projects/AIAG/RESUME-HERE.md`

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
