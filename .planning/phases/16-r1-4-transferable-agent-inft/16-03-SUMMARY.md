---
phase: 16-r1-4-transferable-agent-inft
plan: "03"
subsystem: tma-api
tags: [transfer, sale, nft, money-path, webhook, atomic-tx, idempotency, startonus, keystone]
dependency_graph:
  requires:
    - "16-01: transfer_charges table + agents.transferable/transfer_price_credits/nft_address (migration 0039)"
    - "16-02: make-transferable flag + transfer-offer public read"
    - "16-05: rewritten Startonus client (generateInvoice templateId/address/owner/nftPrice/nftData + StartonusCallback)"
    - "templates/[id]/rent (atomic money invariant: guarded debit + 100% credit + 2 ledger rows)"
    - "nft/purchase + nft/webhook (Phase-15 async-confirm STRUCTURE)"
    - "tg_ledger_entries + uq_ledger_ref(ref_kind, ref_id, kind) (migration 0029)"
  provides:
    - "POST /tg/api/tma/agents/[id]/transfer (acquirer-initiated, acquirer-paid lazy mint + pending charge)"
    - "POST /tg/api/tma/agents/transfer/webhook (atomic finalizer: move + wipe + strip + sale payout)"
  affects:
    - "16-04 (offer page UI consumes the initiate route; memory re-key seam doc/edge-cases)"
tech_stack:
  added: []
  patterns:
    - "Two-step async transfer (initiate → Startonus mint → webhook confirm) — Phase-15 nft pattern"
    - "Single sql.begin atomic move + money tx — Wave-1 rent invariant"
    - "Idempotent webhook: forward-only transfer_charges.status + ON CONFLICT (ref_kind, ref_id, kind) DO NOTHING"
    - "Boolean-flag-then-throw-then-classify rollback idiom (rent precedent)"
    - "Rollback-marks-failed (not pending) so a paid-mint buyer is never locked out (WARNING-1)"
key_files:
  created:
    - apps/tg-miniapp/app/api/tma/agents/[id]/transfer/route.ts
    - apps/tg-miniapp/app/api/tma/agents/transfer/webhook/route.ts
  modified: []
decisions:
  - "Gift mint-payer LOCKED = recipient/acquirer (CONTEXT.md open Q#2 resolved): the caller who initiates IS the mint-payer for BOTH gift and sale; no donor-paid path in MVP. Only difference = amount_credits (0 vs price)."
  - "409 transfer_pending committed MVP path: a pre-existing pending charge → 409; NO reuse/re-derive of startonus_invoice_id (ambiguous branch removed)."
  - "Rollback marks the charge status='failed' (guarded WHERE status='pending'), NOT left pending, so the 409 guard releases and the buyer can re-initiate after they already paid the mint (WARNING-1, T-16-15)."
  - "nftData uses agents.description (no `role` column) + a deterministic monogram URL on our own domain (no `avatar`/`portrait` column) — white-label, never an upstream image host (T-16-17)."
  - "Memory re-key is a documented STUB referencing R1.2 D-5 (memory near-empty pre-D-5); no X25519 implemented (plan 16-04 owns the seam)."
metrics:
  duration: "~25 minutes"
  completed: "2026-06-10"
  tasks_completed: 2
  tasks_total: 2
  files_created: 2
  files_modified: 0
---

# Phase 16 Plan 03: Async Transfer/Sale Money Path Summary

**One-liner:** The keystone two-step transferable-agent flow — an acquirer-initiated, acquirer-paid lazy Startonus mint (pending `transfer_charges` + TON Connect tx) finalized ONLY on the webhook in one `sql.begin` that atomically moves ownership (guarded on the old owner), wipes personal history, strips inherited secrets, and (for a sale) debits the buyer + credits the seller 100% (AIAG 0%) with idempotent equal-and-opposite ledger rows.

## What Was Built

### Task 1 — Transfer/sale INITIATE route (new) — commit `d2209c0`

`POST /tg/api/tma/agents/[id]/transfer`

