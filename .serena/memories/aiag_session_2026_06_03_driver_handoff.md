# AIAG session 2026-06-03 — driver-mode handoff

Founder delegated full autonomous driving (high-level requirements only). Start next session from `/CLAUDE.md` + `.planning/.continue-here.md`. Single status surface = `docs/DASHBOARD.html` (run `docs/serve.bat`).

## What shipped this session (all on branch `plan/15.1-r0-billing-identity`, NOT merged)
- **Context anchor system (root-cause fix for drift):** `/CLAUDE.md` auto-loads + @imports `/DESIGN.md` (token SoT), `/PRODUCT.md`, `/SECURITY.md`, `docs/ARCHITECTURE.md`, `docs/ANIMATION.md`, `.claude/rules/coding-behavior.md` + per-app CLAUDE.md.
- **Research:** `docs/specs/research/SYNTHESIS.(html|md)` + R-01..R-12 → D-0..D-14, Waves 0-3, FD-1..FD-8. **D-0 keystone** = gateway must return realized margin (worker today invents price × USD_TO_RUB=90).
- **Design:** `docs/wireframes/showcase.html` (web+mobile × dark+light, function-honest, **89/108**) on real ai-aggregator tokens + real chain logo; tma+web boards; `characters-video.html` (holographic rectangular video cards, NFT removed, faces deferred).
- **Backend Wave-0 + D-8** built + unit-green on VPS web-repo, **NOT deployed**. settleRun untouched. Stack branches: `feat/wave0-safefetch-defaultmodel` → `feat/wave0-d0-margin` → `feat/wave0-d8-initdata` (tip = all 6 Wave-0 commits).
- **CI/CD:** rebuilt `.github/workflows/deploy-production.yml` (build-all-on-runner = no 2GB OOM, atomic current-swap, self-heal pm2 from ecosystem-on-current, per-app matrix, gated migrations) + `ops/ecosystem.config.cjs`. Decision: bare-VPS + GitHub Actions (not Timeweb Apps).
- **Single hub:** `docs/DASHBOARD.html` v2 + `docs/serve.bat`; dupes → `docs/specs/_archive/`. Rule: new artifact = a card here, never a new orphan page.
- **Gonka:** `docs/specs/2026-06-03-gonka-{checklist.html,pitch.html,grant-application.md}`. Submit via Gonka Discord (no form).

## Founder decisions 2026-06-03
Multi-crypto credits (TON+others, USD-pegged) · Stars deferred · legal not-now (foreign entity buys from RF aggregator) · managed-Hermes BUILD on ~18GB shared VPS → tier later (connect-your-own-Hermes = live path) · monetization = **author-rent** (author sets free/price; user pays model+deploy+author's exact sum; **AIAG 0% on rent**, earns on model markup/tools/deploy) · NFT removed · 2-app architecture firm · single dashboard hub.

## BLOCKER — pm2 absolute-path trap (blocking deploy)
pm2 runs absolute OLD-release paths, not `/srv/aiag/<app>/current` → symlink swap is a no-op, `pm2 restart` re-execs old code. Wave-0 symlinks swapped on VPS but running code is still old. **Fix:** put `ops/ecosystem.config.cjs` → `/srv/aiag/shared/ecosystem.config.cjs`, then `pm2 delete <app> && pm2 start ecosystem --only <app>` (re-pin to current). Deploy paused per founder; prod = old R0, healthy.

## Advisory
- fail2ban bans VPN exit IP after rapid SSH connects → ONE SSH session.
- Workflow JS: no nested backticks, no apostrophes in '…' strings, no `${VAR}` in '…' strings; schema-agents can fail "without StructuredOutput" → prefer schema-free file-writing agents.
- Secrets (Timeweb token, GitHub PAT) in env/keyring, gitignored, NOT committed. **Rotate both** (pasted in chat).

## Pending human actions
1. Founder "go" → resume Wave-0 deploy via pm2 re-pin (live billing).
2. Confirm GitHub deploy secrets + decide auto-deploy-on-push.
3. Gonka: GNK wallet + Discord + email + endpoint spike → submit.
4. Rotate tokens.
