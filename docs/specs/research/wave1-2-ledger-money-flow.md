# Wave 1.2 — Atomic Rent-Payment on the USD-Credit Ledger

> Read-only investigation. Source files cited with `file:line`. The goal: how to do an
> atomic **rent payment** — debit the RENTER's credit balance, credit the AUTHOR's credit
> balance, and write two ledger entries, all in ONE `sql.begin` transaction on the now-live
> USD-credit ledger (`tg_user_balances` + `tg_ledger_entries`, migration `0029`).
>
> Status of code: **no rent-payment helper exists yet** (grep for `rent_debit|rent_credit|
> settleRent|rentPayment` = 0 hits). This doc specifies the pattern to build, derived
> verbatim from the two live atomic flows: `settleRun` (debit) and the topup-check route
> (credit). Money-path rules: `/SECURITY.md`. Author-rent product model:
> `docs/specs/2026-06-03-monetization.md`.

---

## The ledger schema (what we write into)

`tg_ledger_entries` — `packages/database/migrations/0029_usd_ledger.sql:102-116`:

```
tg_ledger_entries (
  id            BIGSERIAL PRIMARY KEY,
  tg_user_id    BIGINT NOT NULL,
  delta_credits BIGINT NOT NULL,   -- +credit (topup/rent_credit) or −debit (run/rent_debit), cents
  kind          VARCHAR(24) NOT NULL,  -- 'topup'|'run_debit'|'adjustment'|'refund' (+ add 'rent_debit'|'rent_credit')
  ref_kind      VARCHAR(24),       -- 'tg_topup'|'agent_run' (+ add 'rent_charge')
  ref_id        UUID,              -- idempotency key (topups.id / agent_runs.id / rent_charge.id)
  balance_after BIGINT NOT NULL,   -- materialized balance immediately AFTER this entry
  created_at    TIMESTAMPTZ DEFAULT NOW() NOT NULL
)
```

Idempotency index — `0029_usd_ledger.sql:114-116`:

```sql
CREATE UNIQUE INDEX uq_ledger_ref
  ON tg_ledger_entries(ref_kind, ref_id, kind)
  WHERE ref_id IS NOT NULL;
```

Key facts that drive everything below:
- `balance_credits` (BIGINT, integer US cents, 1 credit = $0.01) is the **live spendable
  balance** for ANY `tg_user` — `apps/agent-worker/src/db.ts:289-309`. The author is just
  another `tg_user`, so crediting them is the SAME `tg_user_balances.balance_credits`
  column the renter is debited from.
- The ledger is **append-only audit truth**; the cached balance is a projection. They must
  commit/rollback together (`db.ts:391-402` comment), so all four writes go in one
  `sql.begin`.
- The uniqueness key is the **triple `(ref_kind, ref_id, kind)`** — NOT `ref_id` alone.
  That is what lets a single `ref_id` carry BOTH a debit entry AND a credit entry (different
  `kind`) for the same rent charge (see §2).

---

## (1) The exact atomic pattern: DEBIT renter + CREDIT author + 2 ledger entries in one `sql.begin`

Combine the two proven shapes:
- **Guarded debit** (renter, must not over-spend) — from `settleRun`,
  `apps/agent-worker/src/db.ts:381-388`: `UPDATE … SET balance = balance − cost WHERE
  tg_user_id = renter AND balance_credits >= cost RETURNING balance_credits`. Zero rows ⇒
  insufficient funds ⇒ throw ⇒ whole tx ROLLBACKs.
- **Upsert credit** (author, may have no balance row yet) — from the topup route,
  `apps/tg-miniapp/app/api/tma/topup/check/[id]/route.ts:149-156`: `INSERT … ON CONFLICT
  (tg_user_id) DO UPDATE SET balance = balance + EXCLUDED RETURNING balance_credits`. This
  is the right shape for the author because a brand-new author may have **no**
  `tg_user_balances` row — a plain `UPDATE` would silently affect 0 rows and lose the
  credit. The upsert creates the row on first earning.

### SQL shape (the helper to build — proposed `settleRent` in agent-worker `db.ts`)

