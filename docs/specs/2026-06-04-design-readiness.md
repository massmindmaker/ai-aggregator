# AIAG — Design Readiness (CONSOLIDATED, current verdict)
> 2026-06-04 · supersedes the 3 scattered evals · author: project-lead (Claude), critical pass
> Sources of truth read for this: `/DESIGN.md` (tokens), `/PRODUCT.md`, `/CLAUDE.md` (real-vs-fantasized), `.planning/STATE.json` (20 shipped), the **shipped code** (`apps/tg-miniapp/app/*`), and the wireframes (`docs/wireframes/{tma,web,showcase}`).

---

## 0. One-paragraph verdict
The design **system** (tokens, collectible-card concept, hairline elevation, mono-numerics, amber discipline) is genuinely strong and well-documented — that part earns its 89. But "design readiness" is not the showcase; it's **what ships**. Three things break the prior optimism: (1) the older evals scored *artifacts that diverge* — the 89 is the flagship `showcase.html`, the 61 is the lo-fi boards, and **neither is the shipped TMA**; (2) the shipped TMA is a **third visual language** — inline-styled chat bubbles, leftover `tma-nft-*` CSS class names (NFT was supposedly removed), monogram-in-gradient "cards" that are NOT the hi-fi collectible cards the docs promise; (3) the **run-trace surface** that DESIGN.md calls a signature component **does not exist in code** — runs render as plain bubbles with "…думает", no tool-call cards, no cost/token badges. So the honest readiness number sits **between the showcase and the boards, dragged down by the shipped reality**.

**Consolidated score: design system 86/108 · shipped TMA 64/108 · weighted readiness ≈ 72/108.** (Prior "89/108" was the showcase ceiling, not readiness.)

---

## 1. Which old docs are now SUPERSEDED (read this first)
| Doc | Status | Why |
|---|---|---|
| `docs/specs/2026-06-03-design-eval-108-v2.html` (**89/108**) | **STALE / partial** — keep as the *showcase* score only | Scored `showcase.html` (the flagship), not the shipped app. Its "borders drag it down" caveat is correct but understated. Do not cite 89 as product readiness. |
| `docs/specs/2026-06-03-aiag-ux-critique.html` (**61/108**) | **STALE** — predates 5+ shipped screens | Critiqued the 39-artboard wireframe board. Many of its findings (provider-picker = "скоро" deadend, NFT-in-tabbar, schedules/skills missing) are now **shipped in code** → its score is no longer the product's. Its UX *principles* (one CTA, first-run state, blocking low-balance, dejargonize) remain valid and **mostly still unfixed in the real app**. |
| `docs/specs/2026-06-03-design-108-eval-and-improvement-plan.md` (boards ~61, showcase 89) | **SUPERSEDED by THIS doc** | Its "honesty" thesis is right and still the #1 axis, but it predates the 20 shipped items in STATE.json. Its Part-1 "what works" table is out of date (skills/MCP/schedules/templates/rent now exist). |
| **THIS doc** (`2026-06-04-design-readiness.md`) | **CURRENT** | Single design verdict going forward. |

`/DESIGN.md` is NOT superseded — it remains the token SoT. The three eval docs above are.

---

## 2. Re-score on the 108 scale (12 dims × 9) — scored against the SHIPPED TMA, with the system noted
Prior: showcase 89 · boards 61. **Current weighted readiness ≈ 72/108.**

| # | Dimension | System | Shipped | Evidence |
|---|---|---|---|---|
| 1 | Visual hierarchy | 8 | 6 | Shipped pages use ad-hoc inline styles; agents/detail mixes header + edit form + schedule form + history + composer + delete on one scroll with no clear single CTA. |
| 2 | Typography | 9 | 8 | Mono-numerics carried into shipped (`fontVariantNumeric:'tabular-nums'`, `tma-mono`). Good. Minor: model slug `word-break:break-all` is ugly on cards. |
| 3 | Color / accent discipline | 8 | 7 | Tokens correct; amber kept to CTA. But hard-coded `#fca5a5` for the delete button bypasses `--danger`. |
| 4 | **Consistency** | 7 | **4** | **Worst structural gap.** THREE languages: showcase (hi-fi OKLCH), boards (lo-fi hex+emoji), shipped (inline-styled + `tma-nft-*`). Cards reuse the **NFT** class names after NFT was "removed". |
| 5 | Function honesty | 7 | 7 | Shipped is honest by construction (it only renders real data). Wireframes still over-promise; status pills exist in showcase, thinner in the app. |
| 6 | Component completeness | 8 | 5 | DESIGN.md's element set (run-trace, provider-picker rows, budget card, status pill, skeleton) is **only partly built**. No run-trace, no skeleton, no reusable card component (cards are bespoke per page). |
| 7 | Motion / micro-interactions | 8 | 5 | `aiag-*` library defined; shipped uses a basic hover `translateY(-2px)` + "…думает" text. No streaming/loading state, no skeletons, no stagger. |
| 8 | Themes / surfaces | 8 | 8 | Dark TMA + light Web both real in wireframes; tokens drive both. Shipped TMA is dark-only (correct). Light theme is **wireframe-only — never shipped to a real web app surface.** |
| 9 | Logo / brand | 9 | 8 | Real amber-chain logo in showcase. Shipped uses a `tma-badge` "AIAG" text badge — not the chain logo DESIGN.md mandates ("never the ◆/AIAG text placeholder"). |
| 10 | Navigation / IA | 7 | 6 | Shipped has a real `BottomNav`; better than the 3-divergent-nav wireframes. But "Маркет" still conflates models/skills/MCP/templates conceptually. |
| 11 | Content / copy honesty | 6 | 8 | **Big improvement in shipped:** real data, real credit labels (`кр/мес`), no fake "48k запусков". Wireframe boards still print demo metrics as fact → the 6 is the boards. |
| 12 | Accessibility / states | 7 | 5 | `--ink-muted` raised for AA (good). But shipped lacks empty/error/loading polish, focus rings are default, low-balance blocking state absent, run cost never shown to the user. |

