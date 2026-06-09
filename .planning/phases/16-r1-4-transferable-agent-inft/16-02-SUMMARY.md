---
phase: 16-r1-4-transferable-agent-inft
plan: "02"
subsystem: tma-api
tags: [transfer, nft, api-route, public-read, ownership-guard, money-path]
dependency_graph:
  requires:
    - "16-01: agents.transferable + transfer_price_credits + nft_address columns"
    - "publish/route.ts (ownership-guard + price-validation pattern)"
    - "nft/collections/route.ts (public unguarded read pattern)"
  provides:
    - "POST /tg/api/tma/agents/[id]/make-transferable (owner opt-in flag + price)"
    - "GET /tg/api/tma/agents/[id] now returns transferable + transfer_price_credits + nft_address"
    - "GET /tg/api/tma/agents/[id]/transfer-offer (PUBLIC acquirer delivery surface)"
  affects:
    - "16-03-PLAN.md (transfer/sale tx — reads make-transferable flag; uses transfer-offer shape)"
    - "16-04-PLAN.md (offer page UI — consumes transfer-offer GET; owner UI reads detail GET)"
tech_stack:
  added: []
  patterns:
    - "Ownership-guarded UPDATE WHERE id + tg_user_id + status != 'deleted' (mirrors publish route)"
    - "Public unguarded GET filtered on status flag (mirrors nft/collections route)"
    - "No-existence-oracle 404: non-transferable/deleted/missing all return same not_transferable"
key_files:
  created:
    - apps/tg-miniapp/app/api/tma/agents/[id]/make-transferable/route.ts
    - apps/tg-miniapp/app/api/tma/agents/[id]/transfer-offer/route.ts
  modified:
    - apps/tg-miniapp/app/api/tma/agents/[id]/route.ts
decisions:
  - "transfer-offer is intentionally PUBLIC (no x-tma-user-id guard) — the acquirer is not the owner; the owner-guarded detail GET 404s non-owners; without this route gift/sale UX (plan 04) is unreachable"
  - "mint_fee_ton sourced from env var AGENT_MINT_FEE_TON (default 0.1) — adjustable without redeploy"
  - "persona_preview = LEFT(description, 280) not raw system_prompt — system_prompt is too sensitive/long to surface publicly"
  - "make-transferable writes NO nft_address and imports NO generateInvoice — lazy mint is plan 03"
metrics:
  duration: "~20 minutes"
  completed: "2026-06-10"
  tasks_completed: 3
  tasks_total: 3
  files_created: 2
  files_modified: 1
---

# Phase 16 Plan 02: Make-Transferable API + Public Offer Read Summary

**One-liner:** Owner opt-in route sets `transferable=TRUE` + optional sale price (free DB flag, no mint); detail GET extended with transfer state; new PUBLIC acquirer transfer-offer read backs the offer page for gift recipients and buyers.

## What Was Built

### Task 1 — `make-transferable` route (new)

`POST /tg/api/tma/agents/[id]/make-transferable`

Owner-only flag-write that flips `agents.transferable` and (optionally) sets `agents.transfer_price_credits`. This is a free DB operation — no TON transaction, no Startonus call, no `nft_address` write. The lazy mint happens at actual transfer in plan 03.

- Header guard: missing `x-tma-user-id` → 401.
- UUID guard: bad `params.id` → 400 `invalid_id`.
- Body guard: non-boolean `transferable` → 400 `invalid_body`.
- Price guard (when `transferable: true`): `price_credits` must be a positive integer ≤ 100,000 or absent/null. Mirrors `publish/route.ts` `MAX_PRICE_CREDITS` exactly.
- When `transferable: false`: price is forced to NULL regardless of body.
- Ownership enforced by guarded UPDATE: `WHERE id = ${params.id}::uuid AND tg_user_id = ${tgUserId}::bigint AND status != 'deleted'`. Non-owner → 0 rows → 404 `not_found` (T-16-05).

### Task 2 — Agent detail GET extended (modified)

`GET /tg/api/tma/agents/[id]` (owner-guarded, unchanged)

Three columns added to the `AgentRow` interface and `loadAgent` SELECT:

```typescript
transferable: boolean;
transfer_price_credits: string | null;
nft_address: string | null;
```

