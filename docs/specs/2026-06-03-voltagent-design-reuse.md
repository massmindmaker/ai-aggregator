# VoltAgent Design Reuse — Unifying AIAG's Element Language

**Date:** 2026-06-03
**Author:** research pass (Firecrawl/WebFetch on VoltAgent assets)
**Scope:** What VoltAgent offers design-wise, which pieces AIAG should adopt/adapt/skip, and the license position.

---

## 0. TL;DR

VoltAgent is the single closest design analog to AIAG that exists in the wild: an **open-source TypeScript AI-agent framework** whose brand is **dark-canvas + one electric accent + Inter/SF-Mono**, structurally identical to AIAG's `#0a0a0b` + `#f59e0b` amber + Inter/JetBrains Mono system. There are **two distinct assets**:

1. **VoltAgent's machine-readable `DESIGN.md`** (in `VoltAgent/awesome-design-md`, **MIT**) — a complete token spec (colors, type scale, spacing, radius, components, elevation, do/don't). **This is the directly reusable artifact** — we can lift its *structure* and several tokens verbatim, re-skinned amber-for-green.
2. **VoltOps Console** (the observability product: run-traces, timelines, tool-call logs, memory inspector) — **NOT open-source UI**. Paid/self-hosted product; the MIT repo (`@voltagent/core` etc.) ships the *framework*, not the console React code. So VoltOps is **inspiration for our run-trace UI, not code to copy**.

The biggest single win: `awesome-design-md` is itself a **library of MIT-licensed `DESIGN.md` files for 72 brands** (Linear, Vercel, Sentry, PostHog, Supabase, Stripe, Warp, Raycast…). We can adopt the **`DESIGN.md` format as AIAG's own single source of truth** so TMA + web + future AI-assisted UI generation all read one token doc.

---

## 1. What VoltAgent offers design-wise (with sources)

### 1.1 `awesome-design-md` — the catalog
- **Repo:** https://github.com/VoltAgent/awesome-design-md — **MIT licensed** (confirmed via GitHub API: `spdx_id = MIT`).
- **What it is:** a curated collection of **`DESIGN.md`** files. `DESIGN.md` is a plain-text, machine-readable design-system document (concept popularized by Google Stitch) that **AI agents read to generate consistent UI**. Each file is YAML-front-matter tokens (colors / typography / rounded / spacing / components / elevation) + a prose section (Overview, Colors, Typography, Layout, Elevation, Shapes, Components, Do's/Don'ts).
- **Layout:** `design-md/<slug>/DESIGN.md` (+ a per-slug `README.md`). 72 brands across AI/LLM, Dev Tools, Backend/DevOps, SaaS, Design tools, Fintech, E-commerce, Media, Automotive, Retro.
- **Hosted reader:** `https://getdesign.md/<slug>/design-md`; installable via `npx getdesign@latest add <slug>`.
- **Directly relevant slugs for a dark/amber/technical agent marketplace:**
  - `voltagent` — dark + single accent + Inter/mono (our twin). *Source of truth below.*
  - `sentry` — deep violet midnight canvas + electric-lime accent; **the model for an error/warning/trace palette** AIAG currently lacks at the marketing layer.
  - `vercel` — black/ink precision + per-stage mesh gradients (develop=cyan→teal, preview=violet→pink, ship=red→amber). The **amber `#f9cb28` "ship" gradient end is on-brand for AIAG.**
  - `posthog`, `supabase`, `clickhouse` — dashboard/data-table chrome (analytics surfaces).
  - `warp`, `ollama`, `raycast`, `cursor` — terminal-native / command-palette dev aesthetics.
  - `linear` — (entry exists but DESIGN.md fetched empty at time of research; the canonical reference for keyboard-first, dense, calm dark UI — worth re-pulling).

### 1.2 VoltAgent's own `DESIGN.md` (the twin)
**Source:** `design-md/voltagent/DESIGN.md` (MIT). Verbatim token highlights:

