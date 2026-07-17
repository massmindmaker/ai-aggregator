# Research — NFT-membership-gated creator economy for the AIAG TMA (TON, 2026)

> Status: research note. Goal: pick the **best mechanic** for "hold a membership NFT → become a
> creator (build + rent out agents)" and map it onto what we **already have**. No new product
> features are proposed — only the thin wiring that turns the existing create-gate + ownership
> check + TON mint infra into a real buy-NFT→creator flow, plus a forward-research list.
>
> Context anchor: `/CLAUDE.md`, `docs/canon/AIAG-CANON.md`. Money/auth rules: `/SECURITY.md`.
> Existing pieces referenced: `apps/tg-miniapp/src/lib/membership.ts`,
> `apps/tg-miniapp/src/lib/nft-ownership.ts`, `apps/tg-miniapp/app/api/tma/membership/route.ts`,
> `packages/database/migrations/0044_creator_membership.sql`, `packages/shared/src/startonus.ts`.

---

## 1. Best-practice findings (with URLs)

### 1a. Soulbound vs transferable membership
- **Soulbound (non-transferable) is the default for access/reputation.** SBTs are account-bound,
  non-transferable proof of membership; they "prevent the membership being bought, rented, or
  outsourced" and stop reselling of access. Good when the pass means *status/eligibility*, not an
  asset. Gitcoin Passport (SBT) cut Sybil donations ~90% — the canonical proof that
  non-transferability is the anti-sybil lever.
  - https://www.coingecko.com/learn/soulbound-tokens-sbt
  - https://chainscorelabs.com/blog/public-goods-funding-and-quadratic-voting/grant-dao-architectures/why-soulbound-tokens-will-revolutionize-grant-eligibility
  - https://cointelegraph.com/news/the-rise-of-soulbound-nfts-unpacking-community-monetization-strategies
- **Transferable membership** enables resale + gifting (a real onboarding/loyalty channel) but
  "requires stronger policy and moderation" and invites flippers + a secondary market the platform
  must police. Hybrid playbooks add **resale royalties, cooldowns, and tier upgrades** to keep a
  transferable pass aligned.
  - https://www.influencers-time.com/token-gated-community-platforms-for-brand-loyalty-3-0/
  - https://docs.nfts2me.com/features/soulbound-non-transferable-nfts

### 1b. What makes a membership NFT sustainable vs a cash-grab
- **Frame it as access + utility, NOT an investment.** The recurring failure mode is hyping
  "buy this, it'll go up" → attracts flippers, not members, and detonates when the price falls.
  Successful passes say "this unlocks X" and (if transferable) "you can pass it on if you can't
  use it" — flexibility without a financial promise.
  - https://www.ticketfairy.com/blog/festival-nft-memberships-building-year-round-loyalty-with-blockchain
  - https://future.com/a-practical-guide-to-nft-memberships-for-creators/
- **Value = ongoing delivered utility**, a partnership where holder and platform both keep raising
  membership value; sustainable projects share mission + community + real utility + a team that
  delivers. A pass with no living utility decays.
  - https://nftnow.com/sponsored/the-art-of-nft-memberships-a-guide-for-brands-and-users/
- **Custody/marketplace risk is real** (Coachella lifetime passes were stranded when the FTX-hosted
  marketplace collapsed). Lesson: don't outsource the asset's home to a fragile third party; keep a
  server-side source of record so access survives chain/marketplace hiccups.
  - https://nftnow.com/sponsored/the-art-of-nft-memberships-a-guide-for-brands-and-users/
- **Keep tiers understandable**; tiers can map to spend/tenure/contribution but must stay legible.
  - https://www.influencers-time.com/token-gated-community-platforms-for-brand-loyalty-3-0/

