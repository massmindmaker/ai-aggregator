# Deferred items — Phase 16

## DEF-16-01: ✅ RESOLVED (2026-06-10, commit `b99a603`)

The legacy `nft/purchase` purchase path was **retired** (honest `410 feature_retired`,
stale `generateInvoice` call removed) per founder decision #4 — unblocking the tg-miniapp
build (project typecheck back to 0 errors). A (template,address) re-mapping was rejected to
avoid risking a wrong mint in retired money code. **Still open as NFT-removal cleanup (NOT
R1.4):** full deletion of the remaining legacy `nft/*` routes + UI (`nft/webhook`,
`nft/collections`, `nft/[slug]` page, BuyButton) — left in place for now because 16-04 reads
the nft pages as UI patterns. Original note below.

### (original) Phase-15 nft/purchase route broken by the 16-05 Startonus client rewrite

- **File:** `apps/tg-miniapp/app/api/tma/nft/purchase/route.ts`
- **Error:** `TS2353: 'collectionId' does not exist in type 'GenerateInvoiceParams'` (line ~107). The route also passes `priceNanoTon` + bare-string `recipient`, all removed by the 16-05 rewrite.
- **Cause:** plan 16-05 rewrote `packages/shared/src/startonus.ts` to the current live Startonus API (`templateId`/`address`/`owner` object/`nftPrice`/`nftData`). The legacy Phase-15 speculative NFT-catalog purchase route still calls the OLD contract. The shared package `dist/` was stale until this plan (16-03) rebuilt it, which is why the breakage only surfaces now.
- **Scope:** OUT OF SCOPE for 16-03 (pre-existing file, not in the plan; last touched commit `c72db50`, long before this work). The legacy speculative "Знаки" NFT catalog is slated for removal anyway (CLAUDE.md founder decision #4 — NFT removed from product); the Startonus plumbing is being repurposed for the non-speculative agent-iNFT.
- **Suggested resolution:** either migrate `nft/purchase` to the new client signature, or delete the legacy NFT-catalog purchase/webhook/collections routes if the speculative catalog is being retired. Track under the NFT-removal cleanup, not R1.4.