**Colors**
| Role | VoltAgent | AIAG equivalent |
|---|---|---|
| primary accent | `#00d992` (electric green) | `#f59e0b` (amber) |
| primary-soft | `#2fd6a1` | (none — add `--amber-soft`) |
| primary-deep (link) | `#10b981` | `#d97706` (`--accent-hover`) |
| on-primary (text on accent) | `#101010` | `#000` (`--accent-ink`) |
| canvas | `#101010` | `#0a0a0b` (`--bg`) |
| canvas-soft (inputs/code) | `#1a1a1a` | `#18181b` (`--bg-surface`) |
| (card body) | (= canvas) | `#111114` (`--bg-elev`) |
| hairline | `#3d3a39` (1px solid) | `rgba(255,255,255,0.08)` (`--line`) |
| ink | `#f2f2f2` | `#f4f4f5` (`--ink`) |
| ink-strong | `#ffffff` | `#fff` |
| body | `#bdbdbd` | (`--ink-muted` `#8b8b94`) |
| mute | `#8b949e` | (`--ink-faint` `#71717a`) |

> The two systems are **near-isomorphic** — same slots, same near-black canvas, single reserved accent. Migration is a find-replace of green→amber plus filling 2–3 missing tokens (`primary-soft`, semantic error/warning palette).