The acquirer (recipient) requests the agent. The route:
1. Authenticates the caller via `x-tma-user-id` (the caller IS the acquirer + mint-payer → `owner.tgId`). UUID-guards `params.id`; parses JSON; requires `recipient_address`.
2. Loads the agent + transfer state, reading the **STORED** `transfer_price_credits` (never client input). Rejects deleted/missing (404 `not_found`) and non-transferable (409 `not_transferable`).
3. **SELF-DEAL GUARD**: `buyerId === sellerId` → 403 `self_deal`.
4. Determines `kind`: NULL stored price → `gift` (amount 0); else → `sale` (validated positive integer ≤ MAX_PRICE_CREDITS = 100_000). LOCKED: the acquirer pays the mint for both; only `amount_credits` differs.
5. **PENDING idempotency (409 path)**: a pre-existing `pending` charge for the agent → 409 `transfer_pending`. No reuse/re-derive branch, no `startonus_invoice_id` SELECT.
6. Inserts the `pending` `transfer_charges` row (the webhook anchor + ledger `ref_id`).
7. Reads the THREE current env vars (`STARTONUS_SECRET`, `STARTONUS_AGENT_COLLECTION_ADDRESS`, `STARTONUS_AGENT_MINT_TEMPLATE_ID`; the old `STARTONUS_AGENT_COLLECTION_ID` is absent). Any unset → 503 `minter_not_configured` AND the charge is marked `failed`. Calls the rewritten `generateInvoice` with `templateId`/`address`/`owner: { tgId, wallet }`/`nftPrice = tonToNano(STARTONUS_AGENT_MINT_TON ?? '0.1')`/`nftData` (white-label card)/`userData = chargeId`/`callbackUrl = …/tg/api/tma/agents/transfer/webhook`. Stores `startonus_invoice_id`; returns the TON Connect tx. On failure → mark `failed` + 502 `minter_unavailable`.

This route NEVER moves ownership, debits/credits, or deletes history — all of that is the webhook's job.

### Task 2 — Webhook FINALIZER (new) — commit `487ce03`

`POST /tg/api/tma/agents/transfer/webhook`

The async confirm. Unknown/spoofed `userData` (no charge row) → 404. `failed`/`error` → mark failed (guarded). `invoice_paid`/`paid` → record tx hash, stay pending. `minted`:
- Already `settled` → `{ ok:true, skipped:'already_settled' }`; already `failed` → `{ ok:true, skipped:'failed' }` (idempotent, no second move).
- Else, in ONE `sql.begin`:
  - **(a) claim-guard ownership move**: `UPDATE agents SET tg_user_id = buyerId WHERE id = agentId AND tg_user_id = sellerId AND status != 'deleted' RETURNING id`. 0 rows → `already_moved` → throw → rollback.
  - **(b–d) sale only (amount > 0)**: guarded buyer debit (`balance_credits >= amount`; 0 rows → `insufficient` → throw → rollback), 100% seller upsert-credit (AIAG 0%), two equal-and-opposite ledger rows (`transfer_debit` −amount / `transfer_credit` +amount) under one `ref_id = chargeId` with `ON CONFLICT (ref_kind, ref_id, kind) WHERE ref_id IS NOT NULL DO NOTHING`. Gift (amount 0) skips all of this.
  - **(e) history wipe**: `DELETE FROM agent_runs WHERE agent_id = …`.
  - **(f) secret strip + flags + nft_address**: NULLs `external_api_key_encrypted`/`external_api_key_hint`/`external_base_url`/`external_model_slug`/`mcp_auth_encrypted`, resets `connection_type='aiag'`, `budget_credits_monthly = 100000` (0029 DEFAULT), `spent_today_credits = 0`, clears `transferable`/`transfer_price_credits`, stores the minted item address on the existing `agents.nft_address` (0039; prefers callback `item`, falls back to `nftAddress`).
  - **(g) memory re-key STUB** referencing D-5 (no X25519).
  - **(h) settle** the charge (`status='settled'`, record `nft_tx_hash`, `settled_at`).
- On ANY rollback, the catch runs `UPDATE transfer_charges SET status='failed' WHERE id = …::uuid AND status = 'pending'` — a stuck pending never locks the buyer out (WARNING-1); the `status='pending'` guard never clobbers a settled row. Returns 402 `insufficient_balance`, `skipped:'already_moved'`, or 500 `finalize_failed` as classified.