```ts
// One rent_charge row should be created BEFORE this call (status 'pending', UUID id =
// chargeId) so we have a stable idempotency ref_id and an audit anchor. Pass its id in.
export async function settleRent(args: {
  chargeId: string;     // uuid — the rent_charge row, used as ledger ref_id
  renterId: string;     // tg_user paying
  authorId: string;     // tg_user receiving (must differ — see §4)
  amountCredits: number; // integer US cents, > 0 (see §4)
}): Promise<void> {
  const { chargeId, renterId, authorId, amountCredits } = args;

  // Guards BEFORE opening the tx (cheap, fail fast — see §4):
  if (!Number.isInteger(amountCredits) || amountCredits <= 0)
    throw new Error('rent_amount_invalid');
  if (renterId === authorId)
    throw new SelfDealError();           // author cannot rent from self

  await sql.begin(async (sql) => {       // callback-scoped sql = stays in-tx (db.ts:356)
    // a) mark the charge consumed (re-check status in WHERE = concurrency guard,
    //    mirrors the topup status guard at route.ts:139-143). 0 rows ⇒ already settled.
    const claim = await sql`
      UPDATE rent_charges
      SET status = 'settled', settled_at = NOW()
      WHERE id = ${chargeId}::uuid AND status = 'pending'
      RETURNING id::text
    `;
    if (claim.length === 0) return;      // idempotent: a concurrent call already settled

    // b) GUARDED DEBIT of the renter (over-spend safe — db.ts:381-388 pattern)
    const debit = await sql`
      UPDATE tg_user_balances
      SET balance_credits = balance_credits - ${amountCredits}, updated_at = NOW()
      WHERE tg_user_id = ${renterId}::bigint
        AND balance_credits >= ${amountCredits}
      RETURNING balance_credits::text AS balance_credits
    `;
    if (debit.length === 0) throw new InsufficientBalanceError(); // ROLLBACK everything

    // c) UPSERT CREDIT of the author (creates row if author never had a balance —
    //    topup route.ts:149-156 pattern). 100% pass-through: AIAG takes 0% (monetization.md).
    const credit = await sql`
      INSERT INTO tg_user_balances (tg_user_id, balance_credits, updated_at)
      VALUES (${authorId}::bigint, ${amountCredits}::bigint, NOW())
      ON CONFLICT (tg_user_id) DO UPDATE
        SET balance_credits = tg_user_balances.balance_credits + EXCLUDED.balance_credits,
            updated_at = NOW()
      RETURNING balance_credits::text AS balance_credits
    `;

    // d) TWO ledger entries, SAME ref_id (the charge), DIFFERENT kind. The
    //    (ref_kind, ref_id, kind) unique index lets both coexist + makes each idempotent.
    await sql`
      INSERT INTO tg_ledger_entries
        (tg_user_id, delta_credits, kind, ref_kind, ref_id, balance_after)
      VALUES
        (${renterId}::bigint, ${-amountCredits}, 'rent_debit', 'rent_charge',
         ${chargeId}::uuid, ${debit[0]!.balance_credits}::bigint)
      ON CONFLICT (ref_kind, ref_id, kind) WHERE ref_id IS NOT NULL DO NOTHING
    `;
    await sql`
      INSERT INTO tg_ledger_entries
        (tg_user_id, delta_credits, kind, ref_kind, ref_id, balance_after)
      VALUES
        (${authorId}::bigint, ${amountCredits}, 'rent_credit', 'rent_charge',
         ${chargeId}::uuid, ${credit[0]!.balance_credits}::bigint)
      ON CONFLICT (ref_kind, ref_id, kind) WHERE ref_id IS NOT NULL DO NOTHING
    `;
  });
}
```

Why this is correct (traceable to the live code):
- All four writes inside one `sql.begin` ⇒ atomic; any throw auto-ROLLBACKs all of them
  (the exact guarantee `settleRun` relies on, `db.ts:343-403`). The author can never be
  credited without the renter being debited, and vice versa.
