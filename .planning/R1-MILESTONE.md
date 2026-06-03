# R1 — Money-correct foundation + providers + managed-Hermes test

**Milestone brief (for humans).** Re-cut 2026-06-03 from `docs/specs/research/SYNTHESIS.md` (lead-architect synthesis of research items R-01..R-12, each with its adversarial review) and `docs/specs/2026-06-03-monetization.md`. Founder decisions live in `CLAUDE.md`. Full phase detail is in `.planning/ROADMAP.md` under "Milestone: R1".

## Why this milestone exists

The synthesis verdict, in one line: **the money path is the product.** Almost every research item is really a question about money-correctness, and four of them (cost mapping, streamed usage, tool metering, creator payout) are *blocked* on a single unresolved fork — **where is "margin" computed and which ledger is authoritative.** Today the worker invents its own price (a hardcoded `PRICING` table × `USD_TO_RUB = 90`) and throws away the gateway's real cost, so **realized margin is not a number any code can read.** Any payout or per-call charge built today would pay out of *cost*, not margin — i.e. lose money on every run.

So R1 has two spines:
1. **Fix the single billing authority and make the gateway return realized margin** before building anything that pays anyone.
2. **Keep the crypto deposit *surface* founder-gated** (Telegram ToS forbids selling AI credits for crypto on the mobile client) while building the deposit *plumbing* (ledger / reconciler / jetton) — that plumbing is correct under both the Stars and the crypto structure, so it is safe to build now.

Everything heavier (Gonka, MCP, real runtime, managed Hermes, creator economy, characters) layers cleanly on top once those two are settled.

## Predecessor: R0 (Phase 15.1) — ✓ COMPLETE + LIVE on prod

R0 made the shipped TMA safe to put traffic on: aiag runs route through the `:4000` gateway (markup + white-label), every run debits the prepaid balance atomically and is gated on funds, the daily budget holds under concurrency, the CVE-2025-29927 auth-bypass is patched with hardened JWT verification, and the provider picker (migration 0026) routes. Branch `plan/15.1-r0-billing-identity` (not yet merged to master).

## The four phases

| Phase | Goal | Wave | Founder gate |
|-------|------|------|--------------|
| **R1.0 Money-correctness foundation** | Make realized margin a readable number + an honest USD credit unit — the keystone | Wave 0 | none (pure correctness) |
| **R1.1 Deposits + tool money** | Reconnect deposit + tool money paths + first new provider; no crypto-legal dependency | Wave 1 | FD-6 (Gonka fee) tunes, doesn't block |
| **R1.2 Jetton + real runtime + delivery** | Real on-chain USDT deposits, real AI-SDK runtime, gated Telegram delivery | Wave 2 | FD-1 (surface), FD-5 (Business inbound billing) |
| **R1.3 Managed-Hermes test + creator economy** | Measurement-spike managed Hermes, then author-rent economy + character pipeline | Wave 3 | FD-2 (withdraw), FD-3 (entity), FD-7 (character) |

### R1.0 — Money-correctness foundation ◆ in progress (on branch)
The keystone that unblocks D-5, D-6, D-8/D-9, D-11, D-12.
- **D-0 single billing authority + gateway-returns-margin** — `tg_user_balances` is the only TMA ledger; the gateway returns charged + upstream cost (or `margin_credits`) per request; the worker stops billing off `estimateCostRub` on the gateway path. **In progress on branch.**
- **D-1 USD micro-credit + `tg_ledger_entries`** — `1 credit = 1 USD` as micro-USD; double-entry ledger; kill `USD_TO_RUB = 90` (both copies); freeze-window + dry-run migration of the live balance. *Planned.*
- **D-8 initData hardening** — `timingSafeEqual` + 600s expiry + Redis nonce. ✓ **done on branch.**
- **D-7 `safeFetch` egress guard** — resolve-then-pin SSRF defense. ✓ **done on branch (R0).**
- **DEFAULT_MODEL registry fix** — seed+assert one controlled slug. ✓ **done.**

