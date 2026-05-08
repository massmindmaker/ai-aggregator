# Roadmap: AI-Aggregator (AIAG)

**Bootstrapped:** 2026-04-26 from `brain/Plans/2026-04-18-plan-0{1..9}-*.md`

## Overview

MVP-путь от пустого репо до production-launch на ai-aggregator.ru. Foundation (auth + 152-ФЗ) и Design System merged в master. Infrastructure (bare-metal VPS) почти готов. Gateway / Upstreams / Marketplace / Supply активно пилятся в worktree-ветках. Launch-фаза (legal, monitoring, deploy) — финальный блокер production. Phase 9 (foreign entity) — outline, триггерится при MRR > 500k₽.

## Milestones

- 🚧 **v1.0 MVP** — Phases 1–8 (~37% complete по объёму кода, 2 фазы merged)
- 📋 **v2.0 Expansion** — Phase 9 + post-MVP backlog (foreign entity, GPU pool, mobile, MUI cleanup, Storybook)

## Phases

### Phase 1: Foundation ✓ COMPLETE

**Goal:** NextAuth v5 + 152-ФЗ consents schema + Drizzle migrations baseline so user accounts can exist.
**Depends on:** Nothing (first phase)
**Requirements:** REQ-AUTH-001, REQ-AUTH-002, REQ-AUTH-003, REQ-AUTH-004, REQ-INF-006
**Success Criteria:**
  1. User can register at `/register` with email + password and three required consents recorded with timestamps
  2. NextAuth session cookie persists across requests
  3. `pnpm drizzle-kit migrate` applies 26-table baseline schema cleanly on Postgres 16
**Plans:** 1 plan (11 tasks)
**Status:** ✓ Complete (10/11 done, Task 3 dev-server smoke deferred to post-deploy). Merged into master. Tag `v0.1.1-foundation-complete`.
**Source:** `brain/Plans/2026-04-18-plan-01-foundation.md`

Plans:
- [x] 01-01: Foundation — NextAuth + consents + initial migration

---

### Phase 2: Infrastructure ◆ IN PROGRESS (~90%)

**Goal:** Bare-metal production VPS ready to receive deploys — Postgres 16, Redis 7, Nginx + certbot, pm2, GH Actions deploy pipeline.
**Depends on:** Nothing (parallel with Phase 1, but blocking Phase 8 deploy)
**Requirements:** REQ-INF-001 .. REQ-INF-012
**Success Criteria:**
  1. `ssh aiag-vps systemctl status postgresql redis-server nginx` all green
  2. HTTPS active on `ai-aggregator.ru` apex (cert auto-renews via certbot)
  3. `git push origin master` triggers GH Actions → SSH deploy → atomic symlink flip → `pm2 reload` with rollback on healthcheck fail
  4. Daily pg_dumpall cron writes to `/var/backups/aiag/pg/<date>.sql.gz`
**Plans:** 1 plan (12 tasks, full bare-metal rewrite from original 13)
**Status:** ◆ ~90%. Tasks 1–9 done (incl apex cert). Pending: Task 10 (GH Actions deploy), Task 12 (e2e verify). Task 11 partial. Subdomain `www`/`api` certs blocked on DNS A-records (Beget). Task 8 (backup cron), 9 (monitoring minimal) ok.
**Branch:** `master` (work happens directly via SSH on VPS, see `brain/Sessions/2026-04-24-plan-02-exec.md`)
**Notes:** Major rewrite 2026-04-24 after D#13/D#14 (drop Docker/Dokploy). 1615 → 1192 lines.
**Source:** `brain/Plans/2026-04-18-plan-02-infrastructure.md`

Plans:
- [ ] 02-01: Infrastructure bare-metal — Postgres + Redis + Nginx + certbot + pm2 + GH Actions deploy

---

### Phase 3: Design System ✓ COMPLETE

**Goal:** shadcn/ui + Tailwind 4 foundation + i18n + a11y primitives so all subsequent UI phases share design tokens and accessibility helpers.
**Depends on:** Nothing (parallel with Phase 1/2)
**Requirements:** (covers UI base for REQ-MKT-* and REQ-SUP-* downstream)
**Success Criteria:**
  1. shadcn/ui components installed and styled per Supabase DS palette
  2. Inter / JetBrains fonts wired with typography scale
  3. Layout primitives (Container, Section, Stack), form primitives, advanced primitives (Accordion, Slider, Switch, RadioGroup, Progress, ScrollArea, Table)
  4. a11y helpers: VisuallyHidden, SkipLink, MobileMenu
  5. i18n scaffolding ready for Russian-first UI