### 1c. TON + Telegram context (2026)
- **TON is the exclusive blockchain for Telegram Mini Apps** (TON Foundation × Telegram, 2025).
  Toncoin is the only currency Telegram uses to pay Mini-App devs/channel owners. Membership NFTs
  that gate access to features/channels are an explicitly sanctioned pattern; blockchain guidelines
  apply from 2025-01-21 and **collectible NFTs are permitted**.
  - https://blog.ton.org/ton-telegram-exclusive-partnership-2025
  - https://core.telegram.org/bots/blockchain-guidelines
  - https://en.cryptonomist.ch/2025/03/19/telegram-and-ton-foundation-strengthen-their-partnership-ton-becomes-the-exclusive-blockchain-for-mini-apps/
- **NFT membership passes that grant access to exclusive channels/features** are a listed Mini-App
  monetization method, alongside in-app crypto subscriptions.
  - https://www.nadcab.com/blog/telegram-mini-apps-monetization
  - https://evacodes.com/blog/telegram-mini-apps-on-ton-blockchain

### 1d. Creator-economy alignment + marketplace take rates
- **AI agent / template marketplaces take 15–30%**, creator keeps 70–85%; specialized high-value
  marketplaces sit at the top of that band. The **subscription-per-agent ("digital employee")**
  model (Harvey / 11x / Vivun) is the dominant agent pricing shape — which is exactly *author-rent*.
  - https://www.getmonetizely.com/articles/how-to-build-effective-revenue-models-for-ai-agent-marketplaces
  - https://nevermined.ai/blog/monetize-ai-agents
  - https://www.crossmint.com/learn/monetize-ai-agents
- **Upfront creator stake aligns incentives** ("skin in the game"): creators who pay/stake to enter
  are downside-focused and self-police quality because angry users who lost money hurt them. This is
  the alignment argument for charging creators an entry price rather than letting anyone publish.
  - https://every.to/means-of-creation/the-new-creator-playbook-jumpstarting-communities-through-tokens
  - https://www.speedinvest.com/knowledge/the-new-creator-economy-a-guide-to-web3-creator-platforms
- **Anti-sybil:** non-transferable eligibility is the proven defense; multiple wallets don't help if
  each must independently *earn/buy* the pass. A one-time priced mint already raises the cost of
  sybil-farming creator accounts; soulbinding removes the rent-a-pass loophole entirely.
  - https://chainscorelabs.com/blog/public-goods-funding-and-quadratic-voting/grant-dao-architectures/why-soulbound-tokens-will-revolutionize-grant-eligibility

