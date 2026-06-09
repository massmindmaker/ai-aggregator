# Deferred items — Phase 16

## DEF-16-01: Phase-15 nft/purchase route broken by the 16-05 Startonus client rewrite

- **File:** `apps/tg-miniapp/app/api/tma/nft/purchase/route.ts`
- **Error:** `TS2353: 'collectionId' does not exist in type 'GenerateInvoiceParams'` (line ~107). The route also passes `priceNanoTon` + bare-string `recipient`, all removed by the 16-05 rewrite.
- **Cause:** plan 16-05 rewrote `packages/shared/src/startonus.ts` to the current live Startonus API (`templateId`/`address`/`owner` object/`nftPrice`/`nftData`). The legacy Phase-15 speculative NFT-catalog purchase route still calls the OLD contract. The shared package `dist/` was stale until this plan (16-03) rebuilt it, which is why the breakage only surfaces now.
- **Scope:** OUT OF SCOPE for 16-03 (pre-existing file, not in the plan; last touched commit `c72db50`, long before this work). The legacy speculative "Знаки" NFT catalog is slated for removal anyway (CLAUDE.md founder decision #4 — NFT removed from product); the Startonus plumbing is being repurposed for the non-speculative agent-iNFT.
- **Suggested resolution:** either migrate `nft/purchase` to the new client signature, or delete the legacy NFT-catalog purchase/webhook/collections routes if the speculative catalog is being retired. Track under the NFT-removal cleanup, not R1.4.
