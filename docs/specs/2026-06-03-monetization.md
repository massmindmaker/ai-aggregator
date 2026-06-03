# Monetization — AIAG TMA (founder model, 2026-06-03)

Authoritative for how money moves in the TMA. Refines synthesis **D-12** (creator economy). Currency = USD-pegged crypto credit (multi-crypto top-up; Stars deferred).

## The flows
A user holds a **crypto-credit balance** (top up in TON + other cryptos; Stars later). Running / renting an agent debits:

1. **Model usage** — routed via the `:4000` gateway. AIAG applies its markup → **this is AIAG revenue**. If the user uses their **own key/provider** (BYOK / OpenRouter / Gonka-wallet) → **0** (they pay their provider).
2. **Paid tools** (broker: Firecrawl, image-gen, …) — per-call, AIAG markup → **AIAG revenue**.
3. **Deploy / runtime** — provisioning a managed-Hermes instance has infra cost (shared ~18GB VPS now; dedicated instance for high-payers later) → covered by a deploy/subscription charge → **AIAG revenue**.
4. **Author rent** — if the agent came from a **paid template**, the renter pays the **author's price** (see below) → **goes to the author**.

## Author-rent model (the founder decision)
When an author **publishes** a template they choose:
- **Free** — no author charge. Anyone clones/runs without an author fee.
- **Priced** — the author sets an **exact amount**, e.g. a **monthly rent** (subscription) or a per-deploy/per-use price.

Rules:
- The renting user pays **exactly the sum the author set**. The author **receives that sum** in spendable credits (`tg_user_balances`).
- **AIAG takes NO percentage cut of the author rent** (no 5%, no commission). Author rent is pass-through.
- AIAG's revenue from a template = the **model markup + tools + deploy** the renter consumes — NOT the author's rent.
- Tradeoff (note for later): AIAG does not profit directly from author rent. If a platform fee is ever wanted, that is a future founder decision; for now it is 0%.

## What authors "lose money on" today (the bug to fix first)
Per synthesis **D-0 / R-11**: the worker invents its own price (hardcoded `PRICING` × `USD_TO_RUB=90`) and discards the gateway's real cost, so **realized margin is not a number any code can read**. Any payout/charge computed today would pay out of *cost*, not margin. Author rent is safe to ship **before** D-0 only because it is a **fixed author-set amount** (deterministic, not margin-derived) — but it still needs: the USD-credit ledger (D-1), an **author-payout sweep** (separate pass from the renter debit to avoid `tg_user_balances` lock contention), and BYOK-run exclusion.

## Anti-abuse (kept from D-12)
- Rank templates by **realized usage from distinct funded renters** (faking rank costs the attacker real credits → wash-trading is structurally unprofitable).
- **Self-deal exclusion** in the accrual hook (author can't rent from themselves to farm).
- **Single-hop attribution** (no recursive royalty farming); namespace template slugs per author (anti-squatting).
- Concrete dust floor on payouts.

## What the UI shows
- Template/agent card: author price — **«бесплатно»** or **«X кр/мес»** (or per-deploy). No percentage shown (there is no cut).
- Run/deploy screen: model+tools estimate + a separate **«аренда автора: X кр»** line.
- Author profile: published templates, renters, **earnings in credits**, withdraw-to-balance.

## Open (founder, later)
- Withdrawable vs non-withdrawable credits (synthesis FD-2) — affects whether author earnings can cash out (licensing implications).
- Whether deploy is a flat monthly subscription or metered.