- The renter side uses the **guarded `WHERE balance_credits >= amount RETURNING`** so an
  under-funded renter affects 0 rows ⇒ throw ⇒ rollback ⇒ author NOT credited. This is the
  double-spend/over-budget-safe pattern mandated by `/SECURITY.md` and
  `packages/database/CLAUDE.md` (per-row lock + WHERE-guard, READ COMMITTED, no
  SERIALIZABLE/40001 retry loop).
- The author side uses the **upsert** (not a bare UPDATE) so a first-time author with no
  balance row still receives credit.
- `balance_after` for each entry comes from that side's own `RETURNING balance_credits`
  (debit → renter's post-debit balance; credit → author's post-credit balance), so each
  ledger row's `balance_after` matches its user's projection exactly — same discipline as
  `settleRun` (`db.ts:394`) and the topup route (`route.ts:164`).

> Note: a **lock-ordering caveat** for the combined debit+credit in ONE tx — if two
> different rent charges ever touch the same two users in opposite roles concurrently, you
> can deadlock. The monetization spec already anticipates this and recommends an
> **author-payout sweep** as a SEPARATE pass from the renter debit to avoid
> `tg_user_balances` lock contention (`docs/specs/2026-06-03-monetization.md:25`). If you
> prefer that split design: tx-1 debits the renter + writes the `rent_debit` entry + leaves
> the charge `status='owed_to_author'`; a later sweep tx credits the author + writes
> `rent_credit` + flips to `settled`. Both passes individually use the patterns above and
> stay idempotent via `uq_ledger_ref`. The single-tx version above is simpler and fine at
> low volume; the sweep is the scale-safe variant.

---

## (2) Idempotency — making a rent charge exactly-once (`uq_ledger_ref`)

Mechanism = the partial unique index `uq_ledger_ref ON tg_ledger_entries(ref_kind, ref_id,
kind) WHERE ref_id IS NOT NULL` (`0029_usd_ledger.sql:114-116`), used exactly like the two
live flows:

- `settleRun` debit entry: `ON CONFLICT (ref_kind, ref_id, kind) WHERE ref_id IS NOT NULL
  DO NOTHING` — `apps/agent-worker/src/db.ts:401`.
- topup credit entry: same clause — `apps/tg-miniapp/app/api/tma/topup/check/[id]/route.ts:165`.

For rent, exactly-once is enforced at **two layers**:

1. **The charge-claim guard** (`UPDATE rent_charges SET status='settled' WHERE id=…
   AND status='pending' RETURNING id`; 0 rows ⇒ early `return`). This mirrors the topup
   route's `WHERE … AND status='pending'` double-credit guard (`route.ts:139-145`) and the
   topup status short-circuit (`route.ts:63-68`). A retry sees status already `settled`,
   gets 0 rows, returns without touching balances. This is the primary exactly-once gate.

2. **The ledger `ON CONFLICT DO NOTHING`** is the belt-and-suspenders backstop: even if a
   retry somehow re-entered after the claim (e.g. partial replay), the unique index makes
   re-inserting the same `(rent_charge, chargeId, rent_debit)` / `(…, rent_credit)` a no-op
   instead of duplicating money in the audit log.

Critical design point: **use ONE `ref_id` (the `rent_charge.id` UUID) for BOTH entries**,
distinguished by `kind` (`rent_debit` vs `rent_credit`). Because the unique key is the
triple, both rows coexist and each is independently idempotent. Do NOT try to use the
agent_run id or a non-UUID — `ref_id` is `UUID` and the index only applies `WHERE ref_id IS
NOT NULL`, so a NULL ref_id would silently disable idempotency. Always mint a UUID
`rent_charge` row first and pass its id.

---

## (3) Author "spendable credits" = the SAME `tg_user_balances.balance_credits`

There is **no separate author-earnings table**. The author is a `tg_user`; their earnings
land in the identical column the renter spends from:

- `tg_user_balances.balance_credits` is THE live spendable balance for any tg_user, integer
  US cents — defined `apps/agent-worker/src/db.ts:289-309` (`getBalance`) and read by the
  wallet route `apps/tg-miniapp/app/api/tma/wallet/route.ts:31-41`.
