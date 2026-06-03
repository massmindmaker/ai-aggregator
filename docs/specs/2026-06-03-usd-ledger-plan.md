# D-1 — USD-credit ledger migration (TMA ₽ → USD-pegged crypto credit)

> **Status:** plan / not-yet-executed. **Surface:** TMA only (`apps/tg-miniapp` + `apps/agent-worker` + `tg_*` tables). The web aggregator (`apps/web` + gateway org-balances) stays in ₽ and is **out of scope**.
> **Single source of truth conflicts:** `/CLAUDE.md` (founder decision: TMA = USD-pegged crypto credits, ₽ removed) and `/SECURITY.md` (atomic money ops) win. This plan implements that decision.
> **Author:** money-path subagent, 2026-06-03.

---

## 0. Founder-readable summary (read this first)

Today the Telegram Mini App pretends to be in crypto but its code still counts **rubles**. A user tops up TON, we convert TON→₽ at the live CoinGecko rate, store ₽ in `tg_user_balances.balance_rub`, and the worker debits ₽ — with a hardcoded `USD_TO_RUB = 90` buried in the billing math. That's three currency hops (TON→₽→USD-for-pricing→₽-for-debit) and a frozen exchange rate that will silently be wrong the day the ruble moves.

The founder decision is: **TMA is denominated in a single USD-pegged credit unit. The ruble is gone from TMA.** One credit = one US-dollar-cent of spending power. We top up in crypto (TON now, other cryptos later), convert **crypto→USD once at top-up time**, and from then on everything — balance, prices, model markup, budgets, the run cost — is in credits. No ruble anywhere in the TMA path.

**Why now is the cheap moment:** prod has **0 agents and 0 user balances right now**. There is no live money to convert, no freeze-window, no reconciliation, no "what rate do we migrate existing rubles at" problem. We rename/replace the columns, flip the code from ₽ to USD-cents, and ship. If we wait until real users have balances, this becomes a high-risk financial migration with a maintenance window. **Do it before the first paying agent exists.**

**What changes for the user:** they see **«кредиты» / «cr»** instead of «₽» everywhere — wallet balance, top-up amounts, agent budgets, run costs. Top-up still works the same (connect TON wallet → pay → balance credited), but the credited amount is now shown in credits, and the amount field is entered in credits/USD, not rubles.

**The one number to remember:** **1 credit = 1 US cent = $0.01.** A user with 500 credits has $5.00 of spending power. We picked cents (not whole dollars, not micro-dollars) because it's an integer — no floating-point drift on money — and it's a human-readable unit that maps cleanly to "₽ amounts were already 2–4 decimal places of a small currency."

---

## 1. The new unit — **integer USD cents** (`balance_credits BIGINT`, 1 credit = 1¢ = $0.01)

### Decision
The credit unit is **one US dollar cent**, stored as a **`BIGINT`** integer. We call it a **credit** in the product («1 кредит»), and `1 credit = $0.01`.

### Why an integer (mandatory) — no floats on money
Money MUST be an integer to avoid float drift. The current schema already half-knows this: `tg_user_balances.balance_rub` is `NUMERIC(14,4)` and `agent_runs.cost_rub` is `NUMERIC(10,4)` — `NUMERIC` is exact, but the *application* reads them through `Number(...)` in JS (`getBalance`, `settleRun`, `estimateCostRub`), which lifts exact decimals into IEEE-754 floats. Two `Number()`-ed decimals subtracted (`balance - cost`) can drift. Moving to a `BIGINT` of cents keeps the value an exact JS-safe integer end to end (a `BIGINT` of cents stays under `Number.MAX_SAFE_INTEGER` until ~$90 trillion — never a concern), and the atomic `UPDATE … WHERE balance_credits >= cost` guard compares integers.

### Why cents, not micro-credits or whole dollars
| Candidate unit | Integer? | Precision per run | Verdict |
|---|---|---|---|
| Whole USD ($1) | yes | $1 — far too coarse; a cheap gpt-4o-mini run costs <$0.01 → rounds to 0 (free) | ✗ reject |
| **USD cents ($0.01)** | **yes** | **$0.01 — matches today's `MIN_RUN_COST = 1₽` floor granularity; human-readable** | **✓ chosen** |
| USD micro-credits ($0.000001) | yes | $0.000001 — exact to the token, but 6 trailing zeros of noise the user never sees, and balances become 8-digit numbers («500000000 cr» for $5) | ✗ over-engineered for the UI |

