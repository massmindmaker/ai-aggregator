# DESIGN.md — AIAG design system (single token source of truth)

The one design contract for **both surfaces** (TMA mobile + Web) and **both themes** (dark default + light). Tokens are lifted verbatim from the live app `apps/web/src/app/globals.css` + `apps/web/tailwind.config.ts`. Format adopted from VoltAgent's `awesome-design-md` (MIT — attribution kept). Product truth: `/CLAUDE.md`; product def: `docs/specs/2026-06-02-tma-product-definition.md`.

> Rule: every wireframe, showcase, and built component must resolve to THESE tokens. No second palette. Dark = default + TMA; light = web; the same markup re-themes via a `.dark`/`.light` class (next-themes style).

## Color tokens

**Dark (default, TMA):**
`--bg #0a0a0b` · `--bg-elev #111114` · `--bg-surface #18181b` · `--ink #f4f4f5` · `--ink-muted #8b8b94` (raised from #71717a for <14px AA) · `--ink-faint #71717a` · `--accent #f59e0b` · `--accent-hover #d97706` · `--accent-ink #000` · `--line rgba(255,255,255,.08)` · `--line-strong rgba(255,255,255,.16)` · `--success #22c55e` · `--danger #ef4444` · `--warning #eab308` · `--radius 8px`

**Light (web):**
`--bg #fff` · `--bg-elev #fafafa` · `--bg-surface #f4f4f5` · `--ink #18181b` · `--ink-muted #6b6b73` · `--accent #f59e0b` (same amber) · `--accent-hover #d97706` · `--accent-ink #000` · `--line rgba(0,0,0,.08)` · `--line-strong rgba(0,0,0,.16)` · `--success #16a34a` · `--danger #dc2626` · `--warning #ca8a04`

**Per-character hues** (functional, agent cards only — NOT global palette): OKLCH duotone per character (Алиса 28, Макс 235, Ника 340/50, Гриша 165, Лея 60, Орион/Нова 290–300). Decoration, not brand.

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
`aiag-fade-up` (+ `.aiag-stagger`), `aiag-glow-hover`, `aiag-pulse-dot` (live/streaming), `aiag-skeleton`, `aiag-aurora` (ambient amber blur), `aiag-featured-ring` (conic spin), `aiag-logo-dot` (chain glow), `aiag-check-draw`, view-transition cross-fade, drawer/sheet slide. **Rules:** transform/opacity only, ease `cubic-bezier(.23,1,.32,1)`, no bounce, full `prefers-reduced-motion` off-switch.

## Themes
Dark = TMA + default. Light = web. Token-driven `.dark`/`.light` on `<html>` (next-themes). Same components, swap variables. The `showcase.html` proves the matrix (web/mobile × dark/light).

## Adopt / adapt / skip (from VoltAgent `awesome-design-md`, MIT)
- **Adopt:** this DESIGN.md-as-SoT format; hairline elevation; accent discipline; eyebrow + all-numerics-mono; 2px-accent-featured; run-trace timeline + tool-call cards; sidebar active-amber.
- **Adapt:** their green → our amber; their dark-only → we also derive light.
- **Skip:** VoltOps console code (proprietary); any second palette.

## Sources
`apps/web/src/app/globals.css`, `apps/web/tailwind.config.ts` (live tokens + the `aiag-*` keyframes) · VoltAgent `github.com/VoltAgent/awesome-design-md` (MIT) · `docs/specs/2026-06-03-voltagent-design-reuse.md`.
