---
plan: 16-05
phase: 16
title: Startonus minter client rewrite to current live API
status: complete
wave: 1
tasks_completed: 1
tasks_total: 1
self_check: passed
---

# 16-05 — Startonus client rewrite (live API shape)

## What was built
Rewrote `packages/shared/src/startonus.ts` from the STALE Phase-15 contract to the
CURRENT live Startonus minter API (captured in `docs/specs/research/2026-06-10-0g-inft-on-ton.md`,
docs at bot.startonus.com/docs). This client is the dependency of plan 16-03 (transfer initiate).

### Contract change (stale → live)
- **Removed:** `collectionId`, bare-string `recipient`, `price`/`priceNanoTon` flat fields.
- **Added types:** `StartonusOwner { tgId, userName?, wallet }`, `StartonusNftData
  { name, description, image, content?, attributes?, buttons? }`, `StartonusCallback
  { success, item?, owner?, userData? }` (the async mint webhook payload).
- **`GenerateInvoiceParams`** now: `secret`, `templateId` (→ body `id`), `address`
  (the ONE shared "Агенты" collection contract), `owner` (object), optional
  `nftPrice`/`nftAmount`/`nftData`/`callbackUrl`/`userData`.
- **`generateInvoice`** POSTs `{ id, address, secret, owner, …optional }` to
  `…/minter/generate-invoice/custom`; `nftPrice` stringified before send.
- `tonToNano` / `nanoToTon` / `NANO_PER_TON` unchanged.

## Key files
- created/modified: `packages/shared/src/startonus.ts` (86 ins / 20 del)

## Verification (no-local-runtime — grep + typecheck only)
- Plan automated verify: **OK** (templateId/owner/nftPrice/nftData/StartonusCallback/
  tonToNano/`minter/generate-invoice/custom` present; `collectionId`/`recipient:` absent).
- `tsc --noEmit` (packages/shared): **no errors reference startonus.ts**. Pre-existing
  `TS6059` rootDir-config noise on untouched files (index.ts/validation.ts/*.test.ts)
  is unrelated to this change.
- Security: `secret` is sent ONLY in the outbound body, never in `InvoiceResponse` or any
  return value, never logged (T-16-16/T-16-17). White-label header note retained — "Startonus"
  must never reach a user-facing response; callers map errors to generic labels.

## Deviations
- The original executor agent edited the file and passed the grep verify but **died before
  committing / writing this SUMMARY** (truncated mid-message). The orchestrator re-verified
  the on-disk edit (plan grep OK + no new type errors + secret-leak check) and committed it.
  No code changes were made beyond what the agent produced.

## Downstream
- 16-03 (transfer initiate) imports `generateInvoice` + `StartonusCallback` from this client.
- VPS setup (per phase user_setup): `STARTONUS_SECRET`, `STARTONUS_AGENT_COLLECTION_ID`
  (the `address`), optional `STARTONUS_BASE_URL` in `/srv/aiag/shared/.env`.
