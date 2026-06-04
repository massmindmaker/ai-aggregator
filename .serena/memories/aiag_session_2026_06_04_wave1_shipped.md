# AIAG session 2026-06-04 — R1 money foundation + Wave-1 monetization SHIPPED

**One-line:** in one long autonomous session, the entire money foundation (D-0+D-1) and the
full author-rent monetization marketplace (Wave-1 Slices 1-3) + creator economy + scheduled
runs were BUILT, adversarially reviewed, deployed to prod, and gold-verified with minted JWTs.
Everything lives on branch `feat/r1.0-wave0-consolidated` (NOT merged to master). Driver mode,
multi-agent workflows + "verify everything" discipline.

## SHIPPED + LIVE on prod (every piece gold-verified)
- **D-1 USD-credit ledger** (341d56e): ₽ killed, `USD_TO_RUB=90` gone; 1 credit = 1 US cent
  (BIGINT). Migration 0029 renamed balance_rub→balance_credits etc. (COUNT=0 guard, applied on
  empty prod) + append-only `tg_ledger_entries`. settleRun atomic (guarded UPDATE…WHERE
  balance_credits>=cost RETURNING + ledger co-committed). **D-0** gateway-margin live.
- **Wave-1 Slice 1** (ca85b33): migration 0031 `agent_templates` (ZERO secret columns by design),
  publish/templates/[id]/clone routes + /templates catalog+detail. Paid→402 (no free clone of paid).
- **Wave-1 Slice 2** (a6e0499): migration 0032 (template_rentals + rent_charges + uq_rental_active
  + CHECK>0). `POST templates/[id]/rent` = WHOLE rent in ONE sql.begin (claim slot via ON CONFLICT →
  guarded debit renter → upsert-credit author 100% pass-through → 2 ledger entries equal-and-opposite,
  **0% AIAG cut** → clone agent INSIDE the tx → bind + clone_count++). First review caught a split-tx
  HIGH (clone in separate tx → charged-with-no-agent); rewrote to single-tx; re-review GO.
- **Wave-1 Slice 3** (dca8540): GET me/author-income (scoped to authed author) + /profile/income page.
  Withdraw = honest «скоро» (FD-2 deferred). catch→500 not zeroed-200.
- **Creator economy** (2f9035e): migration 0033 template_ratings (stars 1-5, eligibility-guarded:
  must have cloned/rented), catalog ?sort=trending|top|new, avg_rating, «⑂ Форк от X» remix-lineage.
- **Scheduled agent runs** (2955693): migration 0034 agent_schedules (interval≥15 CHECK, FK CASCADE).
  Worker scheduler.ts = 60s setInterval tick → claimDueSchedules (atomic UPDATE…WHERE next_run_at<=now()
  AND EXISTS(agents active) RETURNING) → enqueues a NORMAL run (existing budget guards, no new billing).
- **₽→кр relabel** (6e32aa7) in the agents UI. White-label hardened. Repo PRIVATE. Security review passed.

## 8 bugs caught by adversarial review / on-prod verify BEFORE reaching users
1. agent-CRUD regression — tg-miniapp agent routes still read budget_rub_monthly/cost_rub after 0029
   renamed them → 500. Fixed by aliasing (2b4c630).
2. catalog/detail 401 — pages fetched without the JWT Bearer header. Fixed (ca85b33).
3. Slice-2 split-tx HIGH — clone in a separate tx → renter charged with no agent. Rewrote to single-tx.
4. tool-fee unit bug — KIE_COST_RUB=6.5 float (rubles) into integer credit ledger → fixed to KIE_COST_CREDITS=8.
5. Slice-3 fake-zero — income route returned 200+zeros on DB error → returns 500.
6. ratings BLOCKER — eligibility trusted agents.template_kind which the create route copied from the
   request body → forgeable. Fixed: create route strips client `tpl:` kind (server-trusted provenance).
7. self-rating HIGH — author could 5★ own template. Fixed (rate route rejects author==rater).
8. scheduled-runs HIGH — soft-deleted agent kept firing billable runs. Fixed (claim gates on agents.status='active').

## Prod migrations applied (manual, sudo -u postgres psql aiag): 0029, 0031, 0032, 0033, 0034.
(0030 gonka seed committed but NOT applied — Gonka inert until founder's key.)

## WHERE WE STOPPED — 4 walls, ALL need the founder (genuine "до упора")
1. **Provision ~16GB Hermes box** → managed-Hermes runtime (the REAL Wave 2/3 core; 2GB VPS hosts 0-1
   instances). Honest spike plan: `docs/specs/2026-06-04-managed-hermes-spike-plan.md`. Go/no-go: idle
   RSS >800MB ⇒ shared multi-tenant not viable at $20 tier ⇒ stay connect-your-own-Hermes. (Recurring paid box.)
2. **FD-2** (withdraw decision) → author cash-out (Slice-3 full).
3. **GonkaGate key + 5 process tasks** → Gonka provider (`docs/specs/2026-06-04-gonka-action-plan.md`).
4. **Jetton wallet config** → USDT/multi-crypto top-up.

Buildable-without-box list (the spike plan): creator economy ✅, scheduled runs ✅, jetton (needs founder
crypto config), connect-your-own-Hermes (exists). Dream path = 4.7/5.

## Deploy recipe reminders
- gh workflow_dispatch deploy-production.yml --ref <branch> -f ref=<branch> -f apps=tma|agent-worker|gateway
  → builds + swaps + pm2 FAILS (procs root-owned, deploy user aiag) → manual `pm2 restart <app>` as root.
- SSH: `ssh -o ProxyCommand=none -i ~/.ssh/timeweb_vps root@5.129.200.99` (intermittent banner-timeout, retry).
- Gold-verify pattern: mint an HS256 JWT on the VPS with TMA_JWT_SECRET (sub/iss=aiag-tma/aud=aiag-gateway)
  + curl the endpoint. Proves middleware→route→DB end-to-end.
- Migrations additive (0031-0034): apply via `sudo -u postgres psql aiag -f <release>/packages/database/migrations/...`.

See also: aiag_d0_moneypath_verified_2026_06_03, aiag_product_canon_2026_06_02, aiag_decisions_2026_06_03.
Auto-memory: ~/.claude/projects/.../memory/project_money_foundation_live.md (the cross-session pointer).