### Is "author-rent + 0% commission on rent" sane?
**Yes, and it's well-aligned — with one caveat.** Comparable marketplaces charge 15–30% on creator
revenue; AIAG instead earns on model-markup + deploy + tools and takes **0% of the author's rent
sum**. That makes AIAG the *cheapest* place for an author to rent out an agent (a real acquisition
wedge) while AIAG still monetizes the usage the rented agent generates (which scales with the
agent's actual value, not a flat skim). The caveat from the research: a 0%-on-rent model only stays
sustainable if **usage actually flows through AIAG-supplied models** (markup is the engine). If a
popular rented agent is BYOK/own-provider end-to-end, AIAG earns ~0 on it — that's the known
commission rule (`isExternal` → zero charge), and it's by design, but it means the **membership
mint price + deploy + tool fees are the floor revenue** for the creator tier. The membership NFT
therefore does real economic work: it's the up-front, sybil-resistant, aligned entry price that
backstops the generous 0%-rent promise.

---

## 2. Recommended membership mechanic for US (existing blocks only, no new features)

**Recommendation: a one-time-priced, single-tier "Creator Pass" NFT in ONE shared TON collection,
minted via the existing Startonus flow, that on successful mint grants a row in `tg_memberships`.
Keep it TRANSFERABLE for v1 (reuse, don't fight, our TON stack), but make the server-side
`tg_memberships` row the source of record so access never depends on a fragile marketplace.**

Concrete params, each justified by §1 and built only from existing pieces:

1. **One collection (tiers via attribute, see §6).** A single **"Creator Pass"** collection — one
   `MEMBERSHIP_NFT_COLLECTION_ADDRESS`, one ownership query. ⚠️ **Superseded by the founder's tiered
   mechanic (§6):** the pass is now **3-tier**, but still ONE collection — tier is a metadata
   attribute + a `tg_memberships.tier` column, NOT one collection per tier. Reuse the Startonus
   `generateInvoice` path that already mints the transferable-agent iNFT (`packages/shared/src/
   startonus.ts`), with a **template per tier** inside the one collection.

2. **Price = a deliberate, modest floor — not a moonshot.** Set a one-time mint price (e.g. on the
   order of a few TON / low-tens of USD-equivalent) high enough to be a real anti-sybil + skin-in-
   the-game stake (§1d) but low enough to read as "unlock creator tools," not "investment" (§1b).
   Exact number is a forward pricing question (§5); the **mechanic** is: price set as Startonus
   `nftPrice` (nano-TON), paid by the buyer via TON Connect (already wired for transfers).

3. **Transferable in v1, by reuse — with a soulbound option flagged for later.** Our entire TON
   mint + ownership path (TEP-62, Startonus, TonCenter `nft/items` owner query in
   `nft-ownership.ts`) is built for **transferable** items. Soulbound would need a different contract
   and a different ownership semantics — that's a *new subsystem*, so it's **out of scope per the
   brief**. Transferable also gives us a free gifting/resale onboarding channel (§1a). We mitigate
   the flipper risk the research warns about by (a) framing the pass as access not investment, and
   (b) **server-side source of record**: `tg_memberships` is the gate, synced from chain — so we
   control re-sync cadence and can later add cooldowns/royalties without re-architecting.

4. **What it unlocks (already coded):** holding the pass → `hasCreatorMembership` true → the two
   create endpoints open (`POST /api/tma/agents`, `POST /api/tma/agents/ai-builder`, both already
   gated at lines 130 / 109). Non-holders keep full HIRE + CLONE access (those routes are
   deliberately ungated). This is the **entire** product surface of the pass — no new capability is
   introduced, we're just turning the existing gate's data source from "manual seed only" into
   "buy-to-unlock."

5. **Grant-on-purchase = the only genuinely new wiring.** The sync route
   (`POST /api/tma/membership`) already does on-chain → grant when a collection is configured. The
   missing link is the **mint entry point** and **callback-driven grant** so a purchase
   auto-unlocks without the user manually hitting sync. Both reuse existing primitives (Startonus
   `callbackUrl` + `userData`, the same shared-token webhook pattern already used by
   `app/api/tma/agents/transfer/webhook/route.ts`).

**Why this is the best mechanic for us specifically:** it is the *minimum* coherent economy on top
of what exists — one collection, one price, one unlock, server-side record — and it inherits every
hard-won TON primitive (mint, TON Connect, ton-proof, ownership read, webhook auth) instead of
introducing a soulbound contract or a tiered store we'd have to build and audit.

---

## 3. Built vs thin-wiring-missing

### Already built (wire/polish only — DO NOT replace)
| Piece | Where | State |
|---|---|---|
| Create-gate (members create, others hire/clone) | `agents/route.ts:130`, `ai-builder/route.ts:109` | LIVE, enforced |
| `hasCreatorMembership` / `grantMembership` | `apps/tg-miniapp/src/lib/membership.ts` | LIVE (fail-closed read, upsert) |
| `tg_memberships` table (+ founder seed) | `migrations/0044_creator_membership.sql` | applied; `nft_address` + `source` columns present |
| On-chain ownership check (TonCenter `nft/items`) | `apps/tg-miniapp/src/lib/nft-ownership.ts` | LIVE but OFF — returns false until `MEMBERSHIP_NFT_COLLECTION_ADDRESS` set; fail-closed |
| Membership GET + POST-sync route | `app/api/tma/membership/route.ts` | LIVE; sync grants when a verified wallet owns a pass |
| UI member-state read | `agents/page.tsx:130`, `agents/new/page.tsx:221` | LIVE (reads `is_member`) |
| TON mint infra (Startonus `generateInvoice`, nano-TON helpers, callback type) | `packages/shared/src/startonus.ts` | LIVE (reused from transfer-iNFT, mint 1 TON proven) |
| TON Connect + ton-proof + verified-wallet table (`ton_wallets`) | TMA money/transfer stack | LIVE |
| Shared-token webhook pattern | `app/api/tma/agents/transfer/webhook/route.ts` | LIVE (reuse for mint callback) |

### Thin wiring still missing (this is wiring, NOT new subsystems)
1. **Collection address + Startonus template for the Creator Pass.** Create the "Creator Pass"
   collection + mint template in Startonus (same admin flow already used for the agent collection),
   then set `MEMBERSHIP_NFT_COLLECTION_ADDRESS` in `/srv/aiag/shared/.env`. The instant this env is
   set, `ownsMembershipNft` flips ON and the existing POST-sync route starts granting from chain —
   **zero code change** to turn the gate live for already-minted holders.
2. **A mint/sale entry point (buy-the-pass flow).** A small route + UI button that calls the
   existing `generateInvoice` with the pass template/collection/price and returns the TON Connect
   payload (mirror the transfer mint call). Pure reuse of `startonus.ts` — no new mint subsystem.
3. **Grant-on-purchase via the mint callback.** Point the pass mint's `callbackUrl` (shared-token
   auth, like the transfer webhook) at a handler that, on `success`, calls the existing
   `grantMembership(tgUserId, sql, { source: 'nft', nftAddress: item })`. This removes the
   manual-sync step so a purchase auto-unlocks creation. Everything it needs (`userData` echo,
   `item` address, shared-token verification) already exists.

Optional polish (not blocking): a "become a creator" upsell surface that explains the unlock and
the 0%-rent promise; a re-sync trigger after wallet connect so transferable-pass changes propagate.

---

## 4. Map to OUR build — explicit "wiring, not subsystems"

- **The economy already exists in code as a gate.** The only thing that was always manual is *how a
  row lands in `tg_memberships`*. Today: founder seed + manual grant. Target: **buy NFT → row**.
- **Three wires close the loop** (all reuse existing primitives, none is a new subsystem):
  1. set `MEMBERSHIP_NFT_COLLECTION_ADDRESS` (config) → turns the on-chain check + sync ON;
  2. add a buy-the-pass route/button calling existing `generateInvoice` (reuse `startonus.ts`);
  3. add a mint callback that calls existing `grantMembership` (reuse the transfer-webhook auth
     pattern).
- **No new contracts, no soulbound mechanism, no tier store, no new ledger.** Transferable pass
  rides the exact TEP-62 / Startonus / TonCenter stack already in production for transfer-iNFT.
- **Robustness inherited for free:** ownership check is fail-closed; membership read is fail-closed;
  mint client is white-label (Startonus never surfaced to users); webhook uses the proven
  shared-token guard. The server-side `tg_memberships` source-of-record gives us the Coachella
  lesson (§1b) for free — access survives a chain/marketplace hiccup.

---

## 6. Tiered membership (founder mechanic 2026-06-26)

> Founder added: the membership NFT is **TIERED**. A higher tier grants (a) a larger **share of
> the model-markup (usage) revenue** the creator's agents generate via our `:4000` gateway, and
> (b) a larger **agent quota** (max agents the creator may build). This section designs that on
> existing blocks — a `tier` value + two count/percent guards — not a new subsystem.

### 6a. How tiered creator/membership NFTs work in practice (2026)
- **3–4 tiers is the proven sweet spot**; most successful tiered creator programs run 3–4 levels,
  Bronze/Silver/Gold-style, each unlocking escalating, *legible* benefits. Going past ~4 tiers
  hurts comprehension (the research repeatedly warns "keep tiers understandable").
  - https://www.influencers-time.com/sustaining-creator-economy-careers-trends-and-challenges/
  - https://blog.mintology.app/nft-memberships-for-businesses-loyalty-profits/
- **Tiered membership materially lifts creator income** — creators on tiered systems "earn 3× more
  than those relying on ads alone," and a cheap entry micro-tier lifts paid conversion (+34% in the
  cited data). Translation for us: a low-priced entry Creator Pass widens the funnel; higher tiers
  capture the serious creators.
  - https://www.fundmates.com/blog/creator-economy-trends-what-platforms-are-paying-the-most-in-2025
