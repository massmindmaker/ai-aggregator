# Phase 16 (R1.4): Transferable Agent (iNFT-on-TON) — Pattern Map

**Mapped:** 2026-06-10
**Files analyzed:** 9 new/modified surfaces
**Analogs found:** 8 / 9 (one — TEP-62 NFT mint/transfer — has only a partial analog; see "No Analog Found")

> This feature is **+1 transaction type** layered on the LIVE Wave-1 monetization. Every money-touching analog below is already on prod. The planner must MIMIC these exact patterns, not invent new ones. Money/atomicity rules: `/SECURITY.md`. Migration rules: `packages/database/CLAUDE.md` (manual, untracked, `sudo -u postgres psql aiag`, app role cannot ALTER).

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `apps/tg-miniapp/app/api/tma/agents/[id]/transfer/route.ts` (NEW — atomic transfer/sale) | route (API) | CRUD + request-response (atomic money tx) | `apps/tg-miniapp/app/api/tma/templates/[id]/rent/route.ts` | **exact** (paid-rent atomic `sql.begin`) |
| `apps/tg-miniapp/app/api/tma/agents/[id]/make-transferable/route.ts` (NEW — opt-in mint) | route (API) | request-response (TON write) | `apps/tg-miniapp/app/api/tma/agents/[id]/publish/route.ts` (opt-in flip) + `topup/check/[id]/route.ts` (TON I/O) | role-match |
| `packages/database/migrations/0039_agent_transfers.sql` (NEW) | migration | DDL | `packages/database/migrations/0032_template_rentals.sql` | **exact** |
| `agents` table new columns (transferable, nft_address, nft_owner_wallet) | migration | DDL (ALTER) | `0027_agents_external_api_key_hint.sql` / `0028_agents_mcp.sql` (additive ALTER) + `0018_agents.sql` (base) | role-match |
| Ownership reassign (`UPDATE agents SET tg_user_id=...`) | SQL (inside transfer tx) | atomic UPDATE...RETURNING | `settleRun` guarded debit in `apps/agent-worker/src/db.ts` L552 | role-match |
| History wipe (`DELETE FROM agent_runs WHERE agent_id`) | SQL (inside transfer tx) | delete | `agent_runs` is the history store (`loadHistory` `db.ts` L234) | derived, no direct analog |
| Memory re-key (encrypt agent_memory blob → new owner X25519) | utility (crypto) | transform | `apps/tg-miniapp/src/lib/crypto.ts` `encryptSecret`/`decryptSecret` (AES-256-GCM) | role-match (symmetric→needs X25519 add) |
| TON NFT mint + transfer call | utility (TON) | TON write + verify | `topup/check/[id]/route.ts` (TonCenter read/verify) | partial (read-only analog; no write yet) |
| Seller credit payout (0% cut, equal-and-opposite ledger) | SQL (inside transfer tx) | atomic credit + ledger | rent route credit + ledger block L176-203 | **exact** |

---

## Pattern Assignments

### `transfer/route.ts` (NEW — atomic ownership transfer / sale)  — THE keystone

**Analog:** `apps/tg-miniapp/app/api/tma/templates/[id]/rent/route.ts` (LIVE on prod). This is the single most important file to copy. It already does: stored-price guard, self-deal guard, idempotency pre-check, claim-slot via partial-unique index, **guarded debit of buyer**, **upsert-credit of seller (100% pass-through, AIAG 0%)**, **two equal-and-opposite ledger entries sharing one `ref_id`**, and a clone — all in ONE `sql.begin`.

**File header / module setup (copy verbatim):**
```typescript
import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PRICE_CREDITS = 100_000; // $1000 sanity ceiling, mirrors rent/publish
```

