# AI Aggregator workspace contract

This repository is the canonical working root for **AI Aggregator**. Current topology is governed by `docs/consolidation/ACTIVE-PROJECTS.md`.

## Active product boundary

- `apps/web`: AI Aggregator website, dashboard and admin surfaces.
- `packages/api-gateway`: OpenAI-compatible API gateway and organization billing.
- `apps/worker`: Aggregator catalog, polling, email and webhook jobs.
- `packages/*`: Aggregator database and shared service packages.

Agents Market lives at `/home/bob/Projects/agents-market` with independent `apps/web`, `apps/tma` and `apps/worker`. AI Arena lives at `/home/bob/Projects/aiarena`. Do not add either product's active application code back here.

The contest contour was removed from this repository on 2026-09-30; contests, evaluation, leaderboard and prizes are owned by `/home/bob/Projects/aiarena`. Do not reintroduce them. Historical contest migrations remain in `packages/database/migrations` and the contest tables remain in the database as dead tables, because `0014_contest_marketplace.sql` created the FK `models.derived_from_contest_id -> contests(id)`; that history does not make this repository the canonical Arena root. What stays here is the author economy — `author_earnings`, `author_credit_ledger`, payouts, the KYC gate and `finalize-earnings-cron.ts` — plus the model catalog. See `docs/ecosystem/2026-09-30-contest-removal-boundary.md`.

## Required engineering rules

- SQL uses prepared statements.
- Authentication reads `getAuthenticatedUser()` and then `authUser.user.id`.
- Concurrent money changes use a guarded `UPDATE ... WHERE ... RETURNING` inside the required transaction.
- Pro status is derived from payments; do not read `user.isPro`.
- Prices come from `apps/web/src/lib/marketplace/pricing-calc.ts` (there is **no**
  `apps/web/src/lib/pricing.ts`) or the gateway billing contract; do not hardcode them. The
  storefront's sold-capability source of truth is `apps/web/src/lib/marketplace/sold-contract.ts`.
- Kie generation lives in `apps/web/src/lib/kie-generation.ts`.
- Do not run production deployments, production migrations or production-data tests without explicit authorization.

## Local verification

Use Bun 1.4.2 and the committed `bun.lock`. The root unit suite uses Node by default and jsdom only for `apps/web` tests. Generated and vendored trees must never be collected.

Heavy build/test commands run one at a time under `flock /tmp/ai-ecosystem-build.lock`. The isolated helper `/tmp/ai-ecosystem-run aggregator ...` supplies disposable local PostgreSQL and Redis URLs; never copy a production `.env` into this checkout.

Historical monorepo rules are available at commit `a77ef0d^` and are summarized in `docs/archive/legacy-suite-context.md`; they are not current instructions.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