**Typography** — Inter (display/body/button/eyebrow, weights 400/500/600/700) + SF Mono (code, command snippets, **numeric metric counters**; the doc explicitly names **JetBrains Mono / Geist Mono as the free substitutes** — i.e. AIAG's JetBrains Mono is the *recommended* swap). Full scale: `display-xl 60/400/-0.65`, `display-lg 36/400/-0.9`, `display-md 24/700`, `display-sm 20/600`, **`eyebrow-mono 14/600/+2.52px tracking` (signature uppercase label)**, body 18/16/14, `code 13/400`, `code-strong 13/550`, `button-md 16/600`.

**Radius:** none 0 · xs 4 · sm 6 (buttons) · md 8 (cards) · pill 9999 (status tags only). → AIAG `--radius 8px` already matches the card value.

**Spacing:** 4px base — 2/4/8/12/16/20/24/32/40/48/64.

**Components (token-referenced):** `button-primary` (accent fill, near-black text, 6px), `button-outline-on-dark` (hairline border), `button-ghost-green` (text-only accent), `button-pill-tag` (pill status), `card-feature` (1px hairline, 8px, **no shadow**), `card-feature-emphasized` (3px hairline), `code-mockup` (terminal card + copy-to-clipboard), `code-inline-chip`, `text-input` (canvas-soft fill + hairline), `nav-bar`/`nav-link`, `hero-band`, `content-band`, `green-divider-band` (2px accent border), `footer`. Plus 10 **`ex-*` "kit-mirror" surfaces** auto-derived for downstream generation: `ex-pricing-tier(-featured)`, `ex-product-selector`, `ex-cart-drawer`, `ex-app-shell-row` (sidebar row, **active state = accent indicator**), `ex-data-table-cell` (mono-caps header), `ex-auth-form-card`, `ex-modal-card`, `ex-empty-state-card`, `ex-toast`.

**Elevation (4 levels) — the load-bearing idea:**
- L0 Flat (bands), **L1 Hairline = 1px solid border on canvas (default elevation — NOT shadows)**, L2 Inset Glow `0 0 15px rgba(92,88,85,.2)` (hover/featured), L3 Modal `0 20px 60px rgba(0,0,0,.7), inset 0 0 0 1px rgba(148,163,184,.1)`.
- Decorative: 2px solid accent border = "featured/active"; **1px dashed `rgba(79,93,117,.4)` divider** between section bands.

**Do/Don't (directly portable rules):** reserve accent for CTA + logo + live-status only (never body text); dark-only, no light-mode rhythm in marketing; **cards use hairlines + occasional glow, never material drop-shadows**; pair Inter (sentence-case) with mono (code only); calm display weight (400, not 700+).

### 1.3 VoltOps Console (the observability UI — inspiration only)
**Sources:** https://voltagent.dev , https://github.com/VoltAgent/voltagent (README screenshots), https://github.com/VoltAgent/ai-agent-platform.
VoltOps is VoltAgent's **observability/ops product**: real-time **execution traces** (deep-dive into agent execution flow), per-step **execution logs**, **performance metrics dashboards**, **memory/context/conversation-history inspector**, **prompt builder**, evals, guardrails, one-click deploy. **It is a paid + self-hosted product; its console UI is not in the MIT OSS repo** (the open-source side is the framework: `@voltagent/core`, `@voltagent/server-hono`, `@voltagent/libsql`, `@voltagent/logger`, `@voltagent/mcp-docs-server`). **Conclusion: copy the UI *patterns*, write the components ourselves.**

---

## 2. Specific reusable pieces worth adopting

1. **The `DESIGN.md` format itself** — adopt as AIAG's single token SoT (one file feeding TMA CSS, web Tailwind, and AI-assisted UI generation). This is the highest-leverage takeaway and is MIT-reusable as a template.
2. **Hairline-as-elevation** — standardize on 1px hairline borders (we already have `--line`/`--line-strong`); reserve glow for hover/featured, heavy shadow only for modals. Kills inconsistent drop-shadows across TMA/web.
3. **Accent discipline rule** — amber reserved for CTA + logo + live/status only; never body text, never decorative fills. Encode in our do/don't.
4. **`eyebrow-mono` label** — uppercase JetBrains Mono, +2.5px tracking, above section headers. Cheap, technical, unifying signature; pairs with our existing mono.
5. **Numeric metric counters in mono** — render tokens-used, latency, $cost, run-step counts in JetBrains Mono (VoltAgent uses mono for all numerics). Unifies wallet balance, run-trace timings, leaderboard stats.
6. **`code-mockup` + copy-to-clipboard chip** — terminal card pattern for our `HeroTerminal`/`CodeTabsDemo` and any API-key/snippet display.
7. **2px accent "featured/active" border + dashed section divider** — a calm, no-shadow way to mark active agent cards, active nav rows, and section rhythm.
8. **`ex-app-shell-row` active=accent-indicator** — left-edge / indicator-bar active state for `DashboardSidebar` / `AdminSidebar` / TMA bottom-nav.
9. **VoltOps run-trace UI patterns (build ourselves):** a vertical **timeline of run steps** with collapsible **tool-call cards** (tool name in mono, args/result JSON, duration + token + cost badges, status pill), a **memory/context inspector** panel, and a **metrics strip** (latency / tokens / cost). This is exactly AIAG's missing "what did my agent just do" surface.
10. **Sentry/Vercel palettes for the gap AIAG lacks:** a real **trace status palette** — success (our `#22c55e`), warning (`#eab308`), error/danger (`#ef4444`) — applied as status pills + trace-step left-borders, mirroring Sentry's dark-canvas+single-bright-accent model.

---

## 3. Adopt / Adapt / Skip — mapped to AIAG's element set

| AIAG element | Verdict | What to take from VoltAgent |
|---|---|---|
| **Token system / SoT** | **ADOPT** | Author an AIAG `DESIGN.md` in the awesome-design-md schema (MIT template). Feeds TMA `styles.css` + web `tailwind.config.ts`. |
| **Buttons** | **ADAPT** | `button-primary` (amber fill, `#000` text, 6px), `button-outline-on-dark` (hairline), `button-ghost` (amber text). We already have `--accent`/`--accent-hover`; align radius to 6px for buttons (keep 8px cards). |
| **Cards (generic)** | **ADAPT** | `card-feature`: 1px `--line`, 8px radius, **no shadow**. Drop any existing drop-shadows. |
| **Agent cards (character)** | **ADAPT** | Base on `card-feature`; **2px amber border = featured/active**; L2 glow on hover; mono for any stat counters. Keep AIAG's persona/portrait treatment (VoltAgent has no character-card concept — that's ours). |
| **Run-trace** | **ADAPT (pattern only)** | Build our own from VoltOps' trace/timeline/tool-call-card/metrics-strip patterns. Use status palette (§2.10). **No code to copy.** |
| **Provider picker** | **ADAPT** | `ex-product-selector` / pill-tag pattern: each provider = hairline card or pill, mono label, amber accent on selected (active=accent indicator). AIAG-specific (own-key/Gonka "free" badge) layered on top. |
| **Wallet / balance** | **ADAPT** | `ex-cart-drawer` "subscription summary" line-item pattern; **balance + costs in JetBrains Mono**; amber only for the top-up CTA. |
| **Modals** | **ADOPT** | `ex-modal-card` + L3 elevation (`0 20px 60px rgba(0,0,0,.7)` + inset hairline ring). One modal chrome across TMA + web. |
| **Nav (web sidebar + TMA bottom-nav)** | **ADAPT** | `nav-bar`/`nav-link` + `ex-app-shell-row` active=amber-indicator. Unifies `DashboardSidebar`/`AdminSidebar`/`MainNavbar`/TMA nav. |
| **Inputs / forms** | **ADOPT** | `text-input`: `--bg-surface` fill + 1px hairline + 6px radius. |
| **Status pills / badges** | **ADOPT** | `button-pill-tag` (9999px) for "Live"/"Beta"/run-status; amber for live, semantic colors for trace states. |
| **Toasts / empty states** | **ADOPT** | `ex-toast` (card shape + medium shadow), `ex-empty-state-card`. |
| **Eyebrow labels** | **ADOPT** | mono-caps + 2.5px tracking above sections (TMA + web). |
| **Section rhythm** | **ADAPT** | dashed hairline divider / occasional 2px amber `green-divider-band` equivalent. |
| **Light mode** | **SKIP for marketing, KEEP for app** | VoltAgent is dark-only and says so; AIAG needs light+dark for the app. Take the dark tokens as-is; **derive** a light counterpart ourselves (VoltAgent gives no light palette). |
| **Animation library (`aiag-*`)** | **SKIP / KEEP OURS** | VoltAgent's motion is minimal (no keyframe library). Keep AIAG's `aiag-fade/stagger/glow/pulse/shimmer/aurora/featured-conic`. Only borrow the *restraint principle* (calm, hairline-first, glow-not-shadow). |
| **Mesh gradients** | **SKIP (mostly)** | VoltAgent has none; Vercel's are optional. At most borrow Vercel's amber "ship" gradient end (`#f9cb28`) for a single hero accent — don't make it systemic. |
| **VoltOps console code** | **SKIP** | Not open source. Patterns only. |

