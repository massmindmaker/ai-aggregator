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

### Phase 15: Telegram Mini App ◆ SHIPPED (with critical debt)

**Goal:** Standalone Telegram Mini App = AI agents marketplace (`apps/tg-miniapp` + `apps/agent-worker`) — discover/run/create agents that work in Telegram, with TON/NFT monetization.
**Depends on:** Phase 4 (gateway), Phase 5 (upstreams)
**Status:** ◆ Shipped (commit 88f5eab). Built: HMAC initData→JWT auth (middleware verify); agents CRUD + 6 templates; streaming tool-loop execution + history + daily budget; image_gen via Fal; NFT marketplace via Startonus + TON Connect; agent-worker (BullMQ + ioredis + postgres); Telegram DM notifications; nginx vhost (`/tg`, pm2 `tma`). Migrations 0016–0022 + 0026 (provider catalog).
**Critical debt (see `docs/specs/2026-06-02-tma-tech-stack-108-eval.md`, score 50/108):** agent runs bypass the `:4000` gateway → no markup + `tg_user_balances` never debited (free inference); CVE-2025-29927 (Next 14.2.15) auth-bypass; jUSDT 1000× overpay risk; migration 0026 unwired in worker; zero tests/observability on the money path. → **remediated in Phase 15.1 (R0)**.
**Source:** `docs/superpowers/specs/2026-05-08-phase15-tg-miniapp-design.md`

Plans:
- [x] 15-01..08: scaffold · verify-init+JWT · agents CRUD · agent-worker · TON Connect · marketplace-mini · deploy+notifications · NFT-Startonus (see `.planning/phases/15-tg-miniapp/`)

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

### Phase 15.1: R0: TMA billing + identity truth (emergency fixes from the 108-eval) — gateway routing for aiag runs + per-run balance debit/gate, atomic daily-spend, CVE-2025-29927 patch + JWT hardening, wire migration 0026 in worker. SOT: docs/specs/2026-06-02-tma-tech-remediation-roadmap.md (INSERTED)

**Goal:** Make the shipped TMA safe to put traffic on — aiag agent runs route through the :4000 gateway (markup + white-label), every run debits the prepaid balance atomically and is gated on funds, the daily budget holds under concurrency, the CVE-2025-29927 auth-bypass is patched with hardened JWT verification, and the 0026 provider picker actually routes. Verified on the VPS.
**Requirements**: R0-1, R0-2, R0-3, R0-4, R0-5, R0-6 (from docs/specs/2026-06-02-tma-tech-remediation-roadmap.md)
**Depends on:** Phase 15
**Plans:** 3 plans (3/3 complete)
**Status:** ✓ Complete — all 3 plans done (2026-06-02). VPS deploy + green integration run deferred (no-local-runtime). Branch `plan/15.1-r0-billing-identity` ready for merge.

Plans:
- [x] 15.1-01-PLAN.md — Worker money path: route aiag→:4000 gateway (R0-1), per-run balance debit+gate (R0-2), atomic daily-spend (R0-3), wire 0026 provider columns (R0-6) + unit tests [wave 1] — ✓ 2026-06-02
- [x] 15.1-02-PLAN.md — TMA auth hardening: Next≥14.2.33 + nginx strip for CVE-2025-29927 + HS256-pinned jwtVerify + JWT denylist (R0-4), fail-hard TMA_JWT_SECRET (R0-5) [wave 1] — ✓ 2026-06-02
- [x] 15.1-03-PLAN.md — Integration test of enqueue→worker→settle→balance-debit atomicity (R0-1/2/3) [wave 2, depends 15.1-01] — ✓ 2026-06-02

---

## Milestone: R1 — Money-correct foundation + providers + managed-Hermes test

**Added:** 2026-06-03 — re-cut from `docs/specs/research/SYNTHESIS.md` (lead-architect synthesis of R-01..R-12 + adversarial reviews) and `docs/specs/2026-06-03-monetization.md`. Founder decisions: `CLAUDE.md` §"Founder decisions (2026-06-02/03)".

**Predecessor:** ✓ **R0 (Phase 15.1) COMPLETE + LIVE on prod** — TMA money path made safe to put traffic on (gateway routing for aiag runs, per-run balance debit/gate, atomic daily-spend, CVE-2025-29927 patch + JWT hardening, 0026 picker wired). Branch `plan/15.1-r0-billing-identity` (not yet merged to master).

**Thesis (SYNTHESIS §0):** *the money path is the product.* Almost every research item is a question about money-correctness, and four (R-06/07/08/11) are blocked on one fork — **where margin is computed and which ledger is authoritative**. So R1 has two spines: (1) fix the single billing authority and make the gateway return realized margin **before** building anything that pays anyone; (2) keep the crypto deposit *surface* founder-gated (FD-1) while building the *plumbing* (correct under both Stars-and-crypto structures). Everything else layers on top.

