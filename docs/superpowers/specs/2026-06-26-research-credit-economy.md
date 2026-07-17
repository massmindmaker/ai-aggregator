# Credit Economy Coherence Audit (TMA prepaid credits)

**Date:** 2026-06-26
**Scope:** end-to-end clarity/coherence of the TMA prepaid credit loop (top-up → spend → author-rent → settle → payout).
**Method:** read the real money-path code (no local runtime, per `feedback_no_local_runtime`). Light web best-practice cited where used.
**Mandate:** clarity fixes only — **no new features**. Flag bugs, don't change the `settleRun` formula.

**Verdict (one line):** The core money loop is **coherent and mechanically sound** — one consistent credit unit (US cents, `1 кр = $0.01`), atomic debits/credits with guarded `UPDATE … WHERE … RETURNING`, idempotent ledger, 0% on author rent wired correctly. The ×100 bug is **fixed and verified**. The weak spots are **display/labeling gaps and one accounting ambiguity** (income spendable in-app AND withdrawable), not the core math.

---

## 1) How the loop works today (with file:line)

### Unit
- Canonical unit = **integer US cents**, `1 credit (кр) = $0.01`, stored BIGINT. Declared in `apps/agent-worker/src/db.ts:25`, `:54-57`.
- Display contract = cents ÷ 100, `ru-RU`, 2 decimals, suffix `кр`. Single helper `apps/tg-miniapp/src/lib/credits.ts:7-14` (`fmtCredits`). Input parse (credits→cents) `credits.ts:18-27` (`parseCreditsInput`).

### Top-up (TON / USDT → credits)
- Init: `app/api/tma/topup/init/route.ts`. MIN 100 cr ($1) / MAX 50 000 cr ($500) `:22-23`. TON branch uses an **oracle rate** (`getTonUsdRate`) `:94-107`; USDT-on-TON branch is a **fixed peg, no oracle** — `1 USDT = 100 кр`, `USDT_UNITS_PER_CENT = 10_000n` `:26-29`, `:184-275`.
- Reconcile + credit: `app/api/tma/topup/check/[id]/route.ts:137-168` — atomic confirm + balance UPSERT + `topup` ledger row in one `sql.begin`, idempotent via `status='pending'` re-check + `uq_ledger_ref`.
- UI: `app/profile/topup/page.tsx` (presets $2/$5/$10/$20 `:61`, asset segment, USDT soft-degrade to TON `:182-187`, client-poll 10 min `:125-147`).

### Spend (run = debit + markup on AIAG model; BYOK = 0)
- Runtime loop: `apps/agent-worker/src/agent-runner.ts`. Upstream resolution `:134-206` (hermes-managed / provider-picker / external BYOK / aiag-gateway, with OpenRouter degraded fallback).
- Commission rule: BYOK/external → `isExternal=true` → cost forced to 0 (`finalBillableCostCredits` `:448-451`; `settleRun` short-circuit `db.ts:703`).
- Markup authority = the `:4000` gateway returns authoritative charged/upstream-cost micro-USD headers `:68-69`, `:339-345`, `:380-394`; fallback to local `estimateCostCredits` `:430-434` when headers absent (never 0).
- Budget gates: monthly (user) `:584-590`, daily (agent, atomic reset) `:591-596` + `db.ts:281-301`, run-start balance floor `MIN_RUN_COST=1` `:640-649`.
- Atomic settle: `db.ts:678-739` — markCompleted + guarded daily-spend increment + guarded balance debit + `run_debit` ledger row, all in one `sql.begin`.

### Create gate (NFT membership)
- `app/api/tma/membership/route.ts` — `GET` reports membership; `POST` syncs from on-chain NFT ownership (best-effort, never 500s `:53-66`).

### Author-rent (monthly subscription, AIAG 0%)
- Rent route: `app/api/tma/templates/[id]/rent/route.ts`. Entire rent in ONE tx `:142-290`: rental row → charge → **guarded renter debit** `:197-206` → **author credit (UPSERT, 100% pass-through)** `:210-217` → two equal-and-opposite ledger rows (`rent_debit` / `rent_credit`, no platform-fee line) `:222-237` → agent clone `:258-289`. Self-deal guard `:85-87`, negative/zero price guard `:93-96`, idempotency via `uq_rental_active` `:170-178`, renewal path (shift period, no re-clone) `:239-250`.
- Worker subscription guard (period-scoped spend limit, additive) `agent-runner.ts:598-622`, `:796-801`; `db.ts:225-275`.
- Free clone: `app/api/tma/templates/[id]/clone/route.ts` — free only; a priced template returns `402 rent_not_available_yet` `:49-51`.

### Author payout (scaffold, OFF)
- `app/api/tma/me/author-income/route.ts`: `GET` is read-only display `:38-174`; `POST` records a `pending` payout + an off-chain `author_payout` ledger debit row `:192-275`. Actual USDT send is flag-gated (`TON_PAYOUTS_ENABLED`) in the worker batch — no-op while off `:178-183`.
- UI: `app/profile/income/page.tsx` — totals + per-template breakdown + honest «Вывод средств — скоро» disabled button `:265-274`.

