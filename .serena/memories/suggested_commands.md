# Development Commands (AIAG — bare-metal VPS, corrected 2026-05-31)

> NOTE: replaces a stale version that said Vercel / Neon / `npx vercel --prod`.
> AIAG is NOT on Vercel and NOT on Neon. See `mem:project_overview`, `mem:aiag_state_2026_05_30`.

## Stack reality
- Monorepo: Turborepo + **Bun** workspaces. Lockfile = `bun.lock` (regenerate with `bun install`; CI uses `--frozen-lockfile`).
- DB: **Timeweb managed PostgreSQL 16** on the VPS (NOT Neon). Migrations = raw SQL in `packages/database/migrations/`, applied **MANUALLY via SSH tunnel** to VPS Postgres (NOT `drizzle-kit push`, NOT by the deploy).
- Hosting: **bare-metal Timeweb VPS** `root@5.129.200.99` (SSH alias `aiag-vps`, key `~/.ssh/timeweb_vps`), pm2 + nginx + certbot. NOT Vercel.
- ⚠️ **SSH under the VPN**: plain `ssh aiag-vps` FAILS ("banner exchange timeout" on :22 — the always-on VPN MITMs direct SSH). Tunnel through the VPN HTTP proxy instead:
  `ssh -o ProxyCommand="connect -H 127.0.0.1:10809 %h %p" aiag-vps "<cmd>"`  (the `connect` binary is at /mingw64/bin/connect; proxy = VPN's HTTP_PROXY 127.0.0.1:10809). This is how to reach the VPS for pm2/migrations WITHOUT disabling the VPN.

## Build / checks (NO local dev server — see no-local-runtime rule)
- `bun install`                      # deps
- `bun run build`                    # build all (or per-app: `bun run --cwd apps/web build`)
- `tsc --noEmit`                     # type-check (per app/package)

## Deploy (canonical)
- `gh workflow run deploy-production.yml --ref master`            # default apps = web,gateway,worker
  - GitHub Actions: build on runner → SSH to VPS → release dir + atomic symlink `current` → `pm2 reload`.
  - Watch: `gh run watch <id> --exit-status`
- Local alternative: `ops/scripts/deploy.sh [apps...]`           # SSH via `aiag-vps`, builds locally + scp + remote swap
- Last fully-green deploy: 2026-05-09 (run 25612067634).

## Migrations (MANUAL — separate from deploy)
- Deploy does NOT run migrations (Insight_MigrationDeployGap). Apply via SSH tunnel to VPS Postgres after deploy.

## pm2 (VPS)
- Processes: web (3000), gateway (4000), worker; tg-miniapp (3100). One VPS, many pm2 procs, one DB.
- If `pm2 reload <app>` says "Process not found" → process is stale: `pm2 restart <app>` or `pm2 start /srv/aiag/shared/ecosystem.config.cjs --only <app>`, then `pm2 save`.

## HARD RULE
- No local runtime (no `npm/bun run dev`, no `vitest`, no Docker). Verify on `ai-aggregator.ru` after deploy.
