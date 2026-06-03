# AIAG — Lore Bible + NFT Collection (2026-05-30)

## Lore Bible (expanded, legible)
File: `.planning/tmp/lore-bible-draft.md`. Expands the veiled manifesto into a coherent world an outsider can follow, keeping all seeds + legal safety (no promises; banned words avoided).
- Eras: **Век Башен** (AI rented from above, you use but don't own) → **Спуск** (intelligence comes down, becomes common) → **Первый Город** (the platform = the first city).
- **Город**: Ворота (open entry) / Улицы+Площади (community) / Кварталы (model+tool marketplace by craft) / Мастерские (build agents) / «Стены, которых ещё нет» (early time).
- **Жители** (veiled = participant types): Гости (users) / Жители (active) / Граждане (engaged core) / Строители (creators+ML-engineers) / Архитекторы (leaders).
- **Агенты-граждане**: agents live, work while you sleep, have a craft, and **pay their own way** per-use (= the real product: agents that pay for their own tools).
- **Тихая экономика**: value flows bottom-up, back to builders (image of the world, not a financial promise).
- **Хроника** (remembers who was early) + **Первые Строители** + **Знаки** (numbered marks; "не ключи и не контракты, ничего не сулят — они помнят").
- Section 9 grounds the myth in what's real today. Refrain: «Кто поймёт — тот поймёт.»

## NFT Collection «Знаки Первых Строителей»
File: `.planning/tmp/nft-collection-concept.md`. Sold IN the TMA via Startonus + TonConnect, built on existing Phase 15 code.
- **Name**: «Знаки Первых Строителей» (alt: «Хроника Ранних», «Печати Первого Города»). One NFT = one numbered Знак-seal; lower number = earlier. Promises NOTHING (collectible/art only).
- **Real mechanics (from code)**: migration 0017 nft_collections (slug, startonus_collection_id, price_nano_ton, max_supply, minted_count, status) + nft_purchases (tg_user_id→tg_users, startonus_invoice_id, status pending→paid→minted). Client `packages/shared/src/startonus.ts` generateInvoice() → POST bot.startonus.com/api/minter/generate-invoice/custom → TonConnect tx → webhook /tg/api/tma/nft/webhook mints + increments minted_count. Admin via @startonus_bot + NewCollectionForm.
- **Two code TODOs**: (1) supply race — add atomic reserve `UPDATE ... WHERE minted_count < max_supply RETURNING` before generateInvoice (esp. small Founders tier); (2) no serial_no column — add it or trust Startonus item-index.
- **Supply proposal**: #0001–#1111, 4 tiers (Founders 33 / First Circle 111 / Builders 367 / Witnesses 600); each tier = its own nft_collections row (works on current code). Modest alt: 111 total. ALL numbers = proposals, not commitments.
- **Art**: round struck seal on near-black, center = AIAG logo graph-sigil (amber #f59e0b, 4-node zigzag = "signal across a graph"), engraved number on lower arc, ring microtext-chronicle; rarity readable by eye (Founders glow gold → Witnesses "sleeping" graph). Logo asset: `apps/web/src/components/ui/AiagLogo.tsx` + `apps/web/public/ai_logo_v1.png`. 3 Kie/nano-banana prompts in the file.
- **Launch**: manifesto/lore page → quiet Founders drop to early users (Phase 15 DM notifications) → First Circle announced → open Builders/Witnesses → archive at #1111. Descending price ladder.
- **Legal**: public framing = collectible art, promises nothing (no rights/utility/returns). Founder MAY later gift real benefits to early holders — INTERNAL ONLY, never promised/implied publicly.

See `mem:aiag_strategy_synthesis_2026_05_30`, manifesto `.planning/tmp/whitepaper-vision-draft.md`.