- Crediting it is the topup upsert shape (`route.ts:149-156`): `INSERT … ON CONFLICT
  (tg_user_id) DO UPDATE SET balance_credits = balance_credits + EXCLUDED RETURNING
  balance_credits`. The author credit in §1(c) is byte-for-byte that pattern with the
  author's `tg_user_id` and the rent amount.
- Consequence: the moment `settleRent` commits, the author's `GET /api/tma/wallet` balance
  goes up by exactly `amountCredits`, and the author can immediately spend those credits on
  their own runs/rentals. This is the "author receives the exact sum in spendable credits"
  requirement from `docs/specs/2026-06-03-monetization.md:19`. Withdrawability
  (cash-out vs in-app-only) is an OPEN founder question (`monetization.md:39`) and does NOT
  affect this ledger mechanic — it would be a later flag/policy on top.

Pass-through (0% cut): the author `delta_credits` equals the renter's `-delta_credits`
exactly. AIAG takes nothing here — its revenue is model markup + tools + deploy, NOT the
rent (`monetization.md:20-21`). So the two ledger entries are equal-and-opposite; the rent
is conserved (sum of the pair = 0).

---

## (4) Guards: self-dealing + negative/zero amounts

Both are cheap pre-checks done BEFORE opening the tx (fail fast, no wasted lock):

**Self-dealing (author renting their own template).** The monetization spec mandates a
**self-deal exclusion in the accrual hook** so an author can't rent from themselves to farm
rank/earnings (`docs/specs/2026-06-03-monetization.md:29`). Enforce
`if (renterId === authorId) throw new SelfDealError()` before the tx. Without it, a
self-rent would debit and credit the SAME `tg_user_balances` row — at best a no-op churn,
at worst a deadlock/lost-update if done as two statements on one row, and it pollutes the
usage-rank signal. Belt-and-suspenders: the caller (the rent-charge creator) should also
refuse to create a `rent_charge` where `renter = template.author_tg_user_id`. (Rank is also
defended by ranking on **distinct funded renters**, `monetization.md:28`.)

**Negative / zero amounts.** Guard `if (!Number.isInteger(amountCredits) || amountCredits
<= 0) throw new Error('rent_amount_invalid')`. Reasons:
- Free templates (`monetization.md:14-15`) must NOT call `settleRent` at all — author price
  `бесплатно` ⇒ no charge, no ledger entry. `settleRent` should only ever run for a priced
  template with `amount > 0`.
- A **negative** amount would invert the guarded debit (`balance − (−x) = balance + x`)
  into an over-credit that **passes** the `>= amount` guard trivially — a withdrawal exploit.
  Reject it.
- A **zero** amount writes two zero-delta ledger rows and dirties the audit log for no
  money movement. Reject it.
- Integer-cents only: `balance_credits`/`delta_credits` are BIGINT cents (`0029` lines
  37-39, 105). Reject non-integers so no rounding/truncation happens silently inside SQL.

These mirror the implicit invariants already trusted by `settleRun` (it never debits when
`isExternal`, i.e. cost 0 / BYOK — `db.ts:368`) and the topup route (only credits a matched,
value-checked inbound tx — `route.ts:122,129-131`). Also keep the BYOK/own-provider exclusion
in mind at the model-usage layer (`if (isExternal) return`, `db.ts:368`) — that is about
model cost, separate from author rent, but the same "don't charge for what the user pays
their own provider" discipline applies (`monetization.md:25`).

---

## Schema additions needed (not yet in migrations — flagged, not built here)
Building `settleRent` requires (a new migration, manual prod apply per
`packages/database/CLAUDE.md`):
- a `rent_charges` table (`id UUID PK`, `renter_tg_user_id`, `author_tg_user_id`,
  `template_id`/`agent_id`, `amount_credits BIGINT`, `status`, `created_at`, `settled_at`)
  to anchor the idempotency `ref_id` and the claim guard;
- widen the ledger CHECK/enum understanding of `kind` to include `rent_debit`/`rent_credit`
  and `ref_kind` to include `rent_charge` (the column is `VARCHAR(24)` with no DB-level CHECK
  today — `0029:106-107` — so no ALTER is strictly required, but document the new values).
No code change to `settleRun` or the topup route is needed; rent is a NEW parallel helper
reusing their patterns.