A single AIAG-supplied model call today bills via the gateway's authoritative ₽ figure or the local estimate; in USD terms a small run is a fraction of a cent. **Cents is coarse enough that a sub-cent run rounds to a 1-credit floor** (we already have exactly this floor — `MIN_RUN_COST` — see §3), and fine enough that the user sees honest, readable balances. Internally the *cost estimate* is computed in floating USD and **rounded up to the next whole cent at settle time** (`Math.ceil(usd * 100)`), so we never undercharge and never store a fraction.

> **Founder check needed (low-stakes, Claude picked a default):** if you later want sub-cent precision for high-volume cheap models, switch the unit to **micro-credits** (`balance_micro_credits BIGINT`, 1¢ = 10 000 µc) — the schema and code shape are identical, only the scale constant and the UI formatter change. Cents is the recommended default for launch; it keeps every displayed number short.

---

## 2. Schema strategy — **rename-in-place + an append-only ledger** (do both)

Two independent changes. Both are additive/safe because there are **0 rows**.

### 2a. Rename the live balance columns ₽ → credits (the spendable balance)
We are NOT keeping a parallel `balance_rub` and `balance_credits` — that would entrench the dual-unit confusion `/CLAUDE.md` warns about. With 0 balances, we **rename** the column and drop the ruble name entirely:

- `tg_user_balances.balance_rub` → `balance_credits BIGINT NOT NULL DEFAULT 0` (cents)
- `agent_runs.cost_rub` → `cost_credits BIGINT NOT NULL DEFAULT 0`
- `agents.budget_rub_monthly` → `budget_credits_monthly BIGINT NOT NULL DEFAULT 100000` (= $1000)
- `agents.daily_budget_rub` → `daily_budget_credits BIGINT NOT NULL DEFAULT 10000` (= $100)
- `agents.spent_today_rub` → `spent_today_credits BIGINT NOT NULL DEFAULT 0`
- `tg_topups.amount_rub` → `amount_credits BIGINT NOT NULL` (the credited amount, cents)
- `tg_topups.rate_rub_per_ton` → `rate_usd_cents_per_ton BIGINT NOT NULL` (audit of the conversion rate at top-up)

Type change `NUMERIC → BIGINT` is safe at 0 rows; with data it would need a `USING (round(balance_rub * <rate> * 100))::bigint` cast, which is exactly the freeze-window risk we are avoiding by doing this now.

### 2b. Add an append-only ledger table (immutable audit) — `tg_ledger_entries`
The current design stores only a *mutable running balance* (`UPDATE … SET balance = balance ± x`). There is no immutable record of *why* a balance is what it is — a reconciliation/audit gap flagged across the 108-eval (billing integrity is a worst-dim). With the unit migration we add a proper double-entry-style **append-only journal**. The mutable `balance_credits` becomes a cached projection of the ledger sum; the ledger is the truth.

```
tg_ledger_entries (
  id           BIGSERIAL PRIMARY KEY,
  tg_user_id   BIGINT NOT NULL,
  delta_credits BIGINT NOT NULL,          -- +credit (topup) or −debit (run settle), in cents
  kind         VARCHAR(24) NOT NULL,       -- 'topup' | 'run_debit' | 'adjustment' | 'refund'
  ref_kind     VARCHAR(24),                -- 'tg_topup' | 'agent_run'
  ref_id       UUID,                       -- topups.id / agent_runs.id (idempotency key)
  balance_after BIGINT NOT NULL,           -- materialized balance immediately after this entry
  created_at   TIMESTAMPTZ DEFAULT NOW() NOT NULL
)
```
- **Immutability:** only `INSERT`s, never `UPDATE`/`DELETE` (enforced by convention + the app role; a `BEFORE UPDATE/DELETE` trigger raising an exception is an optional hardening, deferred).
- **Idempotency:** `UNIQUE (ref_kind, ref_id, kind)` so a re-run of topup-check or a settle retry can't double-credit/double-debit.
- **Audit:** `balance_after` lets you replay/verify `tg_user_balances.balance_credits == SUM(delta_credits)` at any time.

> **Scope discipline (do NOT over-build):** the ledger is the *only* new table. We keep `tg_user_balances` as the fast cached balance (the worker's atomic `UPDATE … WHERE balance >= cost RETURNING` guard still runs on it — that's the load-bearing double-spend protection from `/SECURITY.md` and it must not change shape). The ledger row is written **inside the same `sql.begin` transaction** as the balance mutation, so they can never diverge. If R1 wants ledger-only (drop the cached column) that's a later decision — for now, cached-balance + journal, both in one tx.

