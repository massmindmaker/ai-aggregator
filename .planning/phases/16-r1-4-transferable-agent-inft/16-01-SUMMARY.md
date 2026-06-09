---
phase: 16-r1-4-transferable-agent-inft
plan: "01"
subsystem: database
tags: [migration, schema, transfer, nft, money-path, ddl]
dependency_graph:
  requires:
    - "0032_template_rentals.sql (rent_charges shape — direct structural analog)"
    - "migration 0029 (uq_ledger_ref unique index — reused by transfer ledger rows)"
    - "agents table (0018/0021/0028/0029 columns — extended additively)"
  provides:
    - "transfer_charges table (idempotency anchor for transfer/sale money movement)"
    - "agents.transferable + transfer_price_credits + nft_address + nft_owner_wallet + memory_owner_key"
  affects:
    - "16-02-PLAN.md (make-transferable API reads/writes these columns)"
    - "16-03-PLAN.md (transfer/sale tx reads transfer_charges)"
    - "16-04-PLAN.md (webhook finalizer settles transfer_charges rows)"
tech_stack:
  added: []
  patterns:
    - "Additive idempotent DDL (CREATE TABLE/INDEX IF NOT EXISTS; ADD COLUMN IF NOT EXISTS)"
    - "FK without ON DELETE CASCADE for immutable money audit trail (mirrors 0032)"
    - "DB-level CHECK (amount_credits >= 0) as defense-in-depth against negative charge inversion"
    - "Partial index on status='pending' for efficient queue polling"
key_files:
  created:
    - packages/database/migrations/0039_agent_transfers.sql
  modified: []
decisions:
  - "amount_credits CHECK >= 0 (not > 0): allows gift transfers (amount = 0), unlike rent_charges which requires > 0"
  - "transfer_charges has `kind` column ('sale'|'gift') to distinguish at the row level; rent_charges has no kind because all rents are paid"
  - "startonus_invoice_id column included for Startonus NFT mint/transfer reconciliation (R1.4 webhook plan)"
  - "nft_tx_hash nullable: set only after TON webhook confirms mint/transfer"
metrics:
  duration: "~10 minutes"
  completed: "2026-06-10"
  tasks_completed: 1
  tasks_total: 1
  files_created: 1
  files_modified: 0
---

# Phase 16 Plan 01: Agent Transfers Schema Summary

**One-liner:** DDL-only migration adding `transfer_charges` idempotency-anchor table and five additive `agents` columns for R1.4 agent ownership transfer/sale with opt-in TON NFT binding.

## What Was Built

`packages/database/migrations/0039_agent_transfers.sql` — a hand-runnable, additive, idempotent migration that lays the schema foundation for every downstream R1.4 plan. It mirrors the live `0032_template_rentals.sql` structure exactly:

**Additive columns on `agents`:**
- `transferable BOOLEAN NOT NULL DEFAULT FALSE` — opt-in flag; agents are non-transferable by default
- `transfer_price_credits BIGINT` — NULL = gift-only; >0 = sale price in US cents
- `nft_address TEXT` — TEP-62 NFT item address on TON (NULL until minted via Startonus)
- `nft_owner_wallet TEXT` — current owner's TON wallet (updated on transfer settle)
- `memory_owner_key TEXT` — encryption key seam for memory re-keying (NULL pre-D-5)

**`transfer_charges` table** — the idempotency anchor for one transfer money movement:
- `id UUID` — the ledger `ref_id` for both `transfer_debit` (buyer) and `transfer_credit` (seller)
- FK to `agents(id)` WITHOUT ON DELETE CASCADE (immutable audit trail)
- `CHECK (amount_credits >= 0)` — DB-level defence; 0 = gift, >0 = sale (US cents)
- `kind VARCHAR(16)` — 'sale' | 'gift' (row-level distinction)
- `status VARCHAR(16)` — 'pending' | 'settled' | 'failed'
- `nft_tx_hash TEXT` / `startonus_invoice_id TEXT` — TON + Startonus reconciliation fields
- Two indexes: `idx_transfer_charges_agent` (full) + `idx_transfer_charges_pending` (partial on pending)

**Ledger kinds documented (no ALTER needed):** `transfer_debit` / `transfer_credit` reuse the live `uq_ledger_ref(ref_kind, ref_id, kind)` unique index (migration 0029) — each payout row is exactly-once on webhook retry.

## Verification

Automated verify command (from plan):
```
grep -q "CREATE TABLE IF NOT EXISTS transfer_charges" ... &&
grep -q "ADD COLUMN IF NOT EXISTS transferable" ... &&
grep -q "amount_credits       BIGINT NOT NULL CHECK (amount_credits >= 0)" ... &&
echo OK
```
**Result: OK**

All acceptance criteria passed:
- File exists at `packages/database/migrations/0039_agent_transfers.sql`
- `CREATE TABLE IF NOT EXISTS transfer_charges` present
- All 5 `ADD COLUMN IF NOT EXISTS` columns present
- `CHECK (amount_credits >= 0)` present
- `sudo -u postgres psql aiag -f` apply note present
- No `ALTER TABLE tg_ledger_entries` (grep found nothing)
- No `ON DELETE CASCADE` in the FK (grep found nothing — the comment mentions the absence, not the presence)

## Production Application

**This migration is NOT auto-applied.** It must be hand-run on the VPS:

```bash
sudo -u postgres psql aiag -f 0039_agent_transfers.sql
```

**Before applying:** verify the sequence number against prod. Prod migrations are untracked — confirm what is actually live (PATTERNS.md states latest live is ~0038). If any gap exists between the file name and the last applied migration, apply missing ones first.

**The migration is idempotent:** re-running is a safe no-op (all statements use `IF NOT EXISTS`).

## Deviations from Plan

None — plan executed exactly as written.

## Threat Flags

None — this is pure DDL with no new network endpoints, auth paths, or file access patterns. All STRIDE threats in the plan's threat register (T-16-01 through T-16-04) are mitigated by the schema as written.

## Self-Check: PASSED

- `packages/database/migrations/0039_agent_transfers.sql` — FOUND (created mode in commit c5c58d8)
- Commit `c5c58d8` — FOUND (`git rev-parse --short HEAD` returned c5c58d8)
- Automated verify command — PASSED (output: OK)
- No `ALTER TABLE tg_ledger_entries` — CONFIRMED
- No `ON DELETE CASCADE` in FK definition — CONFIRMED
