# PRODUCT.md — AIAG TMA

> Design context anchor (used by the `impeccable` design skill and any frontend work). Product truth lives in `/CLAUDE.md` + `docs/specs/2026-06-02-tma-product-definition.md`.

**register:** product (app UI). Marketing surfaces (one-pager, pitch deck) are brand register.

## Users
- **Target audience = the AI agents themselves** (founder reframe 2026-06-10, canon §1). The product is **infrastructure for agents**: priorities derive from "what does an agent need to develop", not classic user-research. **People = deployers/curators** for whom "deploy an agent and give it skills" must be trivial; growth must be viral, not dev-only.
- **Non-technical Telegram users** (deployers) — want a ready, useful agent in ~2 clicks. Mobile, inside Telegram, RU-speaking. Low patience for config.
- **Power users** (deployers) — connect their own Hermes runtime, pick providers, bring own keys.
- **Creators** — publish agent templates, earn from clones/runs/rent.

## Product purpose
A hosted, multi-user **marketplace of AI agents that live in Telegram**. Discover / run / clone-from-template / **hire** / build your own. Agents are **personified characters** (face, name, personality), not faceless functions. Billed in crypto credits.

### Hire model (PROJECT — canon §3-4)
Hiring is distinct from cloning: the hirer does **not** own a copy. On hire, the hirer gets an **isolated instance** of the creator's agent — the creator's spec is **read-only** (updates flow through live), but the hirer gets their **own personal memory** namespaced per-hirer `(agent_id, hirer_tg_user_id)`. The model key = our AIAG gateway, so the **hirer is debited** (not the creator); the creator never hands over keys or history. Hire is always the AIAG path (`isExternal=false`). Not built yet (`agent_sessions` + memory-namespace + route are PROJECT).

## Brand & tone
Technical, confident, quietly playful (the characters have personality). Honest above all: never show unbuilt features as working. Russian copy, tight, no filler, no em dashes. Numbers/IDs/prices in monospace.

## Visual DNA
- **Dark**, evening/immersive (Telegram, mobile, personal). Warm-tinted near-black, never pure black/white.
- **Amber** as the single product accent; **per-character hues** power the collectible-card system (OKLCH).
- JetBrains Mono for numerics; humanist sans for body.
- Collectible-character-card language is the signature and must appear in the MAIN catalog, not only a side page.
- ⚠️ **The character-card signature is partially lost in the built UI** (design task, canon §10): cards on `/agents` and `/templates` speak the card language, but the full signature (real faces/art, trait line, @author, live-dot, stats) is gated on templates-API data + founder-supplied art — today only monogram placeholders. Re-establishing it is an open design task.

## Anti-references (do NOT look like these)
- Generic SaaS dashboards; icon+heading+text card grids.
- Crypto-neon-casino aesthetics; tradable-agent speculation (Virtuals-style).
- Faceless "function tile" agent lists (emoji rows).
- AI-slop: gradient text, colored side-stripe borders, decorative glass, hero-metric template.

## Strategic principles
1. **UI = reality.** Honest `live / скоро / R&D` labels; never dead-end a paid flow into an unbuilt screen.
2. **One primary (amber) CTA per screen.** Everything else is secondary.
3. **One canonical credit unit** ("Credits / кр"); never show contracts/gas. Top-up via TON Connect + HOT Wallet (no Telegram Stars).
4. **Own key/provider = free** (commission only on AIAG-supplied models).
5. **Mobile / Telegram-native first.** Single-column, thumb-reachable, fast.
6. **Characters are the differentiator** — invest craft there; faces come from founder-supplied references later (stylized placeholders until then).

## Color strategy
Committed dark base + amber accent (~10–15% of surface) + per-character accent hues in the catalog. OKLCH throughout; reduce chroma at lightness extremes.