**Plans:** 1 plan (15 tasks)
**Status:** ✓ Complete (12/15 merged). 3 deferred — Storybook + visual regression → Phase 2 (post-MVP). MUI cleanup on 7 legacy pages → `plan-03b` (post-MVP). Tag `v0.2.0-design`.
**Branch:** `exec/plan-03-design` (merged into master via `314397d`, branch kept)
**Source:** `brain/Plans/2026-04-18-plan-03-design.md`

Plans:
- [x] 03-01: Design System foundation — shadcn + tokens + a11y + layout + form + advanced

---

### Phase 4: Gateway v2 ◆ IN PROGRESS (~60%)

**Goal:** Hono-on-Bun gateway with billing (atomic + dual-bucket), 5 routing modes, SSE streaming, PII redaction, rate limiting — the core revenue engine.
**Depends on:** Phase 1 (auth schema), Phase 2 (Postgres/Redis on VPS)
**Requirements:** REQ-AUTH-007..009, REQ-GATE-001..019
**Success Criteria:**
  1. `POST /v1/chat/completions` with valid `Bearer sk_aiag_*` returns SSE stream from selected upstream
  2. Insufficient balance returns `402 Payment Required` with topup link, never goes negative
  3. `mode` parameter routes correctly to fastest / cheapest / balanced / ru-only / auto
  4. `X-AIAG-Upstream` header populated on every response
  5. Rate limit returns 429 + Retry-After
  6. Test suite ≥ 95% pass on routing fixtures
**Plans:** 1 plan (19 tasks, ~12 done in code)
**Status:** ◆ ~60% code-complete. Schema applied on VPS (42 tables + settle-charge fn + seeds). 2 commits pushed, 57/58 tests pass (1 routing fixture bug). Tasks 13–19 (deploy + integration) pending. Need to split WIP commit into conventional commits.
**Branch:** `exec/plan-04-gateway` (worktree `aggregator-plan-04`, pushed to origin)
**Source:** `brain/Plans/2026-04-18-plan-04-gateway.md`, exec log `brain/Sessions/2026-04-24-plan-04-exec.md`

Plans:
- [ ] 04-01: Gateway v2 — billing + routing + streaming + PII

---

### Phase 5: Upstream Adapters ◆ IN PROGRESS (~75%)

**Goal:** 7 upstream providers (OpenRouter, Together, Groq, Fal, Kie, Yandex, GigaChat) + BYOK mode behind common interface.
**Depends on:** Phase 4 (gateway interface contract)
**Requirements:** REQ-UPST-001..011
**Success Criteria:**
  1. Each adapter implements `supports / estimateCost / invoke (streaming) / healthCheck`
  2. End-to-end smoke against each upstream with seeded credentials succeeds
  3. Failover from primary to backup upstream works on healthcheck failure
  4. BYOK mode charges fixed `0.5 credits/req` regardless of upstream cost
**Plans:** 1 plan (17 tasks, ~13 done)
**Status:** ◆ ~75% code. 4 commits: base interface + openrouter + fal + WIP (together / yandex / iam token cache). ~13 tasks complete, ~4 remain.
**Branch:** `exec/plan-05-upstreams` (worktree `aggregator-plan-05`, pushed)
**Source:** `brain/Plans/2026-04-18-plan-05-upstreams.md`

Plans:
- [ ] 05-01: Upstream adapters — 7 providers + BYOK + IAM cache

---

### Phase 6: Marketplace UI ◆ IN PROGRESS (~80%)

**Goal:** Public catalog + per-model SEO pages + universal playground + dashboard + pricing page + comparison landings.
**Depends on:** Phase 3 (design system), Phase 4 (gateway for playground requests)
**Requirements:** REQ-MKT-001..013
**Success Criteria:**
  1. `/marketplace` renders ≥30 seeded models with working filters
  2. `/marketplace/[org]/[model]` SEO-friendly with code samples and pricing visible
  3. `/playground` lets unauthenticated user run 5 requests/day from IP
  4. `/dashboard/billing/topup` integrates with T-Bank invoice flow
  5. Shield-RF badge displayed on RU-residency models
**Plans:** 1 plan (19 tasks, ~15 done)
**Status:** ◆ ~80% code. 2 commits: seed catalog + filter libs + WIP (components). ~17 tasks complete, image upload + SEO landings pending.
**Branch:** `exec/plan-06-marketplace` (worktree `aggregator-plan-06`, pushed)
**Source:** `brain/Plans/2026-04-18-plan-06-marketplace.md`

Plans:
- [ ] 06-01: Marketplace UI — catalog + playground + SEO + dashboard

---

### Phase 7: Supply Side ◆ IN PROGRESS (~50%)

