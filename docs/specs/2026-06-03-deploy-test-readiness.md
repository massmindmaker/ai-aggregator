# Deploy & Test Readiness — Wave-0 (D-0 margin / D-7 safeFetch / D-8 initData / DEFAULT_MODEL)

**Date:** 2026-06-03
**Scope:** Can the 2GB prod VPS absorb the Wave-0 branch stack? What does a pre-prod TEST environment look like? How to provision the isolated ~18GB managed-Hermes test box?
**Verdict (TL;DR):** **GO to deploy Wave-0** — code-only, no new migrations, no new heavy services, no resident processes. The only real risk is the **tma `next build` OOM on the 2GB box** (a known, mitigable build-time issue, not a runtime one). Validate on a disposable test DB first (R0 pattern), then deploy gateway+worker via CI, build tma/agent-worker manually on the VPS with a swap guard.

---

## 1. What is actually in the Wave-0 stack (verified in code)

The three branches form a **clean linear stack** (each is an ancestor of the next):

```
plan/15.1-r0-billing-identity (base, = R0, live on prod but not merged to master)
  └─ feat/wave0-safefetch-defaultmodel   44d0fcb, 53ea794   (2 commits)
       └─ feat/wave0-d0-margin           42f83d5, f500d9d, ab2cbc9   (3 commits)
            └─ feat/wave0-d8-initdata    abc4f84   (1 commit)   ← cumulative tip = all 6
```

Merging `feat/wave0-d8-initdata` brings **all of Wave-0**. Cumulative diff vs base (16 files, +1036/-41):

| File | Stream | What it does | Runtime cost |
|---|---|---|---|
| `packages/shared/src/safe-fetch.ts` (new, 325 L) | safefetch | SSRF guard: DNS-resolve + IP-validate + socket-pin + per-redirect re-check | +1 DNS lookup per outbound call (ms, ~0 RAM) |
| `apps/agent-worker/src/safe-fetch.ts` (new, 269 L) | safefetch | worker-local copy of same guard | same |
| `packages/api-gateway/src/proxy.ts` | safefetch | route gateway proxy through safeFetch (allowlist `127.0.0.1:4000`, `openrouter.ai`) | none |
| `packages/api-gateway/src/upstreams/openrouter.ts` | safefetch | OpenRouter adapter via safeFetch | none |
| `apps/agent-worker/src/agent-runner.ts` (+207 L) | safefetch+d0 | `DEFAULT_MODEL` → `openai/gpt-4o-mini` (registered slug, kills the 400 "Unknown model"); 400-fallback; bill off gateway authoritative headers; `finalBillableCostRub` MIN floor | none (pure logic) |
| `packages/api-gateway/src/lib/billing-headers.ts` (new, 27 L) | d0 | `X-AIAG-Charged-Rub` / `X-AIAG-Upstream-Cost-Rub` header contract | none |
| `packages/api-gateway/src/routes/v1/chat.ts` | d0 | emit billing headers (non-stream path) | none |
| `packages/api-gateway/src/streaming/sse.ts` | d0 | emit billing headers (stream path) | none |
| `apps/tg-miniapp/src/lib/verify-init-data.ts` | d8 | `timingSafeEqual` + 600s max-age (was 24h) + surface verified `hash` | none |
| `apps/tg-miniapp/app/api/tma/auth/verify/route.ts` | d8 | one-shot Redis replay nonce (`SET NX EX`, fail-open) | 1 short-lived ioredis conn per **login** (rare) |
| `packages/{shared,api-gateway}/package.json`, `bun.lock` | all | internal workspace link `@aiag/shared`, dev-only `@types/node` | **no new runtime deps** |
| `apps/agent-worker/src/__tests__/*` | d0 | updated unit tests | n/a |

**Negative results (the important ones for go/no-go):**
- **No `.sql` / migration files** in the entire stack → **no DB schema change to apply**. (0019/0026 already on prod.)
- **No new npm runtime dependency** — only an internal `@aiag/shared` workspace link + a dev-only `@types/node`.
- **No new pm2 process, no resident orchestrator, no in-memory cache.** safeFetch is stateless; the only stateful add is a Redis `SET NX` per login (uses the existing Redis 7).
- **The worker does NOT stream the billed call** (`callWithFallback` is non-streaming JSON). So the R1.2 "do not stream the billed call → settles at ₽0" risk **does not apply to Wave-0**. The SSE path emits headers but is only used by the web gateway clients, and it settles after token accounting (unchanged behavior).