### R1.1 — Deposits + tool money 📋 planned
- **D-4 Gonka Track 1** — GonkaGate markup upstream (`gonka.ts` from `openrouter.ts`) + fallback row; fastest new-provider win.
- **D-9 tool broker** — reserve→execute→settle/refund; Firecrawl first; closes a confirmed unbilled-tool leak; **must** also increment the daily budget atomically.
- **R-04 deposit reconciler** — authoritative server cron + TonAPI push wake; fixes four funds-loss modes. Safe under both Stars and crypto.
- **D-6 catalog-sync + native adapters + BYOK unify** — gateway tables fed from `models.dev`, **`/1M → /1k` conversion + CI assertion** (the 1000× bug), route BYO native keys through the gateway.

### R1.2 — Jetton + real runtime + delivery 📋 planned
- **R-04 jetton USDT-on-TON** — corrected transfer shape, master allowlist + fake-jetton defense, per-user deposit addresses.
- **D-5 real AI-SDK runtime** — `ai` + openai-compatible at `:4000`, pgvector memory, OTel→Grafana free tier. **Gate:** do NOT stream the *billed* call (risks settling at ₽0).
- **D-11 MCP** — `agent_tokens` first, then inbound zero-cost tools, then the outbound Notion OAuth showcase.
- **D-13 grammY delivery** — Business mode, separate `apps/tg-bot` pm2 process, deliver-after-settle.

### R1.3 — Managed-Hermes test + creator economy 📋 planned / R&D-gated
- **D-2/D-3 managed-Hermes Phase-0 spike** — one real Hermes on the **~18 GB shared VPS** (founder 2026-06-03); **measure resident-gateway RAM + multiplexing** before building the provisioner; then tier (dedicated for high-payers, shared for ~$20-tier).
- **D-12 creator economy (author-rent)** — per `docs/specs/2026-06-03-monetization.md`: **author rent is pass-through, NO % cut** — renter pays the exact author-set sum (free OR priced, e.g. monthly), author receives it in spendable credits; AIAG earns only on model markup + tools + deploy. Author-payout sweep is a separate pass; anti-abuse via funded-renter ranking + self-deal exclusion + single-hop attribution.
- **D-14 character pipeline** — portrait → ambient loop → voice → (gated) talking card; fix three Kie input-shape gaps; ship ambient first.

## Founder gates (what blocks what)

- **FD-1 — Stars vs crypto (THE blocker).** Resolved direction: **multi-crypto now (TON + others), Stars deferred — do not implement/show.** Gates the deposit *UX/currency surface* (R1.2), NOT the ledger/reconciler/jetton *plumbing* (safe to build either way).
- **FD-2 — withdrawable credits (OPEN).** Decides author/user *cash-out*. Gates the withdraw leg of R1.3; author-rent *accrual* ships regardless (fixed deterministic sum).
- **FD-3** entity split + PD localization → gates managed-Hermes for *real* users ($-billed compute on the foreign entity).
- **FD-5** who-pays for Telegram-Business chat answers → hard precondition for D-13.
- **FD-6** Gonka fee (absorb vs surface) → tunes D-4 pricing.
- **FD-7** talking-vs-ambient character default + stock-vs-cloned voice → recommend ambient + stock + founder-owned faces.
- **FD-8** x402 outbound USDC rail → deferred to real demand (not in R1).

## Cross-cutting risks (carried from SYNTHESIS §3)

- **RK-1** the 2 GB (→18 GB for the Hermes test) box is the binding physical constraint — resident orchestrators, pgvector HNSW build, self-hosted observability all compete with the live money path. Hard RAM-ceiling gate; "needs a bigger/second box" is the honest answer at scale.
- **RK-2** margin authority is the single point every money feature depends on — D-0 first, with `margin ≥ 0` / `author_share ≤ margin` enforced in CI, accrue 0 when unavailable.
- **RK-3** Telegram ToS wall vs the crypto-credit surface — plumbing safe, surface gated (FD-1).
- **RK-4** two-entity legal boundary assumed by code that doesn't enforce it (FD-3).
- **RK-5** white-label leakage across every new adapter/asset (per-adapter normalization + re-host Kie assets + a no-upstream-brand test).
- **RK-8** prod migrations are manual and untracked; the app role can't ALTER — every new table needs `sudo -u postgres psql aiag`; the live ₽→USD migration (D-1) is the most dangerous (freeze-window, conservative, dry-run the SUM-invariant on a prod dump first).