---

## 3. Exactly which code drops `USD_TO_RUB` and how pricing/markup become USD-native

### The constant and its blast radius
`USD_TO_RUB = 90` appears in:
- `apps/agent-worker/src/agent-runner.ts:40` — the declaration.
- `apps/agent-worker/src/agent-runner.ts:308` — inside `estimateCostRub`: `return usd * USD_TO_RUB;`
- `apps/agent-worker/src/__tests__/budget.test.ts:7` — replicated to assert the expected value.

### The change (delete the ₽ conversion entirely — pricing is already USD-native)
The crucial insight: **`PRICING` is already in USD** (`agent-runner.ts:113–124`, "USD per 1M tokens"). The `* USD_TO_RUB` at line 308 is the *only* thing converting it to rubles. The migration is therefore a **deletion, not a rewrite** — we stop converting USD→₽ and instead convert USD→cents (×100, integer):

- **Delete** `const USD_TO_RUB = 90;` (line 40).
- **Rename** `estimateCostRub` → `estimateCostCredits`. Body becomes:
  ```ts
  export function estimateCostCredits(modelSlug, tokensIn, tokensOut): number {
    const p = PRICING[modelSlug] ?? FALLBACK_PRICE;
    const usd = (tokensIn * p.in + tokensOut * p.out) / 1_000_000;
    return Math.ceil(usd * 100); // USD → integer cents, round UP (never undercharge)
  }
  ```
- **Markup** is **not** in the worker — markup is applied by the `:4000` gateway, which returns the *authoritative charged amount* via the `x-aiag-charged-rub` header (D-0). For TMA we must change the gateway↔worker billing contract to be **USD-native**:
  - Add USD headers `x-aiag-charged-usd-micro` and `x-aiag-upstream-cost-usd-micro` (micro-USD = integer, avoids float on the wire; worker divides into cents with `Math.ceil(micro / 10_000)`), OR re-label the existing headers' *meaning* to micro-USD. **Founder/gateway-owner decision:** keep the ₽ headers for `apps/web` (still ₽) and add **parallel USD headers** the gateway sets only for TMA-sourced requests. Rename the worker-side constants `HDR_CHARGED_RUB` → `HDR_CHARGED_USD_MICRO` etc. and the parser to integer micro-USD → cents. *(This is the one cross-service edit; it touches `packages/api-gateway`. If the gateway change is deferred, the worker safely falls back to `estimateCostCredits` — the existing "never bill 0, never silently mix" logic at `agent-runner.ts:482–495` already handles a missing authoritative figure.)*