---

## 4. License note — can we reuse their code?

- **`awesome-design-md` (incl. VoltAgent's `DESIGN.md` and the Sentry/Vercel/etc. files): MIT.** Confirmed via GitHub API (`repos/VoltAgent/awesome-design-md/license → spdx_id: MIT`). We can **copy, modify, and redistribute** the DESIGN.md tokens/structure freely; MIT only requires keeping the copyright + license notice. **Recommendation:** when we fork a DESIGN.md into AIAG's repo, retain a short attribution line (`Derived from VoltAgent/awesome-design-md, MIT`).
- **VoltAgent framework (`github.com/VoltAgent/voltagent`, `@voltagent/*` npm): MIT.** Reusable, but it's *framework/runtime* code (core, server-hono, libsql, logger, mcp-docs-server), **not UI/design components** — little design value beyond what the DESIGN.md already encodes.
- **VoltOps Console: proprietary / commercial product** (free dev tier + paid + self-hosted, but the console UI is **not** in the MIT repo). **Do not assume reuse rights for its UI.** Treat its trace/timeline/tool-call/memory-inspector screens as **design inspiration only** and reimplement.
- Tokens, color values, and layout *ideas* are not copyrightable regardless; the safe, clean path is: **fork the MIT DESIGN.md, re-skin amber, build our own React/CSS components.**

---

## Sources
- https://github.com/VoltAgent/awesome-design-md (MIT, confirmed via GitHub API)
- `design-md/voltagent/DESIGN.md`, `design-md/sentry/DESIGN.md`, `design-md/vercel/DESIGN.md` (raw, via GitHub contents API)
- https://getdesign.md/voltagent/design-md (hosted reader)
- https://voltagent.dev/
- https://github.com/VoltAgent/voltagent (README + packages)
- https://github.com/VoltAgent/ai-agent-platform
- AIAG token cross-reference: `docs/wireframes/tma/styles.css`, `docs/wireframes/web/styles.css`, `apps/web/tailwind.config.ts`
