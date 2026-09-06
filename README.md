# AI Aggregator

Canonical repository for the AI Aggregator web application and OpenAI-compatible API gateway.

## Workspace

- `apps/web` — Next.js customer/admin application.
- `packages/api-gateway` — organization-authenticated model gateway.
- `apps/worker` — Aggregator background jobs; historical contest jobs are temporarily retained pending Arena transfer.
- `packages/*` — database, billing providers and shared libraries.

Agents Market is developed in `/home/bob/Projects/agents-market`. AI Arena is developed in `/home/bob/Projects/aiarena`.

## Development

Use Bun 1.4.2:

```bash
bun install --frozen-lockfile
bun run test:config
bun run test:unit
bun run type-check
bun run build
```

Run heavy commands under `flock /tmp/ai-ecosystem-build.lock`. For isolated local PostgreSQL and Redis values use `/tmp/ai-ecosystem-run aggregator <command>`.

Current product boundaries and extraction status are recorded in `docs/consolidation/ACTIVE-PROJECTS.md`.