### Money-movement ledger (single source of truth)
- `app/api/tma/ledger/route.ts` — append-only `tg_ledger_entries`, kinds `topup / run_debit / rent_debit / rent_credit / transfer_debit / transfer_credit` `:18-23`. Wallet renders it `app/wallet/page.tsx:290-379`.

---

## 2) Clarity / coherence issues (severity + file:line)

### HIGH

**H1 — Income is double-counted: spendable in-app AND withdrawable.**
`rent_credit` lands in `tg_user_balances.balance_credits` (rent route `:210-217`) → it is spendable on runs/rent immediately. The income page even advertises this: «Доход уже можно тратить внутри приложения» (`income/page.tsx:270-273`). BUT the payout "available" calc is `Σ rent_credit − Σ author_payouts(non-failed)` (`author-income GET :123-134`, `POST :218-233`) — it does **not** subtract income the author already SPENT in-app. So an author who earns 100 кр, spends it on runs, can still request a 100 кр payout. The off-chain `author_payout` ledger row (`POST :247-254`) does NOT touch `tg_user_balances`, so the cached balance and the "available to withdraw" figure are two disconnected truths.
*Impact:* with payouts OFF today this is latent, but it is a **real over-pay exploit the moment `TON_PAYOUTS_ENABLED=true`.* It is also confusing now: "available_income" can exceed actual spendable balance.
*Fix is clarity + 1 guard — see §3 F1. (Founder-level money decision flagged, not changed.)*

**H2 — `author_payout` ledger kind has no Russian label.**
Ledger route returns `author_payout` rows (and the spec comment lists kinds), but `LEDGER_LABEL` in `wallet/page.tsx:42-49` maps only 6 kinds — `author_payout` is **missing** → the wallet history shows the raw English string `author_payout`. Brand/tone rule (PRODUCT.md: Russian, tight) is broken on a money line. (The income page `kindLabel` `:52-54` only handles `rent_credit`, everything else falls through to raw kind too.)
*Fix: §3 F2 (one-line map entry).*

### MEDIUM

**M1 — No cost preview / total before RENT or CLONE; only the price is shown.**
The template detail page shows the rent price (`templates/[id]/page.tsx:320`) but the renter is **never told the running model cost is extra** until they're inside the agent. The economy is "rent price + model markup per run + (deploy/tools later)", but the rent CTA implies the price is the whole cost. The run screen DOES preview model tariff well (`agents/[id]/page.tsx:1329-1335`) — that clarity should exist at the rent decision too.
*Fix: §3 F3 (copy line under the rent CTA).*

**M2 — "наш шлюз · с наценкой" pill names markup but never quantifies it anywhere user-facing.**
`agents/[id]/page.tsx:737-751`. A user can see "with markup" and the per-1M-token tariff (`:1331-1334`), but cannot tell what AIAG's cut is vs upstream — the realized margin exists only in worker logs (`agent-runner.ts:818-824`). That's fine for white-label, but the user has **no single "what AIAG takes" statement** anywhere. Coherence gap vs the audit goal "can a user tell what AIAG takes".
*Fix: §3 F4 (a one-line economy explainer; no numbers leak needed).*

**M3 — `finalBillableCostCredits` floors every billable run to ≥1 кр, but the run cost preview says "От 1 кр за прогон" only when `modelRate` is present.**
`agents/[id]/page.tsx:1329-1336` — if `model_rate` is null (registry miss) the whole preview line is hidden (`: null`), so a user about to be charged the 1-кр floor sees **no price at all**. Minor, but it's the only price signal pre-send.
*Fix: §3 F5 (always show the "От 1 кр" floor line, even without a tariff).*

**M4 — Two parallel `fmtCredits` implementations + a legacy `cost_rub` / `budget_rub_monthly` naming.**
`fmtCredits` is duplicated in `lib/credits.ts:7`, `profile/topup/page.tsx:68`, `profile/income/page.tsx:36` (3 copies, same logic). And the credit unit is still surfaced through RUB-named fields: `Run.cost_rub` / `agent.budget_rub_monthly` (`agents/[id]/page.tsx:82,26,769,853`), worker `exec.cost_rub` (`agent-runner.ts:914-920`, explicitly flagged "named cost_rub … treated as credit"). No user sees "₽", but the **codebase says rubles while the product says credits** — a maintenance/coherence hazard exactly as warned in `apps/tg-miniapp/CLAUDE.md`.
*Fix: §3 F6 (consolidate the helper; rename is a tracked debt, not this pass).*

### LOW

**L1 — TON top-up quote validity copy is inconsistent.** Subtitle says «Курс актуален 1 минуту» (`topup/page.tsx:276`) but the invoice `validUntil` is 10 min (`init :24 TX_VALID_FOR_S=600`) and the on-chain rate is locked at init regardless. Harmless but the "1 минуту" number is arbitrary/unenforced.