`nft_owner_wallet` and `memory_owner_key` were intentionally NOT added — they are internal to the transfer settle flow and not needed by the owner detail UI (T-16-07).

### Task 3 — `transfer-offer` public route (new)

`GET /tg/api/tma/agents/[id]/transfer-offer`

The acquirer's delivery surface. INTENTIONALLY PUBLIC (no `x-tma-user-id` guard) because the gift recipient / buyer is not the agent owner, and the owner-guarded detail GET returns 404 for non-owners. This backs the offer page (plan 04).

Response fields: `id`, `name`, `role` (LEFT(description,280) — never raw `system_prompt`), `template_kind`, `model_slug`, `transfer_price_credits` (null = gift-only), `mint_fee_ton`, `status`.

Security enforced (T-16-08a):
- SELECT contains none of: `tg_user_id`, `*_encrypted`, `*_hint`, `external_base_url`, `external_model_slug`, `mcp_auth_encrypted`, `nft_owner_wallet`, `memory_owner_key`, `system_prompt`. Does not touch `agent_runs`.
- Filtered `WHERE transferable = TRUE AND status != 'deleted'` — non-transferable, deleted, and nonexistent agents all return the same `404 not_transferable` (no existence oracle).
- White-label: no "Startonus" string anywhere in the response.
- DB errors caught → 500 `internal`.

## Verification Results

**Task 1 verify:**
- `WHERE id = ${params.id}::uuid` — present (line 72)
- `tg_user_id = ${tgUserId}::bigint` — present (line 73)
- `generateInvoice` — not present

**Task 2 verify:**
- `transferable,` in SELECT — present (line 61)
- `transfer_price_credits::text AS transfer_price_credits` in SELECT — present (line 62)
- `nft_address,` in SELECT — present (line 63)
- `nft_owner_wallet` / `memory_owner_key` — not in SELECT

**Task 3 verify:**
- `AND transferable = TRUE` in WHERE — present
- `not_transferable` 404 — present
- `mint_fee_ton` in response — present
- `tg_user_id` — in comments only, not in SELECT
- `system_prompt` — in comments only, not in SELECT
- `_encrypted` — in comments only, not in SELECT
- "startonus" / "Startonus" — not present anywhere

**Typecheck:** `bun run typecheck` → clean (0 errors). One auto-fix: unused `req` parameter renamed to `_req` in transfer-offer GET (TS6133).

## Deploy Task — REQUIRED before going live (T-16-08b)

The new `transfer-offer` route is an unauthenticated public GET. Add it to the nginx
public-read rate-limit zone to prevent abusive polling:

```nginx
# In the nginx config for the /tg location block, add:
location ~ ^/tg/api/tma/agents/[^/]+/transfer-offer$ {
    limit_req zone=tma_public_read burst=20 nodelay;
    proxy_pass http://127.0.0.1:3100;
}
```

Apply before deploying plan 03/04. UUIDs are unguessable so enumeration is impractical,
but rate-limiting caps abusive polling on known UUIDs shared via links.

## Deviations from Plan

**Auto-fix (Rule 1):** Unused `req: NextRequest` parameter in `transfer-offer` GET renamed to `_req` to satisfy TypeScript `noUnusedLocals`. The GET handler correctly requires no header reads (it is public/unguarded), so the parameter is structurally unused. Fix is a 4-character rename with zero behavior change.

Otherwise plan executed exactly as written.

## Known Stubs

None. All three routes are fully wired to their DB columns (from migration 0039).

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: public-unauthenticated-GET | apps/tg-miniapp/app/api/tma/agents/[id]/transfer-offer/route.ts | New unguarded endpoint keyed by agent UUID — intentional (acquirer surface); mitigated by non-sensitive SELECT + transferable-only filter + no-existence-oracle 404 + nginx rate-limit (deploy task T-16-08b) |

## Self-Check: PASSED

- `apps/tg-miniapp/app/api/tma/agents/[id]/make-transferable/route.ts` — FOUND (created, commit 47e6a31)
- `apps/tg-miniapp/app/api/tma/agents/[id]/transfer-offer/route.ts` — FOUND (created, commit 14dfb2c)
- `apps/tg-miniapp/app/api/tma/agents/[id]/route.ts` — FOUND (modified, commit b5f91c5)
- All three commits exist in git log
- Typecheck: PASSED (0 errors)