**System total ≈ 86. Shipped total ≈ 64. Weighted readiness ≈ 72/108.**
Weakest shipped axes: **consistency (4), motion (5), component completeness (5), accessibility/states (5).**

---

## 3. Genuinely STRONG (don't touch, protect these)
- **Token system / `/DESIGN.md` as single SoT** — disciplined OKLCH, one palette, dark+light derived from the same vars. Top-tier.
- **Collectible-character-card concept** — the real differentiator vs faceless function tiles; per-hue identity is principled, not random.
- **Hairline elevation + amber discipline** — 1px lines, amber only on CTA/active/featured. Consistently applied in the system layer.
- **Mono-on-all-numerics + eyebrow** — carried into shipped code, not just the showcase.
- **Honest-by-construction shipped data** — the real app shows real numbers; the canon's "UI = reality" rule is actually met in code (the lie lives only in wireframes).

## 4. REAL remaining gaps (the honest list)
1. **Collectible-card signature is NOT consistent in the shipped app.** `/agents` and `/templates` render a *monogram on a gradient* using `tma-nft-*` classes — not the DESIGN.md card (portrait/video, role, main model, runs, ★, featured 2px ring). The signature exists in `showcase.html` and dies on contact with the real app. Worse: the class names still say **NFT** after the founder removed NFT.
2. **Run-trace UI is unbuilt.** DESIGN.md names it a signature component ("the missing 'what did my agent do' surface": timeline + tool-call cards + cost/token badges). Shipped reality = chat bubbles + "…думает". The user **never sees what a run cost** — directly contradicts the credit-economy product thesis ("почему это стоило 12 кр").
3. **Three visual languages, not one.** Showcase ≠ boards ≠ shipped. The shipped app is built with per-page inline styles, so there is no shared component contract — every new screen re-invents layout.
4. **No mobile/web parity in product.** Light theme (Studio23) exists only in `docs/wireframes/web/` — there is **no shipped web TMA surface** at all. The "two boards / two themes" decision is a design artifact, not a shipped reality.
5. **State coverage thin in shipped.** No skeletons, no streaming/loading affordance, no inline "недостаточно кредитов" blocking state at the paid moment, default focus rings. These are exactly the UX-critique findings — still open in the real app, even though the wireframes that flagged them are now "stale".

---

## 5. TOP-5 design fixes (impact × leverage)
1. **Build ONE real collectible-card component** (`AgentCard`) and use it in `/agents` + `/templates` + market. Kill the `tma-nft-*` class names (rename to `tma-agent-card`). Add role + main-model + runs + ★ + featured ring. Closes gap #1+#3 in one move; this is the product's signature and it currently only lives in a demo file.
2. **Ship the run-trace surface.** Replace the bubble history on the agent detail page with a step timeline + tool-call cards carrying a **cost/token badge per run**. This is the single highest-leverage fix: it makes the credit economy legible and delivers the DESIGN.md signature the whole product is sold on.
3. **Extract a shared component layer** (`Card`, `Button`, `StatusPill`, `Skeleton`, `Field`) from the inline styles now scattered across shipped pages. One contract → consistency (dim 4) jumps from 4→7 and every future screen stops re-inventing layout.
4. **Add the paid-moment states**: skeleton on run-fetch, a real "…агент работает" affordance (pulse, not grey text), and an inline **"не хватает N кр → пополнить"** block in the composer instead of a silent failure. Lifts motion + accessibility + edge-cases together.
5. **Swap the `tma-badge` text for the real amber-chain logo** and reconcile the wireframe boards to shipped reality (mark demo metrics, drop the 3rd nav set). Cheap brand + honesty win; aligns the artifacts so reviewers stop scoring three different products.

---

## 6. Footnotes for the founder
- The "design = 89" in `STATE.json.meta.scores_108` should be **corrected to a readiness figure (~72)** or relabeled `design_showcase: 89`. Right now it overstates shipped readiness by ~17 points.
- None of the top-5 fixes require backend work — they are pure frontend/component work on `apps/tg-miniapp`, verifiable on prod after a manual TMA build (no local runtime, per project rule).