## Atomicity / Idempotency / Self-deal / History-wipe mechanisms (as implemented)

- **Atomic money + ownership**: the entire finalize (move + wipe + strip + sale debit/credit + ledger pair + settle) is in ONE `sql.begin`. Any throw rolls back the whole tx — ownership never moves without the money moving, and vice-versa. READ COMMITTED, guarded `UPDATE … WHERE <guard> RETURNING` (no SERIALIZABLE/40001 loop), matching the rent invariant and SECURITY.md.
- **Idempotency**: forward-only `transfer_charges.status` (a retried `minted` on a settled/failed charge is a no-op `skipped`) + `ON CONFLICT (ref_kind, ref_id, kind) DO NOTHING` on both ledger rows + the claim-guard returning 0 rows on a replay after the agent already moved. A duplicate callback can neither double-credit the seller nor re-run the re-key.
- **Self-deal guard**: server-side `buyerId === sellerId` → 403 in the initiate route, independent of UI.
- **History wipe**: `DELETE FROM agent_runs WHERE agent_id` inside the same tx (config/persona/skills move; personal chats do not — the transfer-without-history decision).
- **Webhook auth (T-16-09)**: unguessable `transfer_charges` UUID in `userData` + the seller-guarded ownership UPDATE + nginx IP-allowlist (deploy task below). Startonus does not sign webhooks.
- **White-label**: no "Startonus" string in any user-facing response; minter errors map to `minter_unavailable` / `minter_not_configured` / `finalize_failed`. `nftData.image` is a URL on our own domain.

## Verification Results (no local runtime — grep + typecheck only)

**Task 1 automated verify:** `OK` (generateInvoice; userData: chargeId; transfer/webhook; transfer_pending; STARTONUS_AGENT_COLLECTION_ADDRESS; STARTONUS_AGENT_MINT_TEMPLATE_ID; owner:; nftData all present; STARTONUS_AGENT_COLLECTION_ID, DELETE FROM agent_runs, and a buyerId ownership-reassign all ABSENT).

**Task 2 automated verify:** `OK` (sql.begin; `tg_user_id = ${buyerId}::bigint`; `AND tg_user_id = ${sellerId}::bigint`; `DELETE FROM agent_runs WHERE agent_id`; `'transfer_debit'`; `'transfer_credit'`; `external_api_key_encrypted = NULL`; `nft_address = ${item`; `status='failed' WHERE id = ${c.id}::uuid AND status = 'pending'`; D-5 all present).

**Typecheck (`bun run typecheck`):** both new files have ZERO TS errors. One pre-existing, out-of-scope error remains in `apps/tg-miniapp/app/api/tma/nft/purchase/route.ts` (`collectionId` no longer in `GenerateInvoiceParams`) — caused by the 16-05 client rewrite + the now-rebuilt shared `dist`, NOT by this plan. Logged to `deferred-items.md` (DEF-16-01).

**Schema cross-check:** confirmed against live migrations — `tg_ledger_entries(delta_credits, kind, ref_kind, ref_id, balance_after)`, `uq_ledger_ref(ref_kind, ref_id, kind) WHERE ref_id IS NOT NULL` (0029), `budget_credits_monthly` DEFAULT 100000, `spent_today_credits` DEFAULT 0, `agents.external_api_key_encrypted` (0021), `agents.nft_address` (0039). All column names in both routes match the live schema.

## user_setup — VPS / operator setup REQUIRED before going live

This is the LIVE money path. No local runtime — functional verification (a real Startonus mint + a real webhook) happens on the VPS after deploy.

**ONE-TIME, MANUAL (no API for collection creation) — via `@startonus_bot`:**
1. `/createCollection` → deploys ONE shared "Агенты" collection contract on TON (each agent = an item). Verify the deploy cost + contract owner directly in the bot (docs do not state them).
2. Configure the mint-set template (name/description/image/price) for that collection.
3. `/createMinterSecret` → the minter secret.
4. Get the template `id` via `/mintStats` (or the admin panel).