**Goal:** Open ML contests with leaderboards + sandboxed eval-runner + tiered revshare + monthly settlement + payout flow.
**Depends on:** Phase 5 (upstream adapters for evaluating contest-derived models)
**Requirements:** REQ-SUP-001..015
**Success Criteria:**
  1. Contest creation → submission upload → eval-runner scoring → leaderboard update flow works end-to-end
  2. Predictions CSV/JSON validated and scored in sandbox (`systemd-run` + `unshare` + `ulimit`)
  3. Private score hidden from author until contest close (invariant)
  4. Tiered revshare correctly routes 70/75/80/85% to author per tier
  5. Monthly settlement cron writes accruals to author balance
  6. Author can request payout ≥ 1000 ₽ with 13% withholding for физлицо
**Plans:** 1 plan (22 tasks, ~11 done in code)
**Status:** ◆ ~50% code. Branch active. SECURITY-TODO marked for Phase 2 nsjail upgrade.
**Branch:** `exec/plan-07-supply` (worktree `aggregator-plan-07`, pushed)
**Source:** `brain/Plans/2026-04-18-plan-07-supply.md`

Plans:
- [ ] 07-01: Supply — contests + submissions + eval + revshare + payouts

---

### Phase 8: Launch ○ STARTED (agent died)

**Goal:** Production launch readiness — legal pages (privacy, terms, contest rules, author agreement), РКН-уведомление, monitoring stack (prometheus/grafana/loki bare-metal via apt+systemd), deploy pipeline finalization, pre-launch verification.
**Depends on:** Phases 2, 4, 5, 6, 7 (everything must be deployable + monetizable + compliant)
**Requirements:** REQ-LEG-001..008, REQ-OPS-001..005, REQ-INF-008, REQ-INF-010
**Success Criteria:**
  1. All `/legal/*` pages live and link from footer
  2. РКН-уведомление подано (доказательство — копия acknowledgement)
  3. Prometheus + Grafana + Loki running as systemd services on monitoring VPS
  4. Telegram alerts firing for synthetic test conditions (high latency, error rate, disk)
  5. End-to-end smoke: register → topup → API call → invoice received → payout triggered
  6. Pre-launch checklist signed off (load test, security scan, DR drill)
**Plans:** 1 plan (20 tasks, status check needed)
**Status:** ○ Started but agent died (rate limit). Need to resume via `/gsd:resume-work` or restart with fresh context.
**Branch:** `exec/plan-08-launch` (worktree `aggregator-plan-08`, pushed)
**Notes:** Original docker-compose monitoring stack rewritten to apt + systemd post-D#13.
**Source:** `brain/Plans/2026-04-18-plan-08-launch.md`

Plans:
- [ ] 08-01: Launch — legal + monitoring + РКН + deploy + pre-launch verification

---

### Phase 9: Foreign Entity ○ DEFERRED

**Goal:** International expansion — foreign legal entity (UAE / Cyprus / Estonia), Stripe/Paddle integration, USD billing tier, cross-border data agreement.
**Depends on:** Phase 8 (production launch + revenue traction)
**Requirements:** REQ-FOR-001..004 (v2)
**Success Criteria:**
  1. Foreign entity registered with bank account
  2. Stripe / Paddle accepting non-RU customers
  3. USD billing tier available alongside RUB
  4. Cross-border data flow documented and compliant
**Status:** ○ Outline only (Phase 2 trigger: MRR > 500k₽ sustained 3 months)
**Source:** `brain/Plans/2026-04-18-plan-09-foreign-entity-outline.md`

Plans:
- [ ] 09-01: Foreign entity outline — research + entity setup + payment integration

### Phase 10: User Self-Service Dashboard — keys CRUD with per-key cost limits, usage analytics, billing extension, supply submit-model

**Goal:** [To be planned]
**Requirements**: TBD
**Depends on:** Phase 9
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 10 to break down)

### Phase 11: Admin Panel Complete — users, orgs, upstreams health/keys, contests CRUD, settings, audit log, payouts approval, webhooks retry

**Goal:** [To be planned]
**Requirements**: TBD
**Depends on:** Phase 10
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 11 to break down)

### Phase 12: Admin Critical Views — request inspector + routing matrix + async jobs + business dashboard

**Goal:** [To be planned]
**Requirements**: TBD
**Depends on:** Phase 11
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 12 to break down)

### Phase 13: Growth Foundation — referral system + promo codes + cohort retention dashboard

---

### Phase 14: Contest → Marketplace Admin ◆ ADMIN HALF CODE-COMPLETE — DEPLOY BLOCKED

