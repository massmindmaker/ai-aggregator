---
phase: 14-contest-marketplace-admin
plan: 02
subsystem: worker/crons
tags: [phase14, cron, worker, contests, earnings, bullmq]
requires:
  - migration 0014 (prize_awards table, author_earnings.available_at, contest_submissions.final_rank)
  - apps/worker bootstrap (Phase 1)
provides:
  - hourly closeContestsCron — finalizes contests, writes prize_awards
  - daily finalizeEarningsCron — promotes accruing→locked after 30d buffer
affects:
  - apps/worker/src/index.ts (queues + workers[] graceful-shutdown array)
  - downstream plan 14-04 (admin payouts UI reads status='locked')
tech-stack:
  added: []
  patterns:
    - Pure runOnce(db, sql) function, BullMQ wrapper imports it
    - Lazy @aiag/database import pattern (matches internalProbe.pingPg)
    - jsonb_to_recordset() for prize-array expansion
    - Per-contest tx isolation — one bad contest does not block siblings
key-files:
  created:
    - apps/worker/src/queues/close-contests-cron.ts
    - apps/worker/src/queues/finalize-earnings-cron.ts
    - apps/worker/src/__tests__/close-contests-cron.test.ts
    - apps/worker/src/__tests__/finalize-earnings-cron.test.ts
  modified:
    - apps/worker/src/index.ts
decisions:
  - "Schema mapping: spec §5 'pending→available' implemented as 'accruing→locked' per migration 0014's three-state author_earnings.status enum"
  - "ROW_NUMBER tie-break by created_at ASC (deterministic for equal private_score)"
  - "INSERT prize_awards uses jsonb_to_recordset to expand contests.prizes array (Array<{place,amount}>) and JOINs against final_rank=place"
  - "ON CONFLICT (contest_id, submission_id, rank) DO NOTHING for idempotency on cron re-runs"
  - "Per-contest db.transaction (not global) — one failed contest does not abort the batch"
  - "Repeatable jobId='tick' on both queues for BullMQ restart-dedup"
  - "Lazy @aiag/database import inside runOnce closure → worker still boots without DATABASE_URL"
metrics:
  duration: ~25 min
  completed_date: 2026-05-08
  tasks: 2
  commits: 4
  files_created: 4
  files_modified: 1
---

# Phase 14 Plan 02: Crons (closeContests + finalizeEarnings) Summary

Two scheduled BullMQ jobs running inside the existing apps/worker process: `closeContestsCron` (hourly) finalizes contests and writes `prize_awards`; `finalizeEarningsCron` (daily) promotes `author_earnings` rows from `accruing` to `locked` once their 30-day `available_at` window elapses.

## Commits

| Commit | Type | Description |
| --- | --- | --- |
| 029abeb | test | RED — failing tests for closeContestsCron (7 cases) |
| 860cd93 | feat | GREEN — closeContestsCron implementation (Phase 14 §2 Step 1) |
| 5e2953f | test | RED — failing tests for finalizeEarningsCron (6 cases) |
| 4ba53aa | feat | GREEN — finalizeEarningsCron + worker/index.ts wiring |

## Behavior

**closeContestsCron** (`0 * * * *`):
1. `SELECT id, prizes FROM contests WHERE ends_at < NOW() AND status <> 'closed'`.
2. For each due contest, in a per-contest tx:
   - `UPDATE contest_submissions SET final_rank = ROW_NUMBER() OVER (PARTITION BY contest_id ORDER BY private_score DESC NULLS LAST, created_at ASC)`.
   - `INSERT INTO prize_awards SELECT … FROM contest_submissions cs JOIN jsonb_to_recordset(prizes) p(place int, amount numeric) ON p.place = cs.final_rank … ON CONFLICT (contest_id, submission_id, rank) DO NOTHING`.
   - `UPDATE contests SET status='closed' WHERE id=$1`.
3. Per-contest exceptions are caught + logged; siblings still process.

**finalizeEarningsCron** (`0 4 * * *`):
1. Single `UPDATE author_earnings SET status='locked' WHERE status='accruing' AND available_at IS NOT NULL AND available_at < NOW()`.
2. Returns `{rowsTransitioned}` for log line.
3. Idempotent by definition — already-locked or in-buffer rows excluded by WHERE.

## Verification

- File existence: 4/4 created files present, index.ts modified.
- SQL grep counts: `final_rank` ×7, `INSERT INTO prize_awards` ×1, `ON CONFLICT` ×3, `ROW_NUMBER` ×2 inside close-contests-cron.ts; `status = 'locked'` ×1 in finalize-earnings-cron.ts; `startCloseContestsCron`/`startFinalizeEarningsCron` ×4 references inside index.ts.
- TDD gate sequence: RED commit (029abeb) → GREEN commit (860cd93) → RED commit (5e2953f) → GREEN commit (4ba53aa). All four present in `git log --oneline -6`.

