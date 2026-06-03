# AIAG Session 2026-05-08 — Phase 14 Planning Complete

## TL;DR
Phase 14 (admin scope) plans READY TO EXECUTE. 3 PRs merged to master today. Stopped at user checkpoint before `/gsd:execute-phase 14` per user request to save state.

## Master state
- **Branch tip:** `4aaa4f8` — `plan(phase-14): admin scope`
- **PRs merged today:**
  - **#1** `chore/security-hono-cve` — Hono ^4.3.2 → ^4.12.16 (CVE-2026-39410 cookie prefix bypass + CVE-2026-39408 path traversal in toSSG)
  - **#2** `docs/specs-research-updates` — Phase 14-17 specs + 3 research artifacts in `docs/research/`
  - **#3** `plan/phase-14-admin` — 7 PLAN.md files for Phase 14 admin scope
- **Manual deploy needed:** gateway with new Hono — triggered `gh workflow run deploy-production.yml -f ref=master -f apps=gateway` (run 25548468428, completion not verified)

## Phase 14 plans (READY TO EXECUTE)
Location: `.planning/phases/14-contest-marketplace-admin/`

| Plan | Tasks | Wave | Goal |
|---|---|---|---|
| 14-01 | 3 | 1 | migration 0014 (8 schema entities) + tier_pct fn + settle_charge accrue hook |
| 14-02 | 2 | 2 | closeContestsCron + finalizeEarningsCron |
| 14-03 | 2 | 2 | /admin/contests/[slug] publish modal + API |
| 14-04 | 3 | 2 | /admin/payouts queue + tax + transactional approve |
| 14-05 | 2 | 2 | /admin/kyc-queue NEW page + 3-path KYC review |
| 14-06 | 2 | 2 | /admin/models freeze/depublish + gateway status middleware |
| 14-07 | 4 | 3 | manual SSH migration + GH workflow deploy + curl smoke |

**Plan-checker passed after 1 revision.** 6 blockers + 9 warnings closed:
- B-2 hard FK author_consent_id → consent_records (ON DELETE SET NULL)
- B-3 frozen accrual cutoff in SQL hook (NO middleware cache — fresh per-request DB lookup)
- B-5 db.transaction() wraps payout approve+reject (3 mutations atomic)
- B-6 FIFO uses SUM(net_rub), EXCLUSIVE boundary policy (leftover rolls forward)
- W-3 concrete ROW_NUMBER + INSERT prize_awards SQL (was pseudocode)
- W-5/W-6 email_jobs table + models.tags column added to migration 0014
- W-9 gateway middleware wired with exact `packages/api-gateway/src/server.ts` line numbers (after piiFilter, line 72)

## Scope deltas applied today
- **REQ-CONTEST-004 dropped** from ROADMAP — placeholder, no work behind it
- **Spec §10.10** (consent_records audit) **moved to Phase 14b** — author writes consent on `/me/contest-wins/[id]/publish`, not admin
- **Phase 15: Telegram Stars dropped** entirely — only TON Connect (user decision; 32% mobile fee + 21d hold killed economics)
- **Phase 16 self-host facilitator promoted from 16.3 → 16.1** (EU-20 sanctions blocking Coinbase Europe for РФ entities)
- **Phase 17 Hermes v0.10 → v0.12** (Tenacity Release with durable Kanban + Checkpoints v2)
- **MCP OAuth 2.1 + Resource Indicators (RFC 8707)** required day-1 in Phase 17

## Research artifacts (in master, `docs/research/`)
- `2026-05-08-tech-stack-audit.md` — full stack review, 20-row Action Items table
- `2026-05-08-x402-actuality.md` — protocol v2 status, 7 spec deltas, 1500 words
- `2026-05-08-competitors-revshare.md` — Replicate/HF/OpenRouter/Civitai/fal payout flows

## Out of scope (Phase 14b — DEFERRED)
Author-side: `/me/contest-wins/[id]/publish` (consent screen), `/me/kyc` (3-path upload form), `/me/earnings/payout` (request), `/dashboard/earnings` extended view, real bank transfer (СБП API), ФНС API, tax act PDF generator, libsodium encryption for `users.bank_details`.

## Open spikes (gates before respective phases)
- **Phase 15:** TON Connect 2.4.4 + Next 16 + React 19 hydration test (issue #290) — ~2 hours, MUST DO before exec Phase 15
- **Phase 17:** Mastra vs Hermes-as-product architectural decision; Vercel AI SDK 6 as layer-over-providers (~4h)
- **Phase 16:** legal экспертиза AIAG facilitator status (161-ФЗ/259-ФЗ) before 16.1 ship

## User preferences (persistent)
- **AIAG no local runtime** — never `npm run dev` / `vitest run` / Docker locally; only tsc --noEmit; everything else via push → `gh workflow run deploy-production.yml` → smoke against https://ai-aggregator.ru
- **Migrations:** SSH-tunnel + psql directly to VPS Postgres (NOT drizzle-kit push)
- **Phase 15:** no Telegram Stars; TON Connect only

## Resume command (next session)
```
/gsd:resume-work
/gsd:execute-phase 14
```

Wave 3 (14-07) requires manual SSH-tunnel checkpoint for migration apply. Plan provides exact command.

## Tech stack audit conclusions (May 2026)
- Hono CVE: closed today (PR #1)
- Hermes v0.10 → v0.12: spec updated
- NextAuth → Better Auth: eventual migration (Lucia deprecated March 2025)
- PG 16 → 17 LTS: planned (NOT 18, drizzle-kit push broken on 18)
- Drizzle declarative partitioning: still unsupported (issue #2854 since Aug 2024) — keep raw SQL
- Bun 1.3 production-ready for gateway
- shadcn dominant in 2026
- k3s correct for self-host РФ but multi-tenant needs 4GB+ RAM

## x402 protocol status (May 2026)
- v2 launched 11 Dec 2025, non-breaking
- 69k active agents, 165M tx, $50M cumulative volume
- Repo moved coinbase/x402 → x402-foundation/x402
- TON NOT supported by ANY facilitator — Phase 16.3 is greenfield
- EU-20 sanctions (April 2026) → self-host MANDATORY, not optional
- Stripe MPP main competitor (OpenAI uses MPP, not x402) — kept as Phase 16.5 candidate