**Founder gates that bound this milestone:**
- **FD-1 — Stars-vs-crypto surface (THE blocker).** Resolved direction (founder 2026-06-03): **multi-crypto now (TON + others), Stars deferred** (do not implement/show). Gates the deposit *UX/currency surface* (R1.2 jetton UX, R1.3 delivery inbound), NOT the ledger/reconciler/jetton *plumbing* (safe to build either way).
- **FD-2 — withdrawable vs non-withdrawable credits (OPEN).** Decides creator cash-out and user withdrawals → gates the *withdraw* leg of R1.3 author economy; author-rent accrual itself can ship (fixed author-set sum, deterministic).
- FD-3 (entity split / PD-localization), FD-5 (inbound-billing for Business chat), FD-6 (Gonka fee treatment), FD-7 (talking-vs-ambient character default), FD-8 (x402 rail) — gate specific deliverables noted per phase.

### Phase R1.0: Money-correctness foundation ◆ IN PROGRESS (on branch)

**Goal:** Make realized margin a number the worker can read and make the credit unit honest — the keystone that unblocks every paying feature (D-5, D-6, D-8/D-9, D-11, D-12).
**Depends on:** R0 (Phase 15.1)
**Build order:** SYNTHESIS Wave 0
**Deliverables:**
  1. **D-0 single billing authority + gateway-returns-margin** — `tg_user_balances` is the only TMA ledger; the `:4000` gateway returns per-request charged + upstream cost (or `margin_credits`) keyed by `gateway_request_id`; worker stops billing off `estimateCostRub` on the gateway path. Invariants `margin ≥ 0`, `author_share ≤ margin`; accrue 0 when margin unavailable (never guess).
  2. **D-1 USD micro-credit anchor + `tg_ledger_entries`** — `1 credit = 1 USD` as `BIGINT` micro-USD; double-entry ledger + materialized projection; kill `USD_TO_RUB = 90` (both copies incl. `budget.test.ts:7`); ₽ becomes display-only via CBR. Live-balance migration is freeze-window + conservative + idempotent + dry-run SUM-invariant on a prod dump first (RK-8).
  3. **D-8 initData hardening** — manual `timingSafeEqual` patch + `TMA_INITDATA_MAX_AGE_SEC` 600s + Redis one-shot nonce (do NOT trust the dependency's `!==` compare). ✓ **done on branch.**
  4. **D-7 `safeFetch` egress guard** — resolve-then-pin, full blocked-range set, re-validate per redirect, allowlist `127.0.0.1:4000` + `openrouter.ai`. ✓ **done on branch (R0).**
  5. **`DEFAULT_MODEL` registry fix** — seed+assert one controlled slug (the `nousresearch/hermes-4-405b` 400). ✓ **done.**
**Founder gate:** none blocks R1.0 — it is pure engineering correctness and is the prerequisite for everything gated below.
**Risks:** RK-2 (margin authority single point of failure), RK-8 (manual prod migrations, app role can't ALTER).

### Phase R1.1: Deposits + tool money 📋 PLANNED

**Goal:** Reconnect the deposit and tool money paths and add the first new provider — all without any crypto-legal dependency.
**Depends on:** R1.0 (D-0 margin must be readable before tool/provider billing)
**Build order:** SYNTHESIS Wave 1
**Deliverables:**
  1. **D-4 Gonka Track 1** — `gonka.ts` (copy `openrouter.ts`), seed `model_upstreams` + a fallback row, register `Qwen3-235B…FP8`, discover the rest at runtime, white-label strip. Fastest "new provider" win; validates the D-6 seams.
  2. **D-9 tool broker (R-08a)** — `tools` catalog + `tool_calls` ledger, `(run_id, llm_call_id)` idempotency, Firecrawl first, refund-on-error. Closes a confirmed unbilled-tool leak. **Must** atomically increment `spent_today_rub` with the same guarded UPDATE (daily-budget-bypass fix).
  3. **R-04 deposit reconciler** — server-side `lt`-watermark cron (authoritative) + TonAPI webhook (push wake) + client poll demoted to UX. Fixes the four documented funds-loss modes. Correct under both Stars and crypto structures.
  4. **D-6 catalog-sync + native adapters + BYOK unification** — daily BullMQ sync from `models.dev` into the gateway `models`/`model_upstreams`; **`/1M → /1k` conversion at sync time + CI assertion** (the 1000× money bug); native Anthropic adapter + Google-via-OAI base; route **all** native-protocol traffic (AIAG-supplied AND BYO) through the gateway; unify the two BYOK mechanisms; strip `X-AIAG-Upstream` for native adapters.
**Founder gate:** **FD-6** (Gonka 5%+10% fee — absorb vs surface) tunes D-4 pricing but does not block the build. No FD blocks the phase.
**Risks:** RK-5 (white-label leakage per adapter), RK-1 (do NOT co-locate opengnk proxy on the 2 GB prod box).

### Phase R1.2: Jetton + real runtime + delivery 📋 PLANNED

**Goal:** Real on-chain USDT deposits, a real agent runtime layered onto the existing loop, and (gated) Telegram delivery.
**Depends on:** R1.1
**Build order:** SYNTHESIS Wave 2
**Deliverables:**
  1. **R-04 jetton USDT-on-TON** — corrected `0x0f8a7ea5` transfer-init shape, `forward_ton_amount ≥ 0.05 TON`, master allowlist + `get_wallet_address` fake-jetton defense, per-user deposit addresses (the real loss-mode-2 fix).
  2. **D-5 real AI-SDK runtime** — `ai` + `@ai-sdk/openai-compatible` with `baseURL=127.0.0.1:4000`; pgvector in our Postgres for memory; OTel → Grafana Cloud free tier. **Gate:** do NOT stream the billed call (`usage: null` risk → ₽0 settle); re-implement mid-run budget cutoffs via `onStepFinish`; fall back to `estimateCostRub` (never 0) when usage missing; defer bot streaming.
  3. **D-11 MCP (re-sequenced)** — `agent_tokens` table + minting endpoint FIRST (the "per-agent bearer" does not exist today), then inbound zero-cost tools only (`calc`/`memory`), then the outbound Notion OAuth showcase via `@modelcontextprotocol/sdk`. Do NOT run an Authorization Server or `mcp-context-forge` (won't fit 2 GB).
  4. **D-13 grammY delivery (R-10 phase 3)** — grammY Business mode as a separate `apps/tg-bot` pm2 process; reuse the `agent-run` pipeline; deliver-after-settle; pass `business_connection_id` explicitly.
**Founder gates:** **FD-1** gates the jetton *deposit UX surface* (resolved=crypto-now, so the surface is in scope; plumbing was already safe). **FD-5** (who-pays for Business-chat answers) is a hard precondition for D-13; **FD-1** Premium-reach number may favor bring-your-own-bot-token.
**Risks:** RK-1 (pgvector HNSW build RAM on 2 GB — bound rows, measure RSS), RK-3 (ToS wall on the crypto surface), RK-7 (MCP SDK / TON shape drift — pin + re-verify).

### Phase R1.3: Managed-Hermes test + creator economy 📋 PLANNED / R&D-GATED

**Goal:** De-risk managed-Hermes with a measurement spike before committing infra, then ship the author-rent creator economy and the character pipeline.
**Depends on:** R1.0 (D-0 margin) for the creator accrual; R1.2 for runtime/delivery substrate
**Build order:** SYNTHESIS Wave 3
**Deliverables:**
  1. **D-2/D-3 Managed-Hermes Phase-0 spike** — stand up ONE real Hermes with `backend: daytona` pointed at `:4000` on the **~18 GB shared VPS** (founder 2026-06-03); **measure resident-gateway RAM + whether one gateway multiplexes many users** (the real cost question), resume latency, a week's bill. Build the provisioner only if the measurement says the resident-orchestrator cost is acceptable → then tier (dedicated for high-payers, shared for ~$20-tier). Sidecar control-plane (D-3, loopback `/api/*`, no token-capture, `--no-open --host 127.0.0.1` NO `--insecure`) for closed beta ≤20 agents.
  2. **D-12 creator economy (author-rent, per `2026-06-03-monetization.md`)** — substrate (publish/clone/lineage tables) first, then accrual. **Author rent = pass-through, NO % cut**: renter pays the exact author-set sum (free OR priced, e.g. monthly), author receives it in spendable `tg_user_balances` credits; AIAG earns only on model markup + tools + deploy. Anti-abuse: rank by realized usage from distinct *funded* renters, self-deal exclusion, single-hop attribution, per-author slug namespace, dust floor. Author-payout sweep is a **separate pass** from the renter debit (lock ordering). Exclude BYOK-fixed-fee runs.
  3. **D-14 character pipeline** — reference-sheet anchor → nano-banana-pro portrait → kling-2.6 ambient loop → ElevenLabs voice → optional Kling-Avatar talking card. Fix **three** input-shape gaps (image `image_input[]`, video `image_urls[]`+`sound`, audio remap); edit ONLY `api-gateway/src/upstreams/kie.ts`; gate the talking card behind a verified schema; re-host Kie assets to our S3/CDN; ship ambient first.
**Founder gates:** **FD-2** (withdrawable credits — OPEN) gates author *cash-out/withdraw*; rent accrual ships regardless. **FD-3** (entity split / PD-localization) gates managed-Hermes for *real* users ($-billed compute on the foreign entity). **FD-4** (default `author_share_bps`) — N/A under the pass-through author-rent model but tunable if a platform fee is ever added. **FD-7** (talking-vs-ambient default, stock vs cloned voice — recommend ambient + stock + founder-owned faces).
**Risks:** RK-1 (resident orchestrators 300–600 MB each — the 2 GB→18 GB box is the binding constraint; "needs a second/bigger box" is the honest answer), RK-4 (two-entity legal boundary), RK-6 (secrets isolation inside the agent boundary).

### Deferred / R&D (explicitly not in R1)

- **D-10 x402 outbound** — defer to real demand (FD-8); fix the custody model (facilitator = gas-only; separate hard-capped spend wallet) when built.
- **Gonka opengnk self-host (Track 2a)** — off the prod VPS (separate host or skip).
- **Gonka Track 2b** (raw user secp256k1 keys), **template cash-out** (FD-2), **MCP Authorization Server**, **Mastra**, **Helicone/SigNoz self-host**, **mcp-context-forge** — gated on a second box or a legal structure that does not yet exist.
