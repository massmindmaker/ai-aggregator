---
plan: 16-04
phase: 16
title: Transfer UI — owner controls + share link + public acquirer offer page
status: complete
wave: 4
tasks_completed: 3
tasks_total: 3
self_check: passed
---

# 16-04 — Transfer UI surface (owner + acquirer)

## What was built
The user-visible surface for the transferable-agent feature, resolving CONTEXT.md
open question #4 (two distinct surfaces: owner shares a link; acquirer opens it).

### Task 1 — `apps/tg-miniapp/app/agents/[id]/TransferPanel.tsx` (commit `c2bfc2e`)
Shared `'use client'` component, split into two MUTUALLY EXCLUSIVE halves keyed on
`isOwner` (a prop — NEVER hardcoded):
- **Owner half** (`isOwner=true`): make-transferable toggle + optional sale price
  (1–100 000 кр, empty = gift), POST to `…/make-transferable` with Bearer token; a
  copy-able **share link** to `/tg/agents/[id]/offer`; honest D-5 memory-transfer flag.
- **Acquirer half** (`isOwner=false`): TON Connect (`useTonAddress`/`useTonConnectUI`),
  POST to `…/transfer`, then `sendTransaction`; honest pending copy ("право перейдёт
  после подтверждения минта ~1–3 мин"); maps 409 `transfer_pending` / 403 `self_deal`.
- Disambiguation copy: transfer = MOVE one instance (original disappears) ≠ clone/rent.

### Task 2 — owner detail page mount (commit `4ea936d`)
`app/agents/[id]/page.tsx`: `Agent` interface + `<TransferPanel isOwner={true}
token={token} onChanged={load} />` after the publish block. `isOwner={true}` is correct
here because the detail GET is ownership-guarded (a non-owner 404s before render).

### Task 3 — public acquirer offer page (commit `4822758`)
`app/agents/[id]/offer/page.tsx` (PUBLIC, `force-dynamic`), mounted like `nft/[slug]`:
transferable-only, non-sensitive SSR read (id/name/role-preview/price/status) →
`notFound()` on miss (opaque, no existence oracle). Renders `<TransferPanel
isOwner={false}>` + an honest "что переходит" card. White-label + crypto-only.

## Verification (no-local-runtime — grep + typecheck only)
- Task 1/2/3 plan `<verify>` greps: **OK**.
- `bun run typecheck` (apps/tg-miniapp): **0 errors** (whole project).
- White-label/credits: no "Startonus", no ₽ in any of the three surfaces. Display mint
  fee uses the un-prefixed `AGENT_MINT_FEE_TON` (matches the transfer-offer route).

## Orchestrator notes / deviations
- The executor agent died mid-message after committing Tasks 1 + 2. The orchestrator
  implemented Task 3 directly (mirroring `nft/[slug]/page.tsx` + the TransferPanel
  contract), ran the plan verify (initially failed on a false-positive: the literal
  tokens `₽`/`system_prompt` appeared only in code comments, and the display fee used
  the brand-prefixed `STARTONUS_AGENT_MINT_TON`), then fixed both: reworded the
  comments and switched the display var to `AGENT_MINT_FEE_TON`.

---

## ⚠ PHASE 16 USER_SETUP — required on the VPS before this works (no-local-runtime)
1. **Migration:** hand-apply `packages/database/migrations/0039_agent_transfers.sql`
   on prod: `sudo -u postgres psql aiag -f .../0039_agent_transfers.sql` (additive +
   idempotent; app user can't ALTER).
2. **Startonus collection:** create the ONE shared "Агенты" collection via @startonus_bot;
   note its contract address + a mint-set template id.
3. **Env (`/srv/aiag/shared/.env`):**
   - `STARTONUS_SECRET` — minter secret (server-side only).
   - `STARTONUS_AGENT_COLLECTION_ADDRESS` — the collection contract (transfer route body `address`).
   - `STARTONUS_AGENT_MINT_TEMPLATE_ID` — the mint-set template id (body `id`).
   - `STARTONUS_AGENT_MINT_TON` — the ACTUAL mint price sent to the minter (transfer route).
   - `AGENT_MINT_FEE_TON` — the DISPLAYED mint fee (offer page + transfer-offer read).
     **GOTCHA:** set `AGENT_MINT_FEE_TON` == `STARTONUS_AGENT_MINT_TON`, else the UI
     shows a fee different from what's actually charged on-chain.
   - `PUBLIC_BASE_URL` — e.g. `https://app.ai-aggregator.ru` (webhook callback URL).
4. **nginx — webhook auth (CRITICAL, not optional):** add an IP-allowlist for Startonus
   on `/tg/api/tma/agents/transfer/webhook`. The webhook is unsigned; its only real
   defence is the allowlist + the unguessable charge-UUID + the seller-guarded claim.
   Without the allowlist a leaked UUID lets someone force-settle a transfer without the
   on-chain mint (T-16-09).
5. **nginx — rate limit:** add `/tg/api/tma/agents/*/transfer-offer` (public unauth read)
   to the public-read rate-limit zone (T-16-08b).
6. **Build:** tg-miniapp is built MANUALLY on the VPS (turbo libs — shared/db/gateway —
   first, since the 16-05 shared client changed). `pm2 restart tma`.

## VPS verification steps (after deploy)
1. Owner: open an owned agent → "Сделать передаваемым" (+ optional price) → copy link.
2. From a SECOND Telegram account: open the link → `/agents/[id]/offer` renders name/role/
   price/mint fee, no owner controls.
3. Acquire via TON Connect → confirm: ownership moves to the buyer, `agent_runs` wiped,
   seller's keys stripped, (sale) buyer debited + seller credited 100%, `transfer_charges`
   = settled, agent.nft_address set. Replay the webhook → no double-credit (idempotent).