- **Tier → rev-share + tier → quota is an established pattern.** NFT membership tiers commonly gate
  *access levels and quotas* (e.g. Poolsuite's Executive vs Pool Member tiers gate access scope by
  supply), and revenue-share/splits platforms automate **% payouts to multiple stakeholders** off a
  recorded revenue event — which is exactly "pay the creator X% of the markup their agents
  generated." Both halves of the founder mechanic are off-the-shelf patterns, not invention.
  - https://og.rarible.com/blog/9-membership-nfts/
  - https://ideausher.com/blog/nft-royalties-and-splits-platform-development/
- **One-time vs subscription:** access/quota unlocks pair naturally with a **one-time mint** (buy the
  tier, hold it, keep the quota); ongoing rev-share is the recurring value that keeps the one-time
  buy worth it. We stay one-time-mint (reusing our mint stack) and let the *rev-share* be the
  recurring payoff — no subscription billing to build.

### 6b. Pitfalls (and how the design avoids them)
- **Pay-to-earn perception.** Highest risk: "buy the top NFT, farm the markup." Mitigation: rev-share
  is **% of markup the creator's OWN agents actually generate** — earnings track delivered usage, not
  the NFT itself. No agents used → no payout. This keeps it "tools + share of what you build," not a
  yield instrument (the §1b cash-grab failure mode). Frame copy must say so.
  - https://www.ticketfairy.com/blog/festival-nft-memberships-building-year-round-loyalty-with-blockchain