---

## 2. RAM / build / OOM assessment on the 2GB prod VPS

### 2.1 Runtime RAM — NEGLIGIBLE delta (safe)
Wave-0 adds **zero** resident memory: no new process, no cache, no pool. safeFetch allocates a per-request undici Agent that is GC'd after the call. The login replay-nonce opens and `quit()`s an ioredis connection per login (low frequency). Net steady-state RAM delta ≈ **0**. The live money path keeps its current footprint (web ~92MB + gateway ~26MB + agent-worker + worker + tma + PG + Redis + nginx).

### 2.2 Build RAM — THE risk, and it is build-time only
- **web + gateway are built in GitHub Actions (ubuntu-24.04 runner), NOT on the VPS** (`deploy-production.yml`). Their builds never touch the 2GB box → **no OOM risk for the gateway changes**.
- **tma + agent-worker are built MANUALLY on the VPS** (`/srv/aiag/web-repo`), per ARCHITECTURE.md ("tma + agent-worker built manually on VPS"). `next build` for tma is the **documented ~2GB OOM hazard** (memory: aiag_r0_and_108_eval). agent-worker is a Bun/tsup build — light, no OOM.
- Wave-0 touches tma (`verify-init-data.ts`, `auth/verify/route.ts`) → **a tma rebuild is required**, so the OOM hazard is in play for this deploy.