## Deviations from Plan

**1. [Rule 3 — Blocking issue] tsc --noEmit cannot run locally**
- **Issue:** `npx tsc --noEmit -p apps/worker/tsconfig.json` crashes with "Zone Allocation failed - process out of memory" regardless of `--max-old-space-size`. Reproduced on clean master (pre-our-changes via `git stash -u`) — pre-existing repo issue, not caused by this plan.
- **Fix:** Skipped tsc gate per project rule "no local runtime testing — only write code + tests; verification on VPS after deploy" (CLAUDE.md). The `apps/worker/tsconfig.json` `exclude: ["src/**/__tests__/**"]` keeps test files out of the build anyway.
- **Mitigation:** Both source modules use narrowed `CronDb` / `SqlTag` interfaces with explicit casts at the call site in `index.ts` (`as unknown as Parameters<typeof runCloseContestsOnce>[0]`) — type-shape compatibility with drizzle's `NodePgDatabase` is decoupled from the cron's pure interface.
- **Verification deferred to:** plan 14-07 deploy pipeline + VPS smoke (CI runs full tsc with more headroom).

**2. [Plan deviation] SQL shape: `prizes` array, not `prize_distribution` percentage map**
- **Issue:** Plan task 1 noted ambiguity between `prizes` (array of `{place, amount}`) and `prize_distribution` (percentage map keyed by rank-as-string). Real schema (`packages/database/src/schema/contests.ts:52-58`) uses the array shape.
- **Fix:** Implemented the array branch — `jsonb_to_recordset(prizes) AS p(place int, amount numeric) ON p.place = cs.final_rank`. INSERT shape (columns + ON CONFLICT) is identical to plan, only the JOIN expression differs.
- **No schema migration needed** — used the existing column.

## Test Coverage

Pure runOnce functions are unit-tested with stub `db` and a fake `sql` tag-template that just records strings.

- **closeContestsCron** — 7 tests: due-contest discovery, ROW_NUMBER ranking + DESC ordering, prize_awards INSERT with ON CONFLICT, NULL prizes graceful, no-submissions, status-flip, per-contest tx atomicity (2 contests → 2 transactions).
- **finalizeEarningsCron** — 6 tests: SQL fragment assertions (`status='locked'`, `WHERE status='accruing'`, `available_at < NOW()`, `IS NOT NULL`), paid-row exclusion (negative match), row-count return, missing-rowCount fallback, repeated-run idempotency.

Tests are vitest unit tests under `apps/worker/src/__tests__/`. They run via `pnpm --filter @aiag/worker test` (vitest), not via tsc — the worker's tsconfig explicitly excludes the `__tests__` directory from the build.

## Open Questions / Followups

- **No-op without DATABASE_URL** is silent — both `runOnce` closures return `{0,0}` / `{0}` and log the tick. If this is undesirable on production (would mask config errors), add a `logger.warn` when DATABASE_URL is missing AND we are in production. Deferred — not in plan scope.
- **`current_tier_pct` signature drift:** plan 14-02 spec mentions `current_tier_pct(rank, total)`, but migration 0014 defines `current_tier_pct(_user_id uuid)`. Already used by aiag_settle_charge — not relevant to these crons but worth flagging for plan 14-04 (admin payouts) which may rely on the spec wording.
- **Forfeit logic** (kyc-incomplete prize_awards → status='forfeited') is NOT implemented here — scoped to a later plan per the spec; the current cron writes status='pending' and downstream code handles forfeit.

## Self-Check: PASSED

Files verified to exist:
- FOUND: apps/worker/src/queues/close-contests-cron.ts
- FOUND: apps/worker/src/queues/finalize-earnings-cron.ts
- FOUND: apps/worker/src/__tests__/close-contests-cron.test.ts
- FOUND: apps/worker/src/__tests__/finalize-earnings-cron.test.ts
- MODIFIED: apps/worker/src/index.ts (imports + wiring + workers[] entry)

Commits verified in `git log`:
- FOUND: 029abeb test(14-02): add failing tests for closeContestsCron
- FOUND: 860cd93 feat(14-02): implement closeContestsCron
- FOUND: 5e2953f test(14-02): add failing tests for finalizeEarningsCron
- FOUND: 4ba53aa feat(14-02): implement finalizeEarningsCron + wire crons

TDD gate compliance: RED→GREEN pairs present for both tasks (test commit precedes feat commit in git log).