- **Whale concentration.** If a few wallets hoard top-tier passes the economy skews. Our natural
  guard: `tg_memberships` is **keyed by `tg_user_id`** (one membership per Telegram human), so a
  whale can't stack N top passes onto one account to multiply quota/share. Per-tier supply caps are a
  forward lever (§5).
  - https://dappradar.com/blog/whale-analysis-report-nft-perspective
- **Sustainability.** Rev-share must come **out of AIAG's markup, never below cost.** The lever is a
  *split of the realized margin* `settleRun` already records — so a payout can never exceed what AIAG
  earned on that run. Top tier = AIAG keeps a smaller slice of a (hopefully larger) volume, not a
  subsidy. <5% of creators earn full-time income generally, so set expectations as upside, not salary.
  - https://www.midiaresearch.com/blog/the-creator-economy-has-a-sustainability-problem
- **Sybil across tiers.** Priced tiers raise sybil cost (mint × N); the per-`tg_user_id` key caps
  per-human stacking; soulbinding (forward, §5) would close it fully.

### 6c. Why this is the sane lever (vs alternatives)
Today: author-rent = **100% to author (AIAG 0%)**, and AIAG keeps **100% of model-markup** the
creator's agents generate via `:4000`. The cleanest tier lever is to **vary the creator's share of
that markup** (a rev-share % computed off the margin `settleRun` already records) **and the agent
quota** — exactly the founder mechanic. Rent stays 100%-to-author at every tier (don't touch it).
Alternatives are worse: taking a % of rent contradicts the 0%-rent wedge; charging a recurring
subscription means building subscription billing (new subsystem); gating *features* per tier means
building per-tier feature flags across the product. Varying **a payout % + a count cap** is the
minimum-surface lever — both read off data we already have.

### 6d. Recommended tier ladder for US (starting proposal — calibrate via `pricing-strategy`)

Three tiers (the proven 3-tier shape). **All numbers are a starting proposal flagged for
`pricing-strategy` + a margin model before launch** — the *mechanic* is what's being recommended,
not the exact figures.

| Tier | Mint price (one-time) | Agent quota (max agents) | Usage-markup rev-share to creator | Author-rent | What it unlocks |
|---|---|---|---|---|---|
| **Creator** (entry) | ~2 TON | 1 agent | **0%** (AIAG keeps full markup) | 100% to author | Opens the create-gate; rent-only earning |
| **Builder** (mid) | ~10 TON | 5 agents | **~15%** of realized markup | 100% to author | Bigger quota + a cut of usage their agents drive |
| **Studio** (top) | ~30 TON | 20 agents | **~30%** of realized markup | 100% to author | Largest quota + largest usage cut; "serious creator" |

Notes: entry tier = pure access (matches §1d "modest skin-in-the-game"); rev-share % stays **well
inside AIAG's markup** so a payout can never exceed realized margin; quota numbers are deliberately
round and conservative (raise later, never silently cut). Rent is 100%-to-author at every tier —
the **only** levers that move are quota and usage rev-share %.

### 6e. Map to OUR build — thin wiring vs genuinely new

**Thin wiring (parameters on existing blocks — NOT a new subsystem):**
1. **`tier` value on `tg_memberships`.** Add a `tier` column (e.g. `SMALLINT`/`TEXT`, default lowest)
   — same additive, idempotent migration style as 0044. Set it in `grantMembership` from the mint
   (the tier the buyer paid for). `hasCreatorMembership` already returns boolean; add a sibling
   `getCreatorTier(tgUserId)` reading the same row. (No money-path column touched.)
2. **Quota = a COUNT guard in the two create endpoints.** Both create routes already call
   `hasCreatorMembership` at known lines (`agents/route.ts:130`, `ai-builder/route.ts:109`). Extend
   to: read tier → look up `maxAgents[tier]` (a tiny constant map, prices/quotas NOT hardcoded in
   business logic — keep them in one config object) → `SELECT COUNT(*) FROM agents WHERE owner =
   tgUserId` → block if at cap. Pure count guard, no new table.
3. **Rev-share = a payout calc off the markup `settleRun` already records.** `settleRun` already
   computes/records realized markup per run (D-0). Add a step that, for the agent's owner, multiplies
   that markup by `revShare[tier]` and credits the creator (reuse the existing USD-credit ledger that
   already does debits/credits — `tg_user_balances`). This is a *new line of calc on an existing
   atomic settle*, reusing the existing credit ledger — **no new payout subsystem.** ⚠️ It does touch
   the live money path (`settleRun`), so it must follow `/SECURITY.md` (atomic `UPDATE … WHERE …
   RETURNING`, BYOK/external → no markup → no share) and get a code review before prod.

**Genuinely new (small, but real):** the rev-share *credit step inside `settleRun`* is the one piece
that's net-new logic on the live money path (everything else is a column + a count). Treat it as the
careful bit.

**Mint shape — recommend ONE collection, tier as a metadata ATTRIBUTE (not one collection per
tier).** Startonus `nftData.attributes` already exists (`{type, value}[]` in `startonus.ts`), so mint
`attributes: [{type:'tier', value:'studio'}]` in the single shared Creator-Pass collection. Reasons:
(a) one collection = one `MEMBERSHIP_NFT_COLLECTION_ADDRESS` + one ownership query we already have;
(b) the **tier of record is the `tg_memberships.tier` column set at grant from the price/template the
buyer paid** — chain attribute is display only, server is source of truth (the Coachella lesson). One
collection per tier would multiply collection addresses + ownership queries for zero benefit. (If we
ever want per-tier pricing enforced by Startonus, use a **template per tier** inside the one
collection — `templateId` already varies per call.)

---

## 5. Forward research list (open questions for later — NOT v1)

1. **Mint price calibration.** What one-time price is high enough for anti-sybil + skin-in-the-game
   yet low enough to read as "unlock," not "investment"? Needs willingness-to-pay against the
   0%-rent value prop and TON volatility (price is USD-pegged-credit elsewhere but the mint is in
   TON). → run the `pricing-strategy` skill before launch.
2. **Soulbound vs tradable membership (the real fork).** Transferable is the v1 default *because*
   our stack is transferable. But the research strongly favors soulbound for pure access/anti-sybil.
   Decide later whether the Creator Pass should migrate to a soulbound contract (new subsystem,
   founder decision) — and whether "transferable pass" creates an unwanted speculative secondary
   market that conflicts with the NFT-no-speculation rule in canon.
3. **Secondary-market policy for a transferable pass.** If it can be resold: cooldowns? resale
   royalties? a cap on re-grants per item to stop pass-rental? How does re-sync handle a pass that
   changed hands (revoke the seller's membership? grace period)?
4. **Per-tier price calibration (§6).** The 2/10/30-TON ladder is a placeholder. Calibrate each
   tier's mint price against willingness-to-pay, the quota it unlocks, and TON volatility →
   `pricing-strategy`.
5. **Rev-share % calibration (§6).** The 0/15/30% ladder must be modeled against AIAG's actual markup
   so a payout can never approach/exceed realized margin at any tier; pick %s from a margin model,
   not by eye. Decide whether rev-share applies to *all* the creator's agents or only above a floor.
6. **Anti-sybil across tiers.** Priced tiers + per-`tg_user_id` key raise the bar, but: do we need
   per-tier supply caps (anti-whale), wallet-age / ton-proof-uniqueness, or one-pass-per-Telegram-ID
   beyond the natural key? Higher rev-share tiers raise the farming incentive — model it.
7. **Soulbound per tier.** Should top (rev-share-bearing) tiers be **soulbound** even if the entry
   tier stays transferable? A tradable rev-share pass is closest to a security/yield instrument
   (canon no-speculation tension) — soulbinding the earning tiers may be the cleaner answer. New
   contract = founder decision.
8. **Sub-agent economics.** Founder model mentions sub-agents — do sub-agents count against the tier
   quota, and do they generate rev-share? Define before quota wiring ships.
9. **Tier upgrade path.** Can a Creator-tier holder upgrade to Builder without re-minting from
   scratch (pay-the-difference)? Research favors "tier upgrades without forcing a trade" — design the
   upgrade flow (new mint + old-pass handling) later.
10. **Legal / revenue treatment (deferred per canon).** Selling an access NFT for fiat-equivalent on
   the foreign entity; how the mint proceeds, 0%-rent, and model-markup interact for the
   foreign-entity-buys-from-RF-aggregator structure. Revisit with the compliance pass.

---

## TL;DR for the founder
- **Mechanic:** one shared TON "Creator Pass" collection, **3 tiers (tier = a metadata attribute +
  a `tg_memberships.tier` column, NOT one collection per tier)**, one-time mint per tier through the
  existing Startonus flow, **transferable in v1** (our whole TON stack is transferable — soulbound
  would be a new subsystem), with `tg_memberships` as the **server-side source of record** so access
  never depends on a fragile marketplace. Holding a pass flips the already-live create-gate;
  non-holders keep hire+clone. Higher tier = bigger **agent quota** + bigger **share of model-markup
  (usage) revenue** the creator's agents generate. This is the minimum coherent economy that reuses
  every existing primitive (gate, ownership check, mint, TON Connect, webhook, settleRun markup,
  USD-credit ledger) and adds zero new subsystems.
- **Tier ladder (starting proposal, calibrate via `pricing-strategy`):** Creator ~2 TON / 1 agent /
  0% usage share · Builder ~10 TON / 5 agents / ~15% · Studio ~30 TON / 20 agents / ~30%. **Rent
  stays 100%-to-author at every tier** — the only levers that move are quota + usage rev-share %.
- **Sanity of 0%-rent + rev-share:** aligned and a real wedge (peers take 15–30% on creator
  revenue); rev-share is paid **out of AIAG's realized markup**, so it can never exceed what AIAG
  earned on a run — top tier = AIAG keeps a smaller slice of (hopefully larger) volume, not a
  subsidy. Sustainable as long as usage flows through AIAG-supplied models.
