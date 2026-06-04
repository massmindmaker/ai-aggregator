# AIAG — session 2026-06-04 (money P0 fixes + honesty + design consolidation)

**Source of truth:** `.planning/STATE.json` → generates `docs/specs/STATUS.html`. Nav hub =
`docs/DASHBOARD.html` (THE one canonical project dashboard — update in place, register new
docs as cards; NEVER create parallel dashboards). Branch `feat/r1.0-wave0-consolidated` (not master).

## Shipped this session (20 total, all prod + gold-verified via JWT/curl)
D-1 USD-credit ledger (1cr=1¢, atomic settleRun) · Wave-1 monetization (publish/clone/paid-rent,
author 0% AIAG cut + income + ratings + remix) · screens 25 Schedules / 26 Kanban-over-connect-
your-own-Hermes / 29 Skills-catalog / 30 MCP-OAuth (PKCE) · Gonka grant deliverable #1 (real
Qwen3-235B completion routed through `:4000`, gold-verified) · TON top-up live on **testnet**
(TMA public origin = **app.ai-aggregator.ru**) · internal A2A (`call_agent`, credits only) ·
collectible agent cards · provider-picker · MCP skills · white-label · security.

## Two money P0s found by the critical readiness pass + FIXED + gold-verified
1. **D-0 was BROKEN:** gateway emitted `X-AIAG-Charged-Rub` but the worker read
   `x-aiag-charged-usd-micro` → names never matched → `billedByGateway` always false → worker
   billed off its stale estimate table, not realized margin (the test asserted a fabricated
   header). FIXED: gateway now ALSO emits `x-aiag-charged-usd-micro` + `x-aiag-upstream-cost-usd-micro`;
   prod check returned charged=4000µ$/upstream=3200µ$/margin=800µ$. RUB headers kept for web.
   Byte-equal contract tests both sides (anti-drift). No double-billing (gateway debits house-org,
   worker debits the TMA user).
2. **Mock-billing footgun:** `getUpstream()` fell back to `mockUpstream` on a missing provider
   key → served a billed fake 'Mock reply'. FIXED: missing key (not `AIAG_FORCE_MOCK=1`) → clean
   white-label 503 → worker markFailed → not billed.

## Honest re-scores (108, code-grounded): functional 52 · tech 55 · design 72
(prior design 89 was the showcase ceiling, not product readiness). Unified design board =
`docs/wireframes/design-board.html` (mobile+web, dark+light, 45 screens, menu-left/screens-right)
supersedes the scattered tma/web/showcase boards. Readiness docs:
`docs/specs/2026-06-04-readiness-assessment.md` + `-design-readiness.md`.

## Remaining (P1/ops) + founder tasks
P1: tg-miniapp money-route tests (zero) · worker liveness/observability alerting · tracked
migrations + merge to master. Founder: Coinbase CDP Secret API Key (x402) · ~16GB Hermes box ·
mainnet TON wallet · FD-2 author-withdraw · FD-pricing. ⚠️ **rotate the Gonka `gp-` key**
(pasted in chat + now on the gateway env).

## Memory note
LightRAG `insert_text` dedups by a fixed source name (`text_input.txt`) → it REJECTS fresh
inserts ("duplicated"). Cannot sync new project state via that tool. Use STATE.json (live) +
memgraph (`AIAG` entity) + this Serena file + auto-memory MEMORY.md instead.