**Auth + cheap fail-fast guards BEFORE the tx (rent route L49-92):**
```typescript
const buyerId = req.headers.get('x-tma-user-id');
if (!buyerId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
if (!UUID_RE.test(params.id)) return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
// SELF-DEAL GUARD (rent L81): cannot buy your own agent
if (buyerId === sellerId) return NextResponse.json({ error: 'self_deal' }, { status: 403 });
// AMOUNT GUARD (rent L89): price is the STORED price, never client input; reject <=0 / >MAX
const price = Number(storedPrice);
if (!Number.isInteger(price) || price <= 0 || price > MAX_PRICE_CREDITS)
  return NextResponse.json({ error: 'invalid_price' }, { status: 400 });
```

**Core atomic-transfer pattern (DIRECTLY ADAPTED from rent L122-240).** The single `sql.begin` must do, in order:
```typescript
let insufficient = false, alreadyTransferred = false;
try {
  await sql.begin(async (sql) => {
    // a) CLAIM-GUARD: ownership reassign is the slot. Guard on CURRENT owner so a
    //    concurrent/retried transfer is a no-op (mirrors rent's uq_rental_active idea).
    //    0 rows ⇒ already transferred / not owned by seller ⇒ throw ⇒ rollback.
    const claim = await sql`
      UPDATE agents
      SET tg_user_id = ${buyerId}::bigint, updated_at = NOW()
      WHERE id = ${params.id}::uuid
        AND tg_user_id = ${sellerId}::bigint
        AND status != 'deleted'
      RETURNING id::text
    `;
    if (claim.length === 0) { alreadyTransferred = true; throw new Error('not_owner_or_transferred'); }

    // b) SALE ONLY: guarded debit of buyer (rent L163 verbatim shape) — over-spend safe.
    const debit = await sql`
      UPDATE tg_user_balances
      SET balance_credits = balance_credits - ${price}, updated_at = NOW()
      WHERE tg_user_id = ${buyerId}::bigint AND balance_credits >= ${price}
      RETURNING balance_credits::text AS balance_credits
    `;
    if (debit.length === 0) { insufficient = true; throw new Error('insufficient_balance'); }

    // c) SALE ONLY: upsert-credit seller, 100% pass-through, AIAG 0% (rent L176).
    const credit = await sql`
      INSERT INTO tg_user_balances (tg_user_id, balance_credits, updated_at)
      VALUES (${sellerId}::bigint, ${price}::bigint, NOW())
      ON CONFLICT (tg_user_id) DO UPDATE
        SET balance_credits = tg_user_balances.balance_credits + EXCLUDED.balance_credits,
            updated_at = NOW()
      RETURNING balance_credits::text AS balance_credits
    `;

    // d) Two equal-and-opposite ledger rows, ONE ref_id (a transfer_charges.id),
    //    different kind — NO platform-fee line (rent L188-203 verbatim, new kinds).
    //    kind ∈ {'transfer_debit','transfer_credit'}; ref_kind='transfer_charge'.

    // e) WIPE personal history (CONTEXT.md: личные чаты стёрты). This is a DELETE,
    //    not in the rent analog — agent_runs IS the history store (loadHistory db.ts L234).
    await sql`DELETE FROM agent_runs WHERE agent_id = ${params.id}::uuid`;

    // f) RE-KEY memory blob to new owner (see crypto section) — agent_memory rows.
    // g) Strip secrets the new owner must not inherit (spec-not-data rule):
    await sql`
      UPDATE agents SET external_api_key_encrypted = NULL, external_api_key_hint = NULL,
        mcp_auth_encrypted = NULL, connection_type = 'aiag',
        budget_credits_monthly = 100000, spent_today_credits = 0
      WHERE id = ${params.id}::uuid
    `;
    // h) Record the transfer row + NFT transfer (TON, see TON section).
  });
} catch (e) {
  if (insufficient) return NextResponse.json({ error: 'insufficient_balance' }, { status: 402 });
  if (alreadyTransferred) return NextResponse.json({ error: 'not_transferable' }, { status: 409 });
  return NextResponse.json({ error: 'transfer_failed' }, { status: 500 });
}
```