**L2 — Run-trace footer says "цена за каждый ответ" but only shows after runs exist.** `agents/[id]/page.tsx:1218-1222`. A first-time user (0 runs) sees no price framing at all before their first send (compounds M3).

**L3 — `сost_rub` ledger label for sub-agent / tool fees folds into `run_debit` invisibly.** Tool fees + `call_agent` sub-costs ride into the single `run_debit` (`agent-runner.ts:914-921`); the run-trace shows per-tool cost (`recordToolCalls`) but the wallet ledger shows one lumped `run_debit`. Acceptable, noted for completeness.

---

## 3) Existing-feature fixes (NO new features)

**F1 (H1) — Make "available to withdraw" honest.** Two non-feature options for the founder:
  (a) Document + label: in `income/page.tsx`, change the «Вывод средств» copy to state that withdrawable = income **not yet spent in-app**, and make the `available_income_credits` calc subtract in-app spend (or simply `min(available_income, spendable_balance)`); OR
  (b) before turning `TON_PAYOUTS_ENABLED=true`, add the missing guard in `author-income POST` so `available = Σrent_credit − Σpayouts − (in-app spend of income)`. This is the **one place to fix before payouts go live.** No new feature — it's correctness on the existing scaffold.

**F2 (H2) — Add the missing ledger labels.** `wallet/page.tsx:42-49`: add `author_payout: 'Вывод средств'` (and any future kind). Mirror in `income/page.tsx kindLabel`. One-liner, kills the raw-English leak.

**F3 (M1) — Cost-preview line at the rent CTA.** `templates/[id]/page.tsx` under the «Арендовать за …» button: one muted line — "Подписка {price} кр/мес автору · запуски модели тарифицируются отдельно (от 1 кр за прогон)." Reuses existing copy patterns; no new data.

**F4 (M2) — One economy explainer.** A single reusable line wherever AIAG-supplied billing shows: "AIAG зарабатывает на наценке модели; аренда автору идёт автору целиком (0%)." Already half-stated on the income page (`:116-117`); surface the run-side half on the agent dialog near the tariff line (`agents/[id]/page.tsx:1329`).

**F5 (M3) — Always show the floor.** `agents/[id]/page.tsx:1329-1336`: when `modelRate` is null but `connection_type==='aiag'`, still render "От 1 кр за прогон · итог по факту ответа" (drop the tariff fragment only). Never leave the price area blank for a billable agent.

**F6 (M4) — Consolidate `fmtCredits`.** Import the one in `lib/credits.ts` into `topup/page.tsx` + `income/page.tsx`, delete the two local copies (note: topup's local returns `.toFixed(2)` without `ru-RU` grouping — pick the canonical `ru-RU` one for consistency). Pure refactor.

**F7 (L1) — Align top-up validity copy.** Make the subtitle say the same window the invoice enforces (10 мин) or drop the specific minute claim.

**F8 (L2) — Show price framing before the first run.** Render the tariff/floor line independent of `runs.length` so a fresh agent shows what a send will cost.

Best-practice note (cited): showing total cost *before* the paid action and a one-line "what the platform takes" are standard marketplace-trust patterns (e.g. Stripe/Gumroad checkout transparency, App Store "in-app purchase" disclosure). F3/F4 bring the rent path up to the (already good) run path.

---

## 4) Forward research list (open economy questions, later)

1. **Withdrawable-vs-spendable reconciliation (H1) as a first-class ledger concept.** Today income is one pooled spendable balance; a proper design separates "earned (withdrawable)" from "topped-up (spend-only)" sub-balances, or a single balance with a withdraw cap = lifetime-earned − lifetime-paid-out. Needs a founder money-model decision before payouts launch.
2. **Creator payout rails + audit.** `TON_PAYOUTS_ENABLED` batch is unaudited (`project_work3_agent_payments_ton`, R&D synthesis 2026-06-13). Open: batch `@ton/ton` payout safety, double-pay protection across crash/retry, KYC/threshold, fee handling (who pays TON gas on payout).
3. **FX-peg maintenance for the TON branch.** USDT branch is a clean fixed peg; the TON branch locks an oracle rate at init but credits the same `amount_credits` regardless of actual on-chain value variance during the 10-min window. Research: tolerance band, partial-fill, over/under-payment crediting policy (`check/[id]` only checks `received >= expected`).
4. **Dynamic / tiered model pricing + margin transparency.** Markup is opaque (gateway-internal). Research a user-facing "effective markup %" or tiered pricing without leaking upstream brand; and how author-rent interacts with model-cost markup for the renter's total cost-of-ownership.
5. **Anti-abuse on free-first-run / free clone / BYOK.** No free-run grant exists today (confirmed: nothing in the run route) — if one is added, research abuse (multi-account farming). Also: BYOK `call_agent` is already blocked from delegating to billable sub-agents (free-exfil guard, `agent-runner.ts:895-912`) — verify no other BYOK→AIAG free-inference path.
6. **Refund / chargeback / failed-run crediting policy.** A failed run isn't charged (good), but there is no user-initiated refund or dispute path; research whether the prepaid model needs one for trust.