- **`finalBillableCostRub` → `finalBillableCostCredits`**: `Math.max(MIN_RUN_COST, raw)` where `MIN_RUN_COST` stays `1` but now means **1 credit = $0.01** (a clean, honest minimum, and it's already an integer). External/BYOK stays exactly `0`.
- **`settleRun` arg** `costRub` → `costCredits`, passed straight through to the `cost_credits` debit + the new `tg_ledger_entries` insert.
- **Budgets** (`budget_credits_monthly`, `daily_budget_credits`, `spent_today_credits`, `sumMonthlySpend`) all become integer-cent comparisons — same SQL shape, renamed columns. `getOrResetDailyBucket` / the atomic daily guard in `settleRun` are unchanged except column names.
- **`db.ts`**: `getBalance` returns cents (`balance_credits`), still `Number(...)` but now an exact integer; `AgentRow` field renames; `settleRun` debit guard becomes `WHERE balance_credits >= ${costCredits}`.
- **Tests** (`budget.test.ts`): drop the `USD_TO_RUB` replica; assert `estimateCostCredits` returns `Math.ceil(usd*100)`; `finalBillableCostCredits` floor tests use `MIN_RUN_COST = 1` (cent) unchanged; daily-guard boundary tests are unit-agnostic and stay as-is.

### Top-up conversion (the crypto→USD hop moves to top-up time)
`apps/tg-miniapp/src/lib/ton-rate.ts` currently fetches **TON→RUB** from CoinGecko. Change the rate source to **TON→USD** (`vs_currencies=usd`) and rename `getTonRubRate → getTonUsdRate`. At top-up:
- User enters an amount **in credits** (= US cents → effectively dollars).
- `topup/init` computes `amount_nano_ton = ceil(amount_usd / ton_usd_rate * 1e9)` and stores `amount_credits` (cents) + `rate_usd_cents_per_ton` for audit.
- `topup/check` on confirmation credits `balance_credits += amount_credits` **and writes a `tg_ledger_entries` `kind='topup'` row** (idempotent via the unique ref key), inside one tx.

> This collapses the currency hops from **TON→₽→(USD-for-pricing)→₽-for-debit** to a single **TON→USD at top-up**, after which everything is credits. The frozen `USD_TO_RUB = 90` disappears because there is no more ₽ leg.

---

## 4. Migration SQL (additive, manual prod via `sudo -u postgres psql aiag`)

New file: `packages/database/migrations/0029_usd_credit_ledger.sql`. **Safe because 0 rows.** Apply on prod with `sudo -u postgres psql aiag` (the app `aiag` role cannot `ALTER` — per `packages/database/CLAUDE.md`). Mirror the change in the Drizzle schema (`packages/database/schema`) so generated types match, but **do not** run `db:push`/`db:migrate` at prod.

```sql
-- 0029_usd_credit_ledger.sql
-- D-1: TMA ₽ → USD-pegged credit unit (1 credit = 1 US cent, BIGINT).
-- SAFE: prod has 0 agents and 0 balances at apply time — no value conversion,
-- no freeze window. If any row exists, STOP and use a USING-cast + maintenance window.

BEGIN;

-- guard: refuse to run if real money exists (defensive; should be 0 on prod now)
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM tg_user_balances) > 0
     OR (SELECT COUNT(*) FROM agent_runs) > 0 THEN
    RAISE EXCEPTION 'tg_user_balances / agent_runs not empty — do NOT run the 0-row fast path; convert with a USING cast in a maintenance window';
  END IF;
END $$;

-- 1) spendable balance ₽ → credits (cents, integer)
ALTER TABLE tg_user_balances
  RENAME COLUMN balance_rub TO balance_credits;
ALTER TABLE tg_user_balances
  ALTER COLUMN balance_credits TYPE BIGINT USING (round(balance_credits))::bigint,
  ALTER COLUMN balance_credits SET DEFAULT 0;

-- 2) run cost ₽ → credits
ALTER TABLE agent_runs
  RENAME COLUMN cost_rub TO cost_credits;
ALTER TABLE agent_runs
  ALTER COLUMN cost_credits TYPE BIGINT USING (round(cost_credits))::bigint,
  ALTER COLUMN cost_credits SET DEFAULT 0;

-- 3) agent budgets ₽ → credits
ALTER TABLE agents RENAME COLUMN budget_rub_monthly TO budget_credits_monthly;
ALTER TABLE agents RENAME COLUMN daily_budget_rub  TO daily_budget_credits;
ALTER TABLE agents RENAME COLUMN spent_today_rub   TO spent_today_credits;
ALTER TABLE agents
  ALTER COLUMN budget_credits_monthly TYPE BIGINT USING (round(budget_credits_monthly))::bigint,
  ALTER COLUMN budget_credits_monthly SET DEFAULT 100000,   -- $1000
  ALTER COLUMN daily_budget_credits   TYPE BIGINT USING (round(daily_budget_credits))::bigint,
  ALTER COLUMN daily_budget_credits   SET DEFAULT 10000,     -- $100
  ALTER COLUMN spent_today_credits    TYPE BIGINT USING (round(spent_today_credits))::bigint,
  ALTER COLUMN spent_today_credits    SET DEFAULT 0;

-- 4) topups: credited amount + audited rate
ALTER TABLE tg_topups RENAME COLUMN amount_rub       TO amount_credits;
ALTER TABLE tg_topups RENAME COLUMN rate_rub_per_ton TO rate_usd_cents_per_ton;
ALTER TABLE tg_topups
  ALTER COLUMN amount_credits         TYPE BIGINT USING (round(amount_credits))::bigint,
  ALTER COLUMN rate_usd_cents_per_ton TYPE BIGINT USING (round(rate_usd_cents_per_ton))::bigint;

-- 5) append-only immutable ledger (audit truth; cached balance is a projection)
CREATE TABLE IF NOT EXISTS tg_ledger_entries (
  id            BIGSERIAL PRIMARY KEY,
  tg_user_id    BIGINT NOT NULL,
  delta_credits BIGINT NOT NULL,
  kind          VARCHAR(24) NOT NULL,
  ref_kind      VARCHAR(24),
  ref_id        UUID,
  balance_after BIGINT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON tg_ledger_entries(tg_user_id, created_at DESC);
-- idempotency: a topup/run can post at most one entry of a given kind
CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_ref
  ON tg_ledger_entries(ref_kind, ref_id, kind)
  WHERE ref_id IS NOT NULL;

COMMIT;
```

> **Rollback note:** with 0 rows, rollback is the symmetric rename back to `*_rub` + `TYPE NUMERIC`. Keep the down-migration in the PR description, not as a live file (prod has no migration tracking — `packages/database/CLAUDE.md`).

---

## 5. What the TMA UI shows — credits, never ₽

The single product unit is **«кредиты» / «cr»** (PRODUCT.md: "One canonical credit unit; never show contracts/gas"). All `₽` glyphs and ruble copy are removed from the TMA surface. JetBrains Mono for the number (DESIGN.md: all numerics mono).

| Surface | File | Today (₽) | After (credits) |
|---|---|---|---|
| Wallet balance | `app/api/tma/wallet/route.ts` + wallet UI | `balance_rub` → "… ₽" | `balance_credits` → format `(c/100).toFixed(2)` → "5.00 cr" (or "500 кр") |
| Top-up presets | `app/profile/topup/page.tsx:31` | `[200,500,1000,2000] ₽` | credit presets, e.g. `[2,5,10,20]` ($)→`[200,500,1000,2000]` cents; label "5 cr" |
| Top-up input | same | `… ₽`, MIN 100 / MAX 50000 ₽ | enter credits/USD; MIN/MAX re-expressed in cents |
| Top-up success | same:215 | "Зачислено {amount_rub} ₽" | "Зачислено {amount_credits/100} cr" |
| TON equivalent | same:197 | "≈ X TON" (kept) | unchanged — still show the TON they pay |
| Agent budget cards | `app/agents/new`, `app/agents/[id]` | `budget_rub_monthly`, `daily_budget_rub` "… ₽" | `budget_credits_monthly`, `daily_budget_credits` "… cr" |
| Run cost / history | run-completed bot msg + run UI | `cost_rub` "… ₽" | `cost_credits` "… cr" |
| Bot messages | `apps/agent-worker/src/bot-api.ts` (`buildRunCompletedMessage` takes `costRub`) | "… ₽" | rename param `costCredits`, render "… cr" |

**Formatting rule:** store/compute in integer cents; **display** as `(cents/100)` with 2 decimals + the unit word. Never expose the cent integer to the user as a raw 3-digit number. A wallet of `500` cents renders **"5.00 cr"** (or, if the founder prefers whole-credit display, "5 кр" where 1 кр = $1 — a pure formatter choice, no schema impact).

> **Out of UI scope (keep honest, PRODUCT.md "UI = reality"):** still no Telegram Stars, no ₽, no multi-crypto picker beyond the existing TON Connect flow. Top-up stays TON-only at the data layer; the "multi-crypto" promise is a later top-up-source addition that writes the *same* `amount_credits` — the ledger/credit unit is already crypto-agnostic, which is the point.

---

## 6. Execution order (surgical, money-path-careful) + verification

1. Land the Drizzle schema rename + `tg_ledger_entries` in `packages/database` (types first — turbo libs build before the apps).
2. `apps/agent-worker`: drop `USD_TO_RUB`, rename `estimateCostRub→Credits`, `finalBillableCost*`, `settleRun` arg + the ledger insert (one `sql.begin`), `db.ts` column renames, `getBalance` returns cents. Update `budget.test.ts`.
3. `packages/api-gateway`: add the parallel USD billing headers for TMA requests (or defer → worker estimates; the existing fallback covers it).
4. `apps/tg-miniapp`: `ton-rate` TON→USD, `topup/init` + `topup/check` (credit + ledger insert), `wallet`, `agents` routes column renames, all UI `₽→cr`.
5. **Verify per `/CLAUDE.md` rules — no local runtime.** Typecheck/build green for all three packages (`bun run type-check` / `build`); `bun run test` (vitest) for the worker billing tests; then deploy via skill `aiag-deploy` and check on the VPS: apply `0029` via `sudo -u postgres psql aiag`, confirm a real TON top-up credits `balance_credits` + writes a `tg_ledger_entries` row, and a real agent run settles in `cost_credits` with a matching `run_debit` ledger entry summing to the cached balance.

**Pre-flight gate (the whole reason this is cheap):** before applying `0029`, run `SELECT COUNT(*) FROM tg_user_balances; SELECT COUNT(*) FROM agent_runs;` on prod. **Both must be 0.** The migration's `DO $$ … RAISE EXCEPTION` guard enforces it, but verify by hand too — the moment either is non-zero, this stops being a rename and becomes a financial conversion needing a maintenance window and a chosen ₽→USD rate.
