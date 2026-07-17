# ARCHITECTURE.md — AIAG

System map. Product reality lives in `/CLAUDE.md`; this is the technical topology.

## Two products
- **Web aggregator** (`apps/web` + `packages/api-gateway`) — RU market, rubles. RF entity.
- **TMA** (`apps/tg-miniapp` + `apps/agent-worker`) — Telegram agents marketplace, crypto credits. Foreign entity.
- Separated by currency + entity + audience; they only share Postgres + the gateway as a model provider.
- **Founder decision 2026-07-17: this is a client relationship, not co-tenancy.** The
  aggregator is a **provider** of models (RF entity); TMA is its **client**, billed at
  the same transfer rate as any other client (no per-org markup). As of 2026-07-17 TMA
  has its **own gateway org, API key, and wallet** (migration `0060_tma_own_org.sql`;
  wallet starts at **0** — every TMA run 402s honestly until manually funded) and the
  two silent direct-OpenRouter fallbacks in `agent-worker/src/agent-runner.ts` are
  closed (402/401/403/empty-key now fail loud instead of leaking margin + breaking
  white-label). **Still shared:** one physical Postgres `aiag` (DB split parked), TMA
  still reads `models`/`model_upstreams` by raw SQL (catalog-via-`/v1/models` parked),
  2 hard cross-contour FKs (`agents.provider_id`, `agent_provider_credentials.provider_id`
  → `providers`) not yet broken. Plan: `docs/superpowers/plans/2026-07-17-split-web-tma.md`.

## Service map (pm2 on a single 2GB Timeweb VPS)
- `web` — Next 14.x (rubles aggregator)
- `gateway` — Hono/Bun, `:4000`, OpenAI-compatible, white-label, model registry + markup
- `tma` — Next 14.2.33, `:3100`, basePath `/tg`, health `/tg/health`
- `agent-worker` — BullMQ runner, `:3101` (the money path)
- `worker` — background jobs
- nginx fronts all; strips `x-middleware-subrequest`/`x-tma-user-id` on `/tg`

## Request → money flow (TMA)
TMA → `agent-worker` (BullMQ) → resolveUpstream → gateway `:4000` (AIAG model, +markup, debit) OR user's own provider (BYOK = no charge) → upstream. `settleRun` does the atomic debit. See `/SECURITY.md`.

## Money unit — credit ledger (fixed 2026-07-17, tip `d16cc39`)
- Unit = **micro-credits** (BIGINT). 1 credit = 1 US cent = 1000 micro; real USD =
  cents / 100. `model_upstreams.price_per_1k_*` / `price_per_image` store **cents**
  (USD×100), not USD — a prior bug read them as USD and multiplied by the CBR rate,
  producing a **~120x overcharge** (showcase ₽18/1M would have invoiced ₽1656). Fixed
  via migrations `0056`-`0059`/`0061`; anchor regression test pins Sonnet 1k in + 0.5k
  out @ markup 1.8 = 1890 micro (bug gave 189000).
- Formula: `costCredits(micro) = round(upstreamCents × markup × batchDiscount × caching × 1000)`.
  Markup = **1.8** across all 76 model↔upstream bindings (was 1.20/1.25).
- Debit function renamed to `aiag_settle_charge_credits` (migration 0058) — a new name
  as a guard against accidentally calling the old ₽-unit function by its old name.
- FX (CBR rate) is **not in the runtime hot path anymore** — `fetchUsdRubRate` no
  longer ships in `dist`; the only remaining FX use is a one-time fixed-rate (90)
  conversion baked into migration 0061 for the key spend-cap column.
- Known unfixed leaks: `/v1/embeddings` returns `Math.sin()`-based fake 8-dim vectors
  and still charges (`docs/specs/2026-07-17-audit-round3-findings.md` P0 #5);
  `/v1/audio/speech` is **intentionally 503** (fail-closed) — TTS never worked (no
  `case 'hf'` in `registry.ts` for `elevenlabs-tts-hf`; `-kie` had no input-length cap).

## Data stores
- Postgres 16.14 `aiag` — **self-hosted on the same VPS as everything else** (NOT Timeweb
  managed Postgres; earlier drafts of this doc said "managed" — that was wrong). Single
  source of truth. `tg_user_balances` (TMA spendable; ₽→USD-credit migration done, D-1),
  gateway org-balances, `agent_*`, `agent_templates` (public spec, 0 secret columns),
  `gateway_transactions`, `agent_provider_credentials`. As of migration `0060` there are
  now **two** gateway orgs of note: the original (web + legacy TMA key, still shared)
  and `agents-market` (TMA's own org/key/wallet — see "Two products" above).
  - `agent_sessions` — hire container (one hirer ↔ one foreign agent); **PROJECT, not built** (canon §3-4).
  - `agent_memory` — KV memory scoped per project-namespace `(agent_id, scope_tg_user_id)`; scope column is **PROJECT, not built** (canon §3-4, §11).
- Redis 7 — BullMQ queues.

### Backups — real, but single point of failure
- `aiag-pg-backup.timer` (systemd) runs `pg_dump` daily at 03:15 UTC into
  `/var/backups/postgres/` — confirmed live, 9 rotated files present.
- 🔴 **`/var/backups/postgres` and `/var/lib/postgresql/16/main` sit on the SAME disk**
  (`/dev/sda1`, 29G, 57% used). A disk failure, `rm -rf`, or full-disk event takes out
  the live DB **and every local backup at once** — the backup buys recovery from bad
  SQL/human error, not from disk/instance loss.
- Off-box copy (S3 upload) is a **commented-out TODO** in the backup script — not running.
- `archive_mode=off`, 0 replication slots → **no WAL archiving, no PITR**. Recovery
  granularity = "whichever of the 9 daily dumps you have," not "any point in time."
- Practical read: this is fine for accidental-DELETE recovery, not fine as disaster
  recovery. Shipping an off-box backup destination is the open gap, not a documentation
  fix — flagged here so nobody assumes PITR/offsite exists because a timer is green.

## Deploy topology
- GitHub Actions SSH rsync (Capistrano-style releases) for web/gateway; **tma + agent-worker built manually on VPS** (root-owned dirs, no workflow build step). Migrations applied **manually, no tracking** (`sudo -u postgres psql aiag` for ALTER). Single source of truth for releasing: skill `aiag-deploy`.

## Hermes-proxy layer (PROJECT — control-plane to Hermes REST API)
Course set on the real Hermes runtime (canon §5): our UI = a control-plane that remote-drives a Hermes agent via its REST API (`localhost:8642`: `POST /api/model/set`, `/api/jobs`, `/api/sessions`, `X-Hermes-Session-Token`). Profile provisioning has NO REST → we script it (`mkdir ~/.hermes/profiles/<agent>_<hirer>` + cp config + patch `base_url`=our `:4000`). True multitenancy = Docker-per-tenant. Needs a Phase-0 spike on a separate 4-8GB VPS (the 2GB box can't host it — infra-blocked). See canon §5, §12.

## NOT built (don't design as if it exists)
Managed Hermes provisioning + config dashboard, tool broker / x402, skills hub — all R&D. `agent_sessions` hire + per-hirer memory-namespace = PROJECT (canon §3-4). Live agent runtime = stateless BullMQ→OpenRouter loop in `apps/agent-worker/src/agent-runner.ts`. (MCP servers + OAuth are **LIVE** now — not in this list.) See the reality table in `/CLAUDE.md` and the truth table in canon §8.
