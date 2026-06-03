# AIAG founder decisions — 2026-06-03

Latest decisions (supersede earlier where they conflict). Anchor: `/CLAUDE.md`. Research synthesis: `docs/specs/research/SYNTHESIS.html` (+ `SYNTHESIS.md`, per-item `R-01..R-12.md`).

## Currency / legal
- TMA = **multi-crypto credits** (TON + other cryptos), USD-pegged unit. ₽ removed from TMA (₽ only in the WEB aggregator).
- **Telegram Stars = deferred** — do NOT implement or show now.
- **Legal/compliance = not factored now.** Working structure: a separate **non-RF foreign entity buys models from the AIAG aggregator** (as an RF provider's customer); crypto + $-compute on the foreign entity. Revisit later (FD-2 withdrawable?, FD-3 jurisdiction/PD-localization).

## Managed-Hermes infra
- **Build it for test on a ~18GB VPS (shared).** Later **tier**: high-paying users → dedicated instance; ~$20-tier → shared VPS.
- Synthesis D-2 caveat: Daytona sandboxes only the tool execution; the `hermes gateway` stays resident ~300-600MB each — run a Phase-0 spike to measure whether one gateway multiplexes many users before scaling.

## Monetization (author-rent model) — detail in `docs/specs/2026-06-03-monetization.md`
- Author publishes template **free** OR sets a **price** (e.g. monthly rent).
- Renter pays model markup (AIAG) + deploy (AIAG) + **author's exact set sum** (→ author). **No % cut on author rent.** AIAG monetizes model/tools/deploy, not the rent.
- Blocked-until: D-0 (gateway returns realized margin) + D-1 (USD-credit ledger) + author-payout sweep. Author rent is a fixed amount so it's deterministic.

## Product direction
- **Confirmed correct** by the 12-item research. But **fix the money-path first** — D-0: today the worker invents price (×90) and discards gateway cost, so margin isn't computed; tool/author payouts would lose money until fixed.
- Build order: Wave 0 (D-0 ledger + D-1 USD credit + D-8 initData + D-7 safeFetch + DEFAULT_MODEL fix) → Wave 1 (Gonka, tool broker, deposit reconciler, catalog) → Wave 2 (jetton, real runtime, delivery) → Wave 3 (managed-Hermes spike, creator economy).

## Design
- **TMA mobile** = dark/amber; agents = holographic video character-cards (`docs/wireframes/tma/characters-video.html`); opened card = rich profile sheet.
- **WEB version** = build ALL TMA screens + modals as a separate web board, **light theme** à la **Studio23** (airy white / sky-blue + orange-amber accent, dark CTA pills) — `docs/wireframes/web/`. Reference: `C:\Users\боб\projects\devka\studio23-preview.png`.
- NFT removed everywhere.

## GSD
- Founder asked to formalize the product into GSD planning + update memory/Serena. This memory + `/CLAUDE.md` are updated; GSD roadmap/phases to be re-cut from SYNTHESIS build-order (Waves → phases) as the next planning step.
