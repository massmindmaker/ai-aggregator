# AI Aggregator architecture

## Runtime services

- `apps/web`: Next.js application on port 3000.
- `packages/api-gateway`: Hono OpenAI-compatible gateway on port 4000.
- `apps/worker`: BullMQ background jobs for catalog sync, upstream polling, email and webhook retry.
- `packages/database`: ordered schema and migration history.
- `packages/shared`, `packages/email`, `packages/telegram-alerts`, `packages/tinkoff`, `packages/yookassa`, `packages/upstream-adapters`: shared runtime packages.

The root workspace deliberately lists only `apps/web`, `apps/worker` and `packages/*`.

## Request and billing flow

The web app authenticates a customer and manages organizations, keys and payments. A gateway request resolves the organization key, checks limits and credits, calls the selected upstream and records usage. Successful payment settlement grants organization credits. Tinkoff has focused bridge coverage; provider-neutral settlement and symmetric refund reversal are tracked follow-up work.

## Data history

Migrations remain ordered and append-only. Historical TMA/Agents Market migrations are retained because deleting an applied migration would make schema history unreproducible. They are marked as cross-product legacy ownership and new Agents Market schema changes belong in `/home/bob/Projects/agents-market`.

Aggregator-native catalog, polling, email and webhook jobs remain in `apps/worker`; the historical contest worker modules that used to sit beside them were removed on 2026-09-30 (see the next section).

## Contest contour removed (2026-09-30)

The contest contour no longer exists in this repository. Contest creation, enrollment,
submissions, evaluation, leaderboard and prize payouts belong to
`/home/bob/Projects/aiarena`; see `docs/consolidation/arena-boundary.md` and
`docs/ecosystem/2026-09-30-contest-removal-boundary.md`.

Removed: the `contest-eval` queue, `close-contests-cron.ts`, the `eval-runner/**` modules,
the `api/contests/**` and `api/admin/contests/**` routes, the `contests`, `evaluations`,
`prize_awards` and `contest_submissions` Drizzle tables, the contest UI surfaces, the
`participant` dashboard mode, and the optional `contestSubmissionId` field of
`ArtifactManifest`. `apps/web/next.config.mjs` permanently redirects `/contests*` to
`/marketplace`, `/admin/contests*` to `/admin`, `/contest-host-agreement` to
`/author-agreement`, `/dashboard/submissions` and `/dashboard/wins` to `/dashboard`, and
`/admin/moderation/submissions` to `/admin/moderation/models`.

Retained deliberately: the author economy — `author_earnings`, `payouts`,
`author_tier_history`, `finalize-earnings-cron.ts`, admin payout routes, the KYC gate and
the model catalog. Author accrual is driven by paid gateway usage, not by contests.

The publishing half of the retired contest route survives as the contest-independent
admin route `POST /api/admin/models/from-submission`, which inserts a `models` row for a
given author with `derived_from_contest_id` set to NULL.

The contest database tables remain in place and are now dead. Dropping them is not safe
yet: migration `0014_contest_marketplace.sql` added
`models.derived_from_contest_id uuid REFERENCES contests(id)`, so `DROP TABLE contests`
would touch the model catalog. Rollback point is the git tag `pre-contest-removal`.

## Local verification

Vitest runs Node services in `node` and web tests in `jsdom`. Recursive exclusions keep `node_modules`, `dist`, `.next` and fixture vendors out of discovery. Local integration commands use `/tmp/ai-ecosystem-run aggregator` and the shared heavy-run flock; these URLs point to disposable empty PostgreSQL/Redis instances.