**Goal:** Admin-only flow для публикации модели победителя конкурса в marketplace + revshare accrual + payout queue + KYC review + freeze controls. Author-side (consent, /me/kyc, payout request, dashboard earnings) — отложено в Phase 14b.

**Depends on:** Phase 7 (Supply), Phase 11 (Admin Panel), Phase 12 (Admin Critical Views)
**Requirements:** REQ-CONTEST-001..003, REQ-CONTEST-005, REQ-PAYOUT-001..004, REQ-KYC-001..003 (TBD — derive from spec §3.1-3.6; 004 dropped as placeholder, consents → 14b)
**Success Criteria:**
  1. Cron `closeContestsCron` финализирует scores и создаёт `prize_awards` записи
  2. `/admin/contests/[slug]` имеет publish-modal — admin может опубликовать submission как model в `pending_author_consent`
  3. Каждый settled gateway-call авто-инсертит `author_earnings` с правильным sticky tier_pct
  4. `/admin/payouts` queue с manual approve + auto-approve cap (20k₽ дефолт) + tax_withheld расчёт
  5. `/admin/kyc-queue` — admin approve/reject документы (3 пути: НПД / ИП / физлицо)
  6. `/admin/models/[id]` имеет freeze/depublish controls для деградирующих моделей
  7. Migration `0014_contest_marketplace.sql` идемпотентна, применяется на VPS Postgres
**Plans:** 7 plans (3 waves)
**Status:** ◆ Admin half code-complete on master (commits 2b537ae..f9d0f2c). Migration 0014 applied + idempotent on prod VPS. Deploy pipeline blocked on pre-existing CI debt — see `.planning/phases/14-contest-marketplace-admin/14-07-SUMMARY.md`. Author-side flows + deploy fix → Phase 14b.
**Source:** `docs/superpowers/specs/2026-05-08-phase14-contest-marketplace-workflow-design.md`

Plans:
- [x] 14-01-schema-migration-PLAN.md — Migration 0014 + drizzle schema + tier_pct fn + accrue hook ✓ applied on VPS
- [x] 14-02-crons-PLAN.md — closeContestsCron + finalizeEarningsCron in worker ✓ on master
- [x] 14-03-admin-publish-modal-PLAN.md — /admin/contests publish modal + API ✓ on master
- [x] 14-04-admin-payouts-extended-PLAN.md — /admin/payouts queue extend + tax + approve/reject ✓ on master
- [x] 14-05-admin-kyc-queue-PLAN.md — NEW /admin/kyc-queue page + approve/reject ✓ on master
- [x] 14-06-admin-models-freeze-PLAN.md — /admin/models freeze/depublish + gateway 503 ✓ on master
- [~] 14-07-deploy-and-verify-PLAN.md — Migration applied ✓; GH deploy + smoke BLOCKED on CI pipeline (route eager-DB-init, see 14-07-SUMMARY)

---

## Progress

**Execution Order:** Phases run in numeric order in principle. Currently 4/5/6/7 are running in parallel worktree-branches (Phase 8 blocked until they finish). Phase 2 must complete before Phase 8 deploy can succeed.

**Dependency Graph:**

```
Phase 1 (Foundation) ──────┐
                           ├──→ Phase 4 (Gateway) ──→ Phase 5 (Upstreams) ──┐
Phase 2 (Infrastructure) ──┤                                                 │
                           ├──→ Phase 6 (Marketplace) ←── Phase 3 (Design)   ├──→ Phase 8 (Launch)
Phase 3 (Design) ──────────┘                                                 │
                                                        Phase 7 (Supply) ────┘
                                                                                    │
                                                                                    ▼
                                                                              Phase 9 (Foreign Entity)
                                                                              [trigger: MRR > 500k₽]
```

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation | v1.0 | 1/1 | Complete | 2026-04-22 (tag v0.1.1) |
| 2. Infrastructure | v1.0 | 0/1 | In progress (~90%) | — |
| 3. Design System | v1.0 | 1/1 | Complete | 2026-04-24 (tag v0.2.0) |
| 4. Gateway v2 | v1.0 | 0/1 | In progress (~60%) | — |
| 5. Upstreams | v1.0 | 0/1 | In progress (~75%) | — |
| 6. Marketplace | v1.0 | 0/1 | In progress (~80%) | — |
| 7. Supply | v1.0 | 0/1 | In progress (~50%) | — |
| 8. Launch | v1.0 | 0/1 | Started (agent died) | — |
| 9. Foreign Entity | v2.0 | 0/1 | Deferred | — |

**Overall MVP completion:** 2 of 8 phases shipped. ~37% of code complete weighted by tasks across in-flight branches.