**Env (`/srv/aiag/shared/.env`):**
```
STARTONUS_SECRET=…                       # minter secret (server-side ONLY, never returned/logged — T-16-16)
STARTONUS_AGENT_COLLECTION_ADDRESS=…     # collection contract (the ONE shared "Агенты" collection)
STARTONUS_AGENT_MINT_TEMPLATE_ID=…       # mint-set template id
STARTONUS_AGENT_MINT_TON=0.1             # optional, mint fee in TON (default 0.1)
PUBLIC_BASE_URL=https://app.ai-aggregator.ru   # optional (used for callbackUrl + monogram image)
```
These THREE REPLACE the old `STARTONUS_AGENT_COLLECTION_ID`.

**nginx IP-allowlist (webhook auth, T-16-09):** the new `/tg/api/tma/agents/transfer/webhook` path is an unsigned external entry point. Add a Startonus IP-allowlist (mirror the existing `/tg/api/tma/nft/webhook` allowlist) BEFORE going live — do NOT trust an unauthenticated caller to move money/ownership. Defence in depth = allowlist + unguessable UUID in `userData` + the seller-guarded ownership UPDATE.

**Build:** tg-miniapp is built MANUALLY on the VPS (turbo libs first — gateway/db/**shared**). NOTE: the shared `dist` MUST be rebuilt so the rewritten 16-05 Startonus client is picked up (this plan rebuilt it locally only for typecheck; `dist` is gitignored and rebuilt on the VPS).

## Deviations from Plan

**[Rule 3 — Blocking] Rebuilt `@aiag/shared` dist.** The 16-05 Startonus client rewrite was committed to source, but `packages/shared/dist` (gitignored build artifact) was stale (still the old `collectionId` contract). `@aiag/shared` resolves via `dist/*.d.ts`, so the whole app failed typecheck (`templateId does not exist in GenerateInvoiceParams`) until `bun run build` was run in `packages/shared`. Rebuilt; no source change. Documented as the VPS build note above.

**[Rule 3 — Schema mismatch] nftData fields adapted to the real `agents` schema.** The plan's example SELECT referenced `role` and `avatar_url` columns, which do NOT exist on `agents` (verified: only `name`/`description`/`model_slug` from 0018; no avatar/portrait/role column anywhere). The plan explicitly instructs "confirm the real column names … use what exists; fall back to a deterministic monogram URL." Implemented accordingly: `nftData.description` ← `agents.description` (sliced to 200), `nftData.image` ← deterministic monogram on our own domain (`{PUBLIC_BASE_URL}/tg/og/agent/{id}.png`), `attributes` ← `[{type:'model', value: model_slug}]`. White-label preserved (T-16-17).

**[Out of scope, logged not fixed] DEF-16-01** — `nft/purchase/route.ts` (Phase-15) typecheck breakage caused by the 16-05 client rewrite. Pre-existing file, not in this plan, last touched `c72db50` long before this work. Logged to `deferred-items.md`; the legacy speculative NFT catalog is slated for removal (CLAUDE.md decision #4).

## Known Stubs

| Stub | File:line | Reason |
|------|-----------|--------|
| Memory re-key | `agents/transfer/webhook/route.ts` step (g) | INTENTIONAL — memory is near-empty pre-R1.2 D-5; the seam is a documented no-op TODO(D-5). Plan 16-04 owns the seam doc/edge-cases. Does not block the plan goal (MVP = ownership + spec transfer + history wipe + mint + sale payout). |

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: unsigned-external-webhook | apps/tg-miniapp/app/api/tma/agents/transfer/webhook/route.ts | New unsigned external entry point that moves money + ownership. Mitigated per T-16-09 (unguessable UUID userData + seller-guarded UPDATE + nginx IP-allowlist deploy task). Already in the plan's threat register; flagged here as the live deploy gate. |

## Self-Check: PASSED

- `apps/tg-miniapp/app/api/tma/agents/[id]/transfer/route.ts` — FOUND (commit d2209c0)
- `apps/tg-miniapp/app/api/tma/agents/transfer/webhook/route.ts` — FOUND (commit 487ce03)
- Commit `d2209c0` — FOUND in git log
- Commit `487ce03` — FOUND in git log
- Task 1 automated verify — PASSED (OK)
- Task 2 automated verify — PASSED (OK)
- Typecheck — both new files 0 errors (one pre-existing out-of-scope error in nft/purchase, logged DEF-16-01)
