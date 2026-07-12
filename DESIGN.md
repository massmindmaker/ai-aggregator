# DESIGN.md — AIAG design system (single token source of truth)

The one design contract for **both surfaces** (TMA mobile + Web) and **both themes** (dark default + light). Tokens are lifted verbatim from the live app `apps/web/src/app/globals.css` + `apps/web/tailwind.config.ts`. Format adopted from VoltAgent's `awesome-design-md` (MIT — attribution kept). Product truth: `/CLAUDE.md`; product def: `docs/specs/2026-06-02-tma-product-definition.md`.

> Rule: every wireframe, showcase, and built component must resolve to THESE tokens. No second palette. Dark = default + TMA; light = web; the same markup re-themes via a `.dark`/`.light` class (next-themes style).

## Color tokens

**Dark (default, TMA):**
`--bg #0a0a0b` · `--bg-elev #111114` · `--bg-surface #18181b` · `--ink #f4f4f5` · `--ink-muted #8b8b94` (raised from #71717a for <14px AA) · `--ink-faint #71717a` · `--accent #f59e0b` · `--accent-hover #d97706` · `--accent-ink #000` · `--line rgba(255,255,255,.08)` · `--line-strong rgba(255,255,255,.16)` · `--success #22c55e` · `--danger #ef4444` · `--warning #eab308` · `--radius 8px`

**Light (web):**
`--bg #fff` · `--bg-elev #fafafa` · `--bg-surface #f4f4f5` · `--ink #18181b` · `--ink-muted #6b6b73` · `--accent #f59e0b` (same amber) · `--accent-hover #d97706` · `--accent-ink #000` · `--line rgba(0,0,0,.08)` · `--line-strong rgba(0,0,0,.16)` · `--success #16a34a` · `--danger #dc2626` · `--warning #ca8a04`

**Per-character hues** (functional, agent cards only — NOT global palette): OKLCH duotone per character (Алиса 28, Макс 235, Ника 340/50, Гриша 165, Лея 60, Орион/Нова 290–300). Decoration, not brand.

**OKLCH mandate — scoped (review 2026-07-10):** OKLCH is mandatory **only** for per-character hues above (decorative accent per agent card). The base palette (bg/ink/accent/line/status colors) is hex — that is the source of truth, verbatim from `apps/web/src/app/globals.css`. Do not introduce `oklch()` into the base palette; 0 usages across the repo confirms this was never actually the working format for base tokens, only ever intended for character hues.

**Internal shadcn/Tailwind HSL layer (not a second source of truth):** `apps/web/src/app/globals.css` also defines shadcn-convention HSL triples (`--background`, `--foreground`, `--card`, `--primary`, `--muted`, `--border`, `--input`, `--ring`, etc.) alongside the hex tokens above. These exist only because shadcn/ui components consume Tailwind's `hsl(var(--x))` convention — they are a **derived/internal implementation layer for shadcn component styling**, not an independent palette. When a value can be expressed in both systems (e.g. `--bg` hex vs `--background` HSL), the **hex token is authoritative**; the HSL twin must stay visually equivalent to it. New tokens are added as hex first; only mirror into HSL if a shadcn primitive requires it.

**Accent discipline (VoltAgent rule):** amber is for **CTA + logo + live/active status + featured ring** only. NEVER amber body text, NEVER amber as a large fill except the primary button.

## Typography
- **Sans:** Inter (`--font-inter`). **Mono:** JetBrains Mono — used for **all numerics** (wallet balance, costs, run timings, token counts, leaderboard, IDs, addresses) and the **eyebrow** label.
- **Eyebrow:** uppercase JetBrains Mono, letter-spacing ~.16–.2em, `--ink-faint`/accent.
- Scale (tailwind): 2xs 11 · xs 12 · sm 14 · base 16 · lg 18 · xl 20 · 2xl 24 · 3xl 30 · 4xl 36 · 5xl 48 · 6xl 60 · 7xl 72. Body ≤75ch. Weight contrast ≥1.25 between steps.

## Space · radius · elevation
- Radius: `--radius 8px` (md = -2, sm = -4). Pills (chips/FAB/segment) keep their physical pill shape.
- **Elevation = hairline, not material shadow** (VoltAgent): 1px `--line` borders define surfaces; hover = amber **glow ring** (`aiag-glow-hover`); heavy drop-shadow ONLY for modals/sheets. No generic card drop-shadows.
- Vary spacing for rhythm; don't pad everything identically; avoid nested cards.

## Logo
4-node amber **chain** (`apps/web/public/ai_logo_v1.png`, inlined as `--logo-mask` base64). Render: `background:var(--accent); -webkit-mask:var(--logo-mask) center/contain no-repeat` + wordmark **"AI·Aggregator"** (Inter, amber `·`). Optional `aiag-logo-dot` chain-glow. **Never** the old `◆`/`AIAG` text placeholder.

## Components (the unified element set)
- **Button** — primary: amber fill, `--accent-ink` text, radius 8. Secondary: ghost (transparent + `--line`). One amber primary per screen.
- **Card** — `--bg-surface`/`--bg-elev`, 1px `--line`, radius 8, hover glow. **Agent character card**: per-hue portrait (video on TMA / monogram fallback), name + role + main model + runs + ★; featured = 2px accent ring (`aiag-featured-ring`).
- **Run-trace** (the missing "what did my agent do" surface — reimplement VoltOps patterns): vertical step **timeline** + collapsible **tool-call cards** (mono tool name, args/result, duration + token + **cost** badge, status pill) + a metrics strip. Build our own (VoltOps UI is proprietary).
- **Provider picker** — list rows: AIAG (+наценка) / OpenRouter / BYOK / Gonka / Custom; "свой = 0 комиссии".
- **Wallet** — mono balance, multi-crypto top-up (TON/USDT/ETH/SOL), **no Stars, no ₽**; agent budget-card (daily + per-call cap + allowlist).
- **Modal / bottom-sheet** — scrim + dialog (web) / slide-up sheet (mobile). Modal is a last resort, prefer inline.
- **Nav** — web: left sidebar, **active = amber indicator**; mobile: bottom tabbar, active = amber.
- **Input** — `--bg-surface`, 1px `--line`, focus = amber ring. **Status pill** — icon **+ word** (never color alone): live/скоро/R&D/ok/error. **Skeleton** — `aiag-skeleton` shimmer.

## Motion — keep our own `aiag-*` library (VoltAgent has none)

**Shared core (both surfaces — TMA `apps/tg-miniapp/app/globals.css` + web `apps/web/src/app/globals.css`):**

| Class | Effect | Where it is used |
|---|---|---|
| `aiag-fade-up` (+ `.aiag-stagger`) | fade + 16px lift; stagger for grids/lists | both |
| `aiag-glow-hover` | amber glow ring on hover | both |
| `aiag-pulse-dot` | live/streaming status dot ping | both |
| `aiag-skeleton` | shimmer loader | both |
| `aiag-featured-ring` | conic-gradient spin ring (featured cards) | both |
| `aiag-aurora` | ambient amber blur spot | web hero + `/business`; TMA hub (`/dashboard`) |
| `aiag-logo-dot` | chain-glow across the 4 logo nodes | web `AiagLogo.tsx`; TMA `BrandMark.tsx` (pre-auth gate) |
| `aiag-check-draw` (`.aiag-check-svg`) | success checkmark draws in | web contest submit; TMA top-up confirmation (`CheckDraw` in `Icon.tsx`) |

`aiag-logo-dot` is always paired with `aiag-logo-halo` — the halo circle sits behind each node and carries the glow bloom via `transform`+`opacity` (it replaced a `filter: drop-shadow`, which was off-contract).

**Cross-page transition (both apps):** `aiag-vt-fade-out` / `aiag-vt-fade-in` — the View Transitions cross-fade keyframes bound to `::view-transition-old(root)` / `::view-transition-new(root)`. They have **no class carrier** (they attach to the pseudo-elements directly), which is exactly why they are easy to lose — enumerate them here.

**Web-only (marketing/landing/admin surfaces):** `aiag-pulse` (live dot on hero/leaderboard/stream badges) · `aiag-cursor` (terminal blink) · `aiag-hero-canvas`, `aiag-hero-lattice` (animated hero backdrop) · `aiag-float-card` (floating model cards) · `aiag-logo-track` (provider-logo marquee) · `aiag-grid-bg-glow`, `aiag-grid-bg-glow-alt` (drifting grid spot) · `aiag-drawer-overlay`, `aiag-drawer-panel-enter` (mobile drawer) · `aiag-sparkline-path` (draw-in) · `aiag-row-hover` (admin tables) · `aiag-pulse-dot-success`, `aiag-pulse-dot-danger`, `aiag-pulse-dot-muted` (dot colour modifiers).

**Static `aiag-*` helpers (no animation — layout/decor only, listed so they are never mistaken for a motion gap):** `aiag-hero`, `aiag-hero-grid`, `aiag-hero-overlay`, `aiag-hero-badge`, `aiag-hero-stats`, `aiag-hero-terminal`, `aiag-pricing-grid`, `aiag-floating-cards` (hero/pricing geometry + responsive rules) · `aiag-grid-bg-sm` (static grid backdrop) · `aiag-cells-spot` (cellular-automaton mask).

**TMA-only:** `tma-page-enter` (route enter) · `tma-sheet-*` (bottom-sheet) · `aiag-holo-drift` (collectible-card foil).

### Perimeter of this section (so "is the doc complete?" is decidable, not a judgement call)
This section enumerates exactly two kinds of `aiag-*` symbol, and any check for drift must use the same set:
1. **every `aiag-*` class** declared in `apps/web/src/app/globals.css` + `apps/tg-miniapp/app/globals.css` — animated *and* static (the static ones are listed above precisely so a scanner does not report them as missing);
2. **every `@keyframes aiag-*` that has no `.aiag-*` class carrier** — i.e. referenced only from a pseudo-element or a non-`aiag` selector. Today there are exactly three: `aiag-vt-fade-in`, `aiag-vt-fade-out` (bound to `::view-transition-*`) and `aiag-holo-drift` (bound to `.tma-agent-card … ::before`, documented below as a known exception).

**Deliberately NOT enumerated:** `@keyframes` names that merely back a documented class (`aiag-shimmer` ← `.aiag-skeleton`, `aiag-conic-spin` ← `.aiag-featured-ring`, `aiag-logo-dot-pulse` ← `.aiag-logo-dot`, `aiag-logo-halo-bloom` ← `.aiag-logo-halo`, `aiag-aurora-drift` ← `.aiag-aurora`, `aiag-grid-spot-drift`, `aiag-lattice-drift`, `aiag-bg-fade-in`, `aiag-cursor-blink`, `aiag-scroll-left`, `aiag-float-1/2/3`, `aiag-drawer-slide-in`, `aiag-overlay-fade-in`). Their names are implementation detail of a class that *is* documented; the class is the public surface. Listing them would duplicate, not clarify.

**Rules:** **`transform`/`opacity` only** — no `filter`, no `background-image`, no `box-shadow` keyframes. Ease `cubic-bezier(.23,1,.32,1)`, no bounce.
- **No inline `animation:`** in TSX — an inline style cannot be switched off by a reduced-motion CSS rule. Always attach a carrier class; parametrise with CSS vars if the timing varies (`.aiag-fade-up` takes `--fade-dur` / `--fade-delay`).
- **No `aiag-*` declared without a consumer** (issue #23).
- **`prefers-reduced-motion: reduce` — coverage must be total; block count differs per app:**
  - **web:** exactly **one** consolidated `@media` block at the bottom of `globals.css` — a universal `*` timing-collapse safety net plus an explicit `animation: none` list.
  - **TMA:** **one** consolidated block for the whole `aiag-*` library, plus **5 local blocks** sitting next to the `tma-*` definitions they switch off (`tma-agent-card`/holo, `tma-skeleton`, `tma-acc-body`, `tma-sheet` ×2). This is deliberate, not drift: the last one is **nested inside `@supports (transition-behavior: allow-discrete)`** and therefore *cannot* be hoisted into a single top-level block without changing what it overrides. Coverage is complete either way — every animated `aiag-*` and `tma-*` selector is switched off.
  - End-states are pinned wherever a freeze would look broken: `.aiag-hero-canvas` → `opacity:.55`, `.aiag-check-svg path` / `.aiag-sparkline-path` → `stroke-dashoffset:0`, `.aiag-stagger > *` → `opacity:1`, `.aiag-logo-halo` → `opacity:0`.
- **Known exceptions to transform/opacity (all three deliberate, all pinned or switched off under reduce):**
  1. `aiag-check-draw` and `aiag-sparkline-draw` animate **`stroke-dashoffset`** — an SVG stroke draw-in is not expressible via `transform`/`opacity` (it reveals path length, not position or alpha). Under reduce both are pinned to their end state (`stroke-dashoffset: 0` = fully drawn), so the shape is complete and static.
  2. `aiag-holo-drift` (TMA collectible-card foil) animates **`background-position`** — pre-existing, kept as the card signature; it has its own reduced-motion switch.

## Themes
Dark = TMA + default. Light = web. Token-driven `.dark`/`.light` on `<html>` (next-themes). Same components, swap variables. The `showcase.html` proves the matrix (web/mobile × dark/light).

## Adopt / adapt / skip (from VoltAgent `awesome-design-md`, MIT)
- **Adopt:** this DESIGN.md-as-SoT format; hairline elevation; accent discipline; eyebrow + all-numerics-mono; 2px-accent-featured; run-trace timeline + tool-call cards; sidebar active-amber.
- **Adapt:** their green → our amber; their dark-only → we also derive light.
- **Skip:** VoltOps console code (proprietary); any second palette.

## Sources
`apps/web/src/app/globals.css`, `apps/web/tailwind.config.ts` (live tokens + the `aiag-*` keyframes) · VoltAgent `github.com/VoltAgent/awesome-design-md` (MIT) · `docs/specs/2026-06-03-voltagent-design-reuse.md`.
