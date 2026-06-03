# Task Completion Checklist (AIAG — corrected 2026-05-31)

> NOTE: replaces a stale version that told you to `npm run dev` / "test in dev mode".
> That violates the project's HARD RULE: **no local runtime** — verification happens on the VPS.

## Before completing any code task
1. **Type-check**: `tsc --noEmit` (per touched app/package).
2. **Build sanity**: `bun run build` for the affected app (do NOT start a dev server).
3. Do NOT run `npm/bun run dev`, `vitest`, Playwright, or Docker locally (no-local-runtime rule).

## Database / migration changes
- Write a new raw-SQL migration in `packages/database/migrations/` (next free number, idempotent, house-style `DROP ... IF EXISTS` / `DO $$ ... EXCEPTION`).
- Migrations are applied **MANUALLY via SSH tunnel** to VPS Postgres (NOT by the deploy, NOT `drizzle-kit push`).

## Before committing
- Review changed files; ensure no secrets/credentials committed.
- Descriptive commit message. Commit/push only when the user asks (branch first if on master / use worktrees).

## To verify a change actually works
- Deploy: `gh workflow run deploy-production.yml --ref master` → watch `gh run watch <id>`.
- Apply any new migrations via SSH tunnel.
- Verify behavior on `ai-aggregator.ru` (this is the only real verification — no local runtime).

See `mem:suggested_commands`, `mem:aiag_strategy_synthesis_2026_05_30`.
