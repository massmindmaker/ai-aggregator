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

`apps/worker` retains contest evaluation and contest-closing modules pending an audited transfer to `/home/bob/Projects/aiarena`. Aggregator-native catalog, polling, email and webhook jobs remain here.

## Local verification

Vitest runs Node services in `node` and web tests in `jsdom`. Recursive exclusions keep `node_modules`, `dist`, `.next` and fixture vendors out of discovery. Local integration commands use `/tmp/ai-ecosystem-run aggregator` and the shared heavy-run flock; these URLs point to disposable empty PostgreSQL/Redis instances.