**OOM mitigations (apply before the on-VPS tma build):**
1. **Add/confirm swap** (the cheapest fix): `swapon --show`; if absent, `fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile` (+ `/etc/fstab` line).
2. **Cap Node heap + build serially**: `NODE_OPTIONS="--max-old-space-size=1536" next build`, and **stop the heaviest co-resident process during the build** (`pm2 stop web` for ~2 min, build tma, `pm2 start web`).
3. **Best option: build tma in CI too.** The workflow already has a `tma` build step (`bun run --cwd apps/tg-miniapp build`) gated on `apps` containing `tma` — it just isn't wired into the on-VPS swap/symlink for tma. Prefer triggering the workflow with `apps=gateway,tma` so tma's `next build` runs on the CI runner, then rsync the `.next` artifact. This removes the OOM from the prod box entirely. (If the on-VPS symlink for tma isn't set up, fall back to manual build with swap.)
4. **Free RAM ceiling headroom long-term**: the standing recommendation (STATE.md blockers) is **upgrade 2GB→4GB before real traffic**. Not required for Wave-0, but the right call if a tma rebuild fights the live path.

### 2.3 Capacity table

| Box | Role | RAM | What runs | Wave-0 impact | Headroom |
|---|---|---|---|---|---|
| **prod VPS** `5.129.200.99` (Timeweb ru-1, Ubuntu 24.04) | money path | **2 GB** | pm2: web, gateway, tma, agent-worker, worker + PG 16 + Redis 7 + nginx | runtime ≈ +0 MB; **build = tma next-build OOM hazard** | tight; +4G swap or build-in-CI mitigates; 4GB upgrade recommended |
| **test box** (option A: same VPS, disposable schema) | pre-prod validation | reuse 2GB | temp `aiag_test` DB on the same PG + vitest run | none (DB only, dropped after) | fine — test DB is tiny |
| **test box** (option B: throwaway Timeweb VPS) | staging/canary | 2–4 GB | full pm2 stack + own PG/Redis | mirrors prod | clean isolation, ~₽/day cost |
| **managed-Hermes test box** (R1.3 spike) | isolated R&D | **~18 GB** (founder) | 1+ resident `hermes gateway` (~300–600 MB each) + Daytona tool sandboxes | **MUST be a separate VPS** — never co-resident with the money path (RK-1) | sized for multiplexing measurement |

---

## 3. TEST environment — replicate R0 + add a staging/canary option

### 3.1 Pattern A — disposable schema-copied test DB + vitest (the R0 pattern; default)
This is exactly what R0 (15.1-03) already established and is **the cheapest, safest pre-prod gate**:
- A throwaway `aiag_test` DB on the **same Postgres**, schema-copied from prod, used by the integration suite via `TEST_DATABASE_URL`.
- Integration tests are gated `describe.skipIf(!TEST_DATABASE_URL)`; synthetic `tg_user_id` in the reserved `9_000_000_000+` range; `afterEach` cleanup by generated id (never touches real rows).
- A temporary `pg_hba.conf` entry lets the test connect; remove it after.

**One-time setup on the VPS:**
```bash
# 1. Create a disposable test DB, schema-copied from prod (NO data).
sudo -u postgres createdb aiag_test
sudo -u postgres pg_dump --schema-only aiag | sudo -u postgres psql aiag_test
# (or copy specific tables: tg_users, tg_user_balances, agents, agent_provider_credentials, gateway_transactions, gateway_api_keys)

# 2. Temp pg_hba: allow local md5 for the test DB (revert after).
#   In /etc/postgresql/16/main/pg_hba.conf add ABOVE the catch-all:
#     local   aiag_test   aiag   md5
sudo systemctl reload postgresql

# 3. Run the integration suite against the test DB only.
cd /srv/aiag/web-repo
DATABASE_URL="postgres://aiag:***@127.0.0.1:5432/aiag_test" \
TEST_DATABASE_URL="postgres://aiag:***@127.0.0.1:5432/aiag_test" \
  bun run --cwd apps/agent-worker vitest run

# 4. Teardown.
sudo -u postgres dropdb aiag_test    # and revert the pg_hba line + reload
```
This validates `settleRun` atomicity, the D-0 billing math, the run-start gate, and the budget guard **without any prod write**.

### 3.2 Pattern B — staging/canary (heavier, for risky surface changes)
For anything that changes the live HTTP surface (auth flow, nginx, gateway routing) and you want a real browser/Telegram round-trip before prod:
- **Option B1 (cheap canary, same box):** deploy the new release to a parallel pm2 process on a different port (`tma-canary` :3110), proxy a `/tg-canary` nginx location to it, smoke-test, then promote by repointing `/tg` and dropping the canary. Costs a few hundred MB transiently — do it during low traffic.
- **Option B2 (clean staging, throwaway VPS):** spin a 2–4GB Timeweb VPS, rsync the release, point it at `aiag_test` (or its own PG), run the full smoke set, destroy it. Best isolation; small hourly cost. Use this when touching nginx/auth in a way you can't safely canary on the live box.

For **Wave-0**, Pattern A (disposable DB + vitest) is sufficient — the only live-surface change is the tma auth route, which Pattern A + the post-deploy login smoke covers.

---

## 4. STEP-BY-STEP test + deploy runbook (Wave-0)

> Because the branches are a **clean linear stack**, you have two valid merge strategies. **Recommended: merge the cumulative tip once** (simplest, lowest blast radius window). The per-branch sequence is given for traceability if you prefer staged merges.

### 4.0 Pre-flight (local, before any merge)
```bash
git fetch --all
# Confirm the stack is still linear (no drift):
git merge-base --is-ancestor feat/wave0-safefetch-defaultmodel feat/wave0-d0-margin   # exit 0
git merge-base --is-ancestor feat/wave0-d0-margin feat/wave0-d8-initdata              # exit 0
# Typecheck + unit tests locally (no DB needed for unit):
bun install --frozen-lockfile
bun run --cwd apps/agent-worker vitest run --reporter=dot     # unit; integration skips w/o TEST_DATABASE_URL
bunx tsc -p apps/agent-worker --noEmit
bunx tsc -p packages/api-gateway --noEmit
bunx tsc -p apps/tg-miniapp --noEmit
```

### 4.1 Merge order
Target = the R0 branch `plan/15.1-r0-billing-identity` (Wave-0 is built on R0; merge Wave-0 onto R0, then ship R0+Wave-0 together — R0 is the live-but-unmerged base).

**Recommended (single merge of the tip):**
```bash
git checkout plan/15.1-r0-billing-identity
git merge --no-ff feat/wave0-d8-initdata    # brings all 6 commits, ff-clean (linear stack)
```
**Staged (if you want per-stream commits in history):**
```bash
git checkout plan/15.1-r0-billing-identity
git merge --ff-only feat/wave0-safefetch-defaultmodel   # 1
git merge --ff-only feat/wave0-d0-margin                # 2 (already contains #1)
git merge --ff-only feat/wave0-d8-initdata              # 3 (already contains #1+#2)
```
> The migration-to-master decision is separate: R0 itself is not yet on master. Either merge R0+Wave-0 to master in one PR after VPS-green, or keep shipping from `plan/15.1-r0-billing-identity` as today. Wave-0 does not change that posture.

### 4.2 Migrations
**NONE.** No `.sql`/migration files in the stack (verified). Skip the migration step entirely. (If a future D-1 USD-ledger lands, that one needs `sudo -u postgres psql aiag` + a freeze-window — not now.)

### 4.3 TEST gate (run BEFORE prod restart)
Run **Pattern A** (§3.1) against `aiag_test`. Must be green:
- settleRun integration suite (4/4, the R0 baseline) — still green.
- D-0 billing: a gateway-billed run settles off `X-AIAG-Charged-Rub`, NOT the local estimate; margin = charged − upstreamCost logged.
- CHARGE-0 floor: a zero-token/zero-charge billable run settles at `MIN_RUN_COST` (1₽), never 0; external/BYOK stays exactly 0.
- DEFAULT_MODEL: a run with no model resolves to `openai/gpt-4o-mini` and does NOT 400 "Unknown model" at the gateway.

### 4.4 Deploy to prod
**Gateway (CI path — preferred, no OOM):**
```bash
gh workflow run deploy-production.yml -f ref=plan/15.1-r0-billing-identity -f apps=gateway
# CI builds on the runner, rsyncs, atomic-swaps symlink, pm2 reload gateway, /health check + auto-rollback.
```
**worker (background BullMQ — built in CI prebuild or manually; light):**
```bash
# worker is part of the web/gateway/worker CI set; include it:
gh workflow run deploy-production.yml -f ref=plan/15.1-r0-billing-identity -f apps=gateway,worker
```
**agent-worker + tma (manual on VPS — OOM-guarded):**
```bash
ssh aiag-vps        # via VPN proxy: ssh -o ProxyCommand="connect -H 127.0.0.1:10809 %h %p" aiag-vps
cd /srv/aiag/web-repo && git fetch && git checkout plan/15.1-r0-billing-identity && git pull
bun install --frozen-lockfile
# turbo libs first (shared/api-gateway) so @aiag/shared resolves:
bun run --cwd packages/shared build
# agent-worker (light, Bun/tsup — no OOM):
bun run --cwd apps/agent-worker build
# tma (OOM hazard — guard it):
swapon --show || (sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile)
pm2 stop web    # free ~92MB+ for the build window
NODE_OPTIONS="--max-old-space-size=1536" bun run --cwd apps/tg-miniapp build
pm2 start web
# restart the two manual procs:
pm2 restart agent-worker tma
pm2 save
```
> Note the known pm2-name quirk (STATE.md): some scripts expect `web`/`gateway` but live names may be `aiag-web`/`aiag-gateway` — confirm with `pm2 ls` before restart.
> Note the `AIAG_GATEWAY_KEY` precondition: it must be present in `/srv/aiag/shared/.env`, else aiag runs use the OpenRouter fallback (no markup) — Wave-0's D-0 headers only populate on the gateway path.

### 4.5 Smoke checks (prod, after restart)
```bash
# health
curl -fsS http://127.0.0.1:4000/health            # gateway
curl -fsS https://ai-aggregator.ru/tg/health       # tma via nginx
pm2 ls                                              # all 5 online, no restart loop
# D-8 auth: a fresh, valid initData logs in; a REPLAYED initData → 401 reason=replayed;
#           an initData older than 600s → 401 reason=expired.
# D-0: trigger one agent run on a funded test agent → agent-worker log shows
#      "D-0 settle ... charged=.. upstreamCost=.. margin=.." and tg_user_balances debited.
# DEFAULT_MODEL: a run with no explicit model does NOT log "Unknown model"/400.
# safeFetch: gateway proxy to a private IP returns 502 "Upstream address is not permitted".
pm2 logs agent-worker --lines 50
```

### 4.6 Rollback
- **gateway/worker (CI):** the workflow auto-rolls back on a failed `/health` (symlink → previous release + pm2 reload). Manual: `ln -sfn /srv/aiag/<app>/releases/<prev> /srv/aiag/<app>/current && pm2 reload <app>`.
- **agent-worker/tma (manual):** `git checkout <prev-sha>` in `/srv/aiag/web-repo`, rebuild that app, `pm2 restart <app>`. Keep the previous build dir or note the prior SHA before deploying.
- **No DB rollback needed** (no migration). The D-0 change is forward-compatible: if reverted, the worker simply goes back to billing off the local estimate — no data corruption, balances stay consistent.

---

## 5. Managed-Hermes test box (~18GB) — provisioning + isolation (R1.3 spike)

**Founder stance (CLAUDE.md / decisions 2026-06-03):** build managed-Hermes for test on a **~18GB shared VPS**, isolated from the money path. This is an R&D spike (D-2/D-3), **not** part of the Wave-0 deploy.

**Provision (separate, never co-resident with `5.129.200.99`):**
- **Box:** a **new, separate Timeweb VPS, ~18 GB RAM** (founder spec), Ubuntu 24.04, own disk. **Do NOT add Hermes pods to the 2GB money-path box** — RK-1: resident `hermes gateway` (~300–600 MB each) + pgvector HNSW build + self-hosted observability all compete with the live money path. This is a hard ceiling gate.
- **Isolation packaging:**
  - Its own Postgres + Redis (or a separate logical DB) — never share the money-path `aiag` DB.
  - Reaches the model gateway only as a **client** over the OpenAI-compatible URL (`http://<gw-host>:4000/v1`) with its own scoped `AIAG_GATEWAY_KEY` — same posture as any external buyer. No direct DB access to prod.
  - **Daytona sandboxes the tool execution only**; the `hermes gateway` process stays **resident** — the whole point of the spike is to **measure resident-gateway RAM and whether one gateway multiplexes many users** before building any provisioner (D-2 caveat).
  - Network: separate firewall; the only ingress from prod is the gateway client call. No SSH trust between the two boxes beyond the operator's key.
- **What to measure in the spike (gates scaling):**
  1. Resident RAM of 1 idle `hermes gateway`, and of N concurrent active ones (multiplexing factor).
  2. Whether one gateway can serve multiple TMA users or needs one-per-user (drives the dedicated-vs-shared tiering: high-payers → dedicated, ~$20-tier → shared).
  3. pgvector HNSW build cost (memory) for agent memory.
- **Reality guardrails (CLAUDE.md):** Hermes has **no remote config REST API** in the sense the synthesis assumed (config is files+CLI on the host; the real API is `PUT /api/config`, `POST /api/model/set`, etc.). TMA can *talk to* a Hermes over its OpenAI-compatible URL but cannot remote-control it without a control plane we build. Hermes already bridges Telegram natively → we do NOT build the chat bridge. Treat managed-Hermes as **R&D, not shippable** until the spike numbers come back.

---

## 6. Go / No-Go

**GO — deploy Wave-0 now**, with these conditions:
1. Run the **Pattern A test gate** (§3.1 / §4.3) green first — disposable `aiag_test`, vitest, no prod write.
2. Build **gateway (+worker) via CI** (no VPS OOM); build **tma + agent-worker on the VPS with the OOM guard** (§4.4) — swap on + cap heap + stop `web` during the tma build, OR run the tma build in CI.
3. No migration step (none exist in the stack).
4. Post-deploy smoke: D-8 replay→401, D-0 margin logged + balance debited, DEFAULT_MODEL no longer 400s, safeFetch blocks private IPs.

**Why GO is safe:** runtime RAM delta ≈ 0 (no new process/cache/dep), no schema change, the billed worker call is non-streaming (the ₽0-settle stream risk does not apply), and the change is forward/back compatible (revert just drops billing to the local estimate). The only material risk is the **tma build-time OOM**, which is build-time, well-understood, and fully mitigated by swap / heap-cap / build-in-CI.

**The one standing recommendation** (not a blocker): upgrade the prod box **2GB → 4GB** before real TMA traffic — it removes the build-OOM friction permanently and is already flagged in STATE.md.
