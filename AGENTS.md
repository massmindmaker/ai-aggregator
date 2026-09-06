# AI Aggregator workspace contract

This repository is the canonical working root for **AI Aggregator**. Current topology is governed by `docs/consolidation/ACTIVE-PROJECTS.md`.

## Active product boundary

- `apps/web`: AI Aggregator website, dashboard and admin surfaces.
- `packages/api-gateway`: OpenAI-compatible API gateway and organization billing.
- `apps/worker`: Aggregator catalog, polling, email and webhook jobs.
- `packages/*`: Aggregator database and shared service packages.

Agents Market lives at `/home/bob/Projects/agents-market` with independent `apps/web`, `apps/tma` and `apps/worker`. AI Arena lives at `/home/bob/Projects/aiarena`. Do not add either product's active application code back here.

Some contest evaluation files remain in `apps/worker` and historical contest/TMA migrations remain in `packages/database/migrations`. They are preserved for ordered migration history and an audited Arena transfer; their presence does not make this repository the canonical Arena or Agents Market root.

## Required engineering rules

- SQL uses prepared statements.
- Authentication reads `getAuthenticatedUser()` and then `authUser.user.id`.
- Concurrent money changes use a guarded `UPDATE ... WHERE ... RETURNING` inside the required transaction.
- Pro status is derived from payments; do not read `user.isPro`.
- Prices come from `apps/web/src/lib/pricing.ts` or the gateway billing contract; do not hardcode them.
- Kie generation lives in `apps/web/src/lib/kie-generation.ts`.
- Do not run production deployments, production migrations or production-data tests without explicit authorization.

## Local verification

Use Bun 1.4.2 and the committed `bun.lock`. The root unit suite uses Node by default and jsdom only for `apps/web` tests. Generated and vendored trees must never be collected.

Heavy build/test commands run one at a time under `flock /tmp/ai-ecosystem-build.lock`. The isolated helper `/tmp/ai-ecosystem-run aggregator ...` supplies disposable local PostgreSQL and Redis URLs; never copy a production `.env` into this checkout.

Historical monorepo rules are available at commit `a77ef0d^` and are summarized in `docs/archive/legacy-suite-context.md`; they are not current instructions.