**REPLICATE:** the boolean-flag-then-throw-then-classify-in-catch idiom (rent L120-121, L242-269); guarded `UPDATE ... WHERE <guard> RETURNING`; equal-and-opposite ledger pair under one `ref_id`; `ON CONFLICT (ref_kind, ref_id, kind) WHERE ref_id IS NOT NULL DO NOTHING` idempotency.
**CHANGE vs rent:** transfer **MOVES** the existing agent row (single `UPDATE agents SET tg_user_id`) instead of **cloning** a new one (rent's `INSERT INTO agents`). Add the history `DELETE`, the secret-strip, and the memory re-key. For a **gift** (price=0), skip steps b/c/d entirely — the same guard at FREE clone route precedent (`/clone` charges nothing). For **sale cash-out OUT**, gate behind FD-2 (CONTEXT.md) — internal credit payout works without it.

---

### `make-transferable/route.ts` (NEW — opt-in mint)

**Analog A (the opt-in flip + ownership guard):** `apps/tg-miniapp/app/api/tma/agents/[id]/publish/route.ts`. Publish is the precedent for "owner flips a flag on their own agent" with the `id + tg_user_id` ownership guard (L33-41) and UUID validation. Copy `loadShareSpec`'s ownership-guard shape:
```typescript
WHERE id = ${id}::uuid AND tg_user_id = ${tgUserId}::bigint AND status != 'deleted'
```
**REPLICATE:** ownership guard, `MAX_PRICE_CREDITS` price-validation block (publish L82-90) for the optional listing price.
**CHANGE:** instead of snapshotting into `agent_templates`, this route (1) mints a TEP-62 NFT on TON, (2) writes `agents.nft_address` + `agents.transferable = true`. Mint is the ONLY gas point (CONTEXT.md decision #3, opt-in).

**Analog B (the TON I/O):** see TON section — `topup/check` shows the TonCenter fetch/verify pattern.

---

### `0039_agent_transfers.sql` (NEW migration)

**Analog:** `packages/database/migrations/0032_template_rentals.sql` (the live Wave-1 money migration). Copy its EXACT structure: header comment block (manual-apply note + `sudo -u postgres psql aiag -f`), `CREATE TABLE IF NOT EXISTS`, `CHECK (price_credits > 0)`, FKs WITHOUT `ON DELETE CASCADE` (immutable money audit trail), and the ledger-kind documentation comment.

**Header to copy (0032 L1-22 shape):**
```sql
-- 0039_agent_transfers.sql
-- R1.4 — atomic agent ownership transfer/sale (+ opt-in TON NFT binding).
-- Builds ON TOP of the live D-0/D-1 foundation (tg_user_balances + tg_ledger_entries)
-- and the Wave-1 rent pattern (0032). Changes nothing in them.
-- Apply on prod manually (app `aiag` role cannot ALTER):
--   sudo -u postgres psql aiag -f 0039_agent_transfers.sql
-- Additive + idempotent: CREATE TABLE/INDEX IF NOT EXISTS.
```

**`transfer_charges` table (mirror `rent_charges` 0032 L57-66 — the idempotency anchor):**
```sql
CREATE TABLE IF NOT EXISTS transfer_charges (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          UUID NOT NULL REFERENCES agents(id),   -- NO cascade: audit trail
  buyer_tg_user_id  BIGINT NOT NULL,
  seller_tg_user_id BIGINT NOT NULL,
  amount_credits    BIGINT NOT NULL CHECK (amount_credits >= 0), -- 0 = gift
  kind              VARCHAR(16) NOT NULL,    -- 'sale' | 'gift'
  status            VARCHAR(16) NOT NULL DEFAULT 'pending',
  nft_tx_hash       TEXT,                    -- TON transfer tx
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at        TIMESTAMPTZ
);
```
**Ledger-kind doc comment (mirror 0032 L73-78):** new `kind ∈ {'transfer_debit','transfer_credit'}`, `ref_kind = 'transfer_charge'` — both share one `ref_id`, each idempotent under live `uq_ledger_ref` (0029 L114). **No ALTER to `tg_ledger_entries` needed** — `kind`/`ref_kind` are `VARCHAR(24)` with no CHECK.

**New `agents` columns — additive ALTER pattern.** Analog = `0027_agents_external_api_key_hint.sql` / `0028_agents_mcp.sql` (both additive `ADD COLUMN IF NOT EXISTS` on `agents`). Add:
```sql
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS transferable      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS nft_address       TEXT,    -- TEP-62 item address on TON
  ADD COLUMN IF NOT EXISTS nft_owner_wallet  TEXT,    -- current owner's TON wallet
  ADD COLUMN IF NOT EXISTS memory_owner_key  TEXT;    -- X25519 pubkey memory is encrypted to
```
**Note for planner:** latest live migration is **0038**, so the next number is **0039**. But `packages/database/CLAUDE.md` warns prod is untracked — verify against the VPS before assuming 0033-0038 are all applied.

---

## Shared Patterns

### Atomic money (the load-bearing invariant)
**Source:** `apps/agent-worker/src/db.ts` `settleRun` L514-575 + rent route L122-240.
**Apply to:** the entire transfer/sale tx.
The non-negotiable shape (SECURITY.md L14-15): READ COMMITTED + guarded `UPDATE ... WHERE <guard> RETURNING`; **no** SERIALIZABLE, **no** 40001 retry loop. The WHERE-guard (`balance_credits >= ${price}` and `tg_user_id = ${sellerId}`) is what prevents double-spend and stolen-agent transfer. Use the callback-scoped `sql` inside `sql.begin`, never the module-level one (db.ts L525-527 comment).
```typescript
const debit = await sql`
  UPDATE tg_user_balances
  SET balance_credits = balance_credits - ${costCredits}, updated_at = NOW()
  WHERE tg_user_id = ${tgUserId}::bigint AND balance_credits >= ${costCredits}
  RETURNING balance_credits::text
`;
if (debit.length === 0) throw new InsufficientBalanceError();
```

### Append-only ledger (audit truth never diverges from cached balance)
**Source:** `0029_usd_ledger.sql` L102-116 (table) + every money route's insert.
**Apply to:** transfer debit + credit.
1 credit = 1 US cent (BIGINT). Each entry carries `balance_after` from the debit/credit's `RETURNING`, written in the SAME `sql.begin`. Idempotent via:
```sql
ON CONFLICT (ref_kind, ref_id, kind) WHERE ref_id IS NOT NULL DO NOTHING
```

### Encryption at rest (AES-256-GCM)
**Source:** `apps/tg-miniapp/src/lib/crypto.ts` (mirrored in `apps/agent-worker/src/crypto.ts`).
**Apply to:** memory blob re-encryption on transfer.
```typescript
const ALGO = 'aes-256-gcm'; const IV_LEN = 12; const TAG_LEN = 16;
// key from process.env.TMA_KEY_ENCRYPTION_KEY (64 hex chars = 32 bytes)
export function encryptSecret(plain: string): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]); // iv || ct || tag
}
```
**REPLICATE:** the `iv || ciphertext || tag` Buffer layout, the env-key loader, base64 storage convention (`encryptSecret(x).toString('base64')`, agents route L167).
**CHANGE / ADD for R1.4:** CONTEXT.md asks for an **X25519 re-key** to the new owner. The existing code is symmetric (single server key) — there is NO X25519/asymmetric helper yet. Per CONTEXT.md decision (backend = trusted decrypt→re-key point; personal chats already wiped so privacy bar is low), the simplest path is: keep the existing server-side AES key and just re-encrypt the obezličennaja memory blob; the X25519-per-owner layer is the documented upgrade. **Open question #1 in CONTEXT.md — planner picks the trust model.** Memory store = `agent_memory` (key/value text rows, `0023_agent_memory.sql`); MVP memory is nearly empty (CONTEXT.md honest-flag: real pgvector memory is R1.2 D-5, not built) → MVP can ship transfer of config+persona and defer the memory re-key.

### History store (what "wipe personal history" means concretely)
**Source:** `loadHistory` `apps/agent-worker/src/db.ts` L234-250 reads from `agent_runs`.
**Apply to:** transfer step (e). There is no separate "messages" table — conversation history IS `agent_runs.input/output`. Wipe = `DELETE FROM agent_runs WHERE agent_id = ${id}`. (`agent_runs` has `ON DELETE CASCADE` only from the agents FK; deleting runs alone is a plain DELETE.)

### Ownership model
**Source:** `0018_agents.sql` L4-19 + `agents/route.ts`.
`agents.tg_user_id BIGINT` is the owner (no FK to a users table — `tg_user_id` is the Telegram id, used as `::bigint` everywhere). Every owner-scoped query guards `WHERE ... AND tg_user_id = ${tgUserId}::bigint` (create/list route L36, publish L38, PATCH/GET in `[id]/route.ts`). Transfer = the ONE place that legitimately changes `tg_user_id` — guard it on the OLD owner in the UPDATE WHERE.

---

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| TEP-62 NFT **mint + transfer** (TON write) | utility | TON write | Codebase only **reads/verifies** TON (`topup/check/[id]/route.ts` polls TonCenter v3 for inbound txs; no contract deploy, no outbound NFT transfer, no TON Connect send-tx). Closest reusable bits: TonCenter base-url envs (`TONCENTER_API_URL`, `TONCENTER_API_KEY`, `TMA_TOPUP_WALLET_ADDRESS`) and the nano-value/comment-tag matching loop (L70-127). For mint/transfer the planner needs NEW code — use a TON SDK (`@ton/ton` / `tonweb`) and verify via the SAME TonCenter read pattern. Open question #2 in CONTEXT.md (own collection contract vs GetGems/Telegram-gifts launchpad). Honest-flag: mint is opt-in + the ONLY gas point; everything else stays off-chain DB. |

**Partial-analog note:** the X25519 asymmetric re-key has no code precedent (only symmetric AES-256-GCM exists). Treat as new utility; MVP may defer (memory is near-empty pre-D-5).

---

## Metadata

**Analog search scope:** `apps/tg-miniapp/app/api/tma/**` (routes), `apps/agent-worker/src/{db,crypto,agent-runner}.ts`, `packages/database/migrations/0018,0023,0029,0032`, `apps/tg-miniapp/src/lib/crypto.ts`.
**Files scanned:** ~12 (via graphify scoped subgraphs + targeted reads).
**Pattern extraction date:** 2026-06-10

---

## PATTERN MAPPING COMPLETE

**Phase:** 16 — R1.4 Transferable Agent (iNFT-on-TON)
**Files classified:** 9
**Analogs found:** 8 / 9

### Coverage
- Files with exact analog: 3 (transfer tx, migration, seller payout/ledger)
- Files with role-match analog: 5 (make-transferable, agents-columns, ownership reassign, memory re-key/crypto, history wipe)
- Files with no analog: 1 (TEP-62 NFT mint+transfer — TON write side; only read/verify precedent exists)

### Key Patterns Identified
- The Wave-1 PAID-RENT route (`templates/[id]/rent/route.ts`) is a near-perfect template for the transfer/sale tx: one `sql.begin`, guarded `UPDATE...WHERE balance>=x RETURNING` debit, upsert-credit seller at 100% (AIAG 0%), two equal-and-opposite ledger rows under one `ref_id`, idempotency via `ON CONFLICT (ref_kind,ref_id,kind)`. Transfer MOVES the agent (UPDATE tg_user_id) instead of cloning.
- Migration mirrors `0032_template_rentals.sql` exactly (manual `sudo -u postgres psql`, additive/idempotent, FK without CASCADE for audit trail, ledger-kind doc comment, no ALTER to `tg_ledger_entries`). Next number = 0039 (verify vs prod — untracked).
- Encryption reuses AES-256-GCM `crypto.ts` (`iv||ct||tag`, env key); X25519 re-key + TON NFT mint/transfer are the only genuinely-new pieces — and CONTEXT.md flags both as deferrable (memory near-empty pre-D-5; mint is opt-in, the sole gas point).
