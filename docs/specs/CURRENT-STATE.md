# AIAG — current state (AUTO-GENERATED from .planning/STATE.json — do NOT edit by hand)

> updated 2026-06-04 · branch feat/r1.0-wave0-consolidated · not in master · scores/108: func 52 / tech 55 / design 72
> ai-aggregator.ru (web, ₽) · TMA via @aiaggbot (crypto credits)

## ✅ Shipped
- **D-0 — gateway realized margin (FIXED + wired, gold-verified 2026-06-04)** — Was BROKEN (gateway RUB headers ≠ worker USD-micro reader → worker billed off estimate, not realized margin; the test asserted a fabricated header). FIXED: gateway now emits x-aiag-charged-usd-micro + x-aiag-upstream-cost-usd-micro. GOLD-VERIFIED on prod — a live :4000 completion returned charged=4000µ$ ($0.004), upstream=3200µ$, margin=800µ$. Worker reads it → bills REALIZED margin. Contract tests pin the names byte-equal both sides (anti-drift). RUB headers kept for web. Money-reviewed: NO double-billing (gateway debits house-org, worker debits the TMA user). The readiness assessment caught it; this closes it.
- **D-1 — USD-credit ledger** — 1 credit = 1 US cent (BIGINT); killed USD_TO_RUB=90; append-only tg_ledger_entries; settleRun atomic (guarded UPDATE…WHERE balance>=cost RETURNING + ledger co-committed). Gold-verified.
- **Wave-1 Slice 1 — publish / browse / clone-free** — agent_templates has ZERO secret columns by design. Paid template → 402 (no free clone of paid).
- **Wave-1 Slice 2 — paid rent + author payout (0% AIAG)** — whole rent in ONE sql.begin: debit renter → upsert-credit author 100% pass-through → 2 equal-and-opposite ledger entries → clone in-tx. uq_rental_active stops double-charge. Money-reviewed twice (split-tx HIGH fixed).
- **Wave-1 Slice 3 — author income view** — read-only, scoped to authed author. Withdraw deferred on FD-2.
- **Creator economy — ratings + remix-lineage + sort** — ratings eligibility-guarded (only cloned/rented can rate; create route strips client tpl: kind → server-trusted). catalog ?sort=trending|top|new. Review caught BLOCKER+HIGH+MED, all fixed.
- **Scheduled agent runs (self-running agent)** — 60s worker tick claims due schedules (gated on agents.status=active) → enqueues a normal budget-guarded run. No new billing. MUST-FIX (soft-deleted spend leak) fixed before deploy.
- **₽→кр relabel in the agents UI** — founder rule 'draw credits, not ₽' — no ₽ left in any TMA page.
- **Screen 25 — full Schedules screen (named + daily/weekly cron)** — extends scheduled-runs: /schedules page, named schedules, time-of-day/weekday (Europe/Moscow), atomic per-kind claim. Gold-verified /me/schedules→200.
- **Screen 29 — Skills catalog v1** — relabel of the marketplace + agentskills.io SKILL.md: /skills (4 built-in tools + knowledge skills + MCP), «add to agent» via PATCH; scripts/slash/community = honest «скоро». Gold-verified /skills→200, 11 cards.
- **Screen 26 — Kanban over connect-your-own-Hermes (read-only)** — reads a connected BYO-Hermes's kanban API (/api/plugins/kanban/* on :9119) SERVER-SIDE via safeFetch (SSRF-reviewed PASS). CAVEAT: the Hermes dashboard binds 127.0.0.1 by default → a user must expose :9119 for data to appear; route is graceful (hermes_unreachable, never 500) until then. Can't gold-verify without a live exposed Hermes; route→404 on a random agent confirmed.
- **Agents catalog → collectible-character cards** — the user's /agents list now speaks the same per-hue collectible-card language as /templates (was emoji rows) — the founder's top design gap closed. Live.
- **Internal A2A — call_agent (agent hires agent, credits only)** — R-20 slice: an agent delegates a sub-task to another of the SAME user's agents; sub-cost rides toolFeesCredits → settleRun (no new debit, no crypto). Recursion-stripped (depth 1), per-run cap 3, ownership-guarded, BYOK-target=0. Money-reviewed; BLOCKER fixed (call_agent disabled for BYOK parents = no free-exfil). Deployed (worker 9ede010).
- **Gonka gateway-routed demo (grant deliverable #1)** — GOLD-VERIFIED: real completion through :4000 with model=gonka/qwen3-235b → content 'OK', real usage (15 tok), NOT the mock. gonka.ts adapter live, 0030 seeded (slug fixed → qwen/qwen3-235b-a22b-instruct-2507-fp8), GONKA_API_KEY on gateway env. Closes grant deliverable #1. Env gotcha: a var added to shared/.env after start needs `set -a; . .env; set +a; pm2 restart --update-env`.
- **Production design uplift — AgentCard + RunTrace + polished agent page** — REAL collectible-character cards (per-OKLCH-hue portrait) on /agents+/templates + the DESIGN.md run-trace (per-run кр cost finally visible) + complete agent detail (hero/spec/chips) + a shared component layer + real RU copy; fixed 7 broken bits (nft-class leftovers, AA tokens, skeletons, invisible run cost, weak empty states). Grounded in REAL functionality (run-trace honestly shows 1 step/run — no faked tool sub-steps). Live, pages 200, reviewed GO no regression. Path to 108: real character ART (founder refs — monograms are placeholder), ★/runs data on cards (small backend), drop the dead NFT nav tab.
- **TON top-up live on testnet (init gold-verified)** — founder provided a testnet wallet (0Q…); set TMA_TOPUP_WALLET_ADDRESS + TONCENTER_API_URL=testnet. topup/init → HTTP 200 returns a full TON Connect payment request (100 cr=$1 → 0.568 TON @ $1.76/TON, comment tag for reconcile). Full e2e (pay→reconcile→credit-mint) needs a real testnet payment via the UI; the init half + live rate fetch proven.
- **Screen 30 — MCP servers via OAuth 2.1 + PKCE (thin v1)** — OAuth-protected MCP: /start probes+discovers (RFC 9728/8414) + PKCE-S256 → system browser (Telegram.openLink) → single-use-state callback exchanges code → AES-256-GCM token (agent_mcp_oauth); worker refreshes-if-stale (guarded UPDATE) + passes Bearer (static fallback kept). Security-reviewed: PKCE/CSRF/SSRF(all hops safeFetch)/custody/refresh-race/ownership/no-open-redirect/0-commission ALL PASS. Routes live (start→404 ownership, callback-API→405, 0037=2 tables). TMA_PUBLIC_ORIGIN=https://ai-aggregator.ru set by fallback — CONFIRM it's the TMA's real public domain or OAuth redirect mismatches. Full e2e OAuth login needs a real OAuth-MCP server to verify.
- **Provider-picker (create + edit) — own key = 0 commission** — routes via external_openai branch; never sets agents.provider_id.
- **MCP skills (create + edit) — remote Streamable-HTTP per agent** — safeFetch-guarded, 0₽, connect-per-run.
- **White-label hardening (kie/openrouter/groq/ollama + tools.ts)** — brand kept only in server logs.
- **Repo made PRIVATE + security review passed** — no secrets in git history; auth/money/SSRF posture solid.

## 🔨 In progress
- **Living-state system (this file + gen-state + memory sync)** — STATE.json single source → generates STATUS.html → syncs memory; archive snapshots; kill manual dashboard patching.

## ⛔ Blocked
- **Managed Hermes runtime (the real Wave 2/3 core)** — needs a SEPARATE ~16GB VPS — the 2GB prod box hosts 0-1 instances (~300-600MB each) (founder: provision the box)

## 🔑 Decisions pending
- **FD-2** — Author income — withdrawable OUT vs in-app-spend-only?
- **FD-pricing** — Free-grant amount (research suggests 300 cr / $3 on first run) + markup (keep ×1.25?) — founder undecided

## 📋 Backlog
- P1: tg-miniapp money routes have ZERO tests [high]
- Jetton / USDT multi-crypto top-up [low]
- Opaque author handle instead of raw tg_user_id in the public catalog [low]
- Rate-limit publish / clone (anti-spam) [low]
- Automate pm2 in deploy (run procs under aiag) [med]
- Merge feat/r1.0-wave0-consolidated → master [med]

## 👤 Founder tasks
- Provision ~16GB Hermes VPS (paid, recurring) [pending]
- TON wallet — testnet provided + LIVE ✓; mainnet wallet for real-money go-live [testnet-done]
- Coinbase CDP Secret API Key (friend is registering) → for x402 v2 [pending]
- Gonka submission [in_progress]

---
_Source of truth: .planning/STATE.json · dashboard: docs/DASHBOARD.html · regenerate: node scripts/gen-state.mjs_
