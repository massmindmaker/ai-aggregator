# AI Aggregator extraction report

Date: 2026-09-06
Branch: `feat/three-projects-completion`
Task base: `a77ef0d6601d6cb3702ef659e47379abd19071f2`

## Result

AI Aggregator now has two active applications: `apps/web` and `apps/worker`.
The transferred Agents Market trees were removed from this clone only after
confirming `/home/bob/Projects/agents-market` at `a0ad767` contains both
`apps/tma` and `apps/worker`.

- Removed 105 tracked files from `apps/tg-miniapp`.
- Removed 26 tracked files from `apps/agent-worker`.
- Removed 131 tracked files in total; both directories are physically absent.
- Kept `apps/worker`, including its historical contest evaluation and close
  jobs, pending the separate audited Arena transfer.
- Kept the ordered database migration history. The migration README records
  historical cross-product ownership; no schema or production data was reset.
- Preserved and committed the pre-existing CSP change in
  `apps/web/src/middleware.ts` and the original
  `packages/database/scripts/__tests__/sync-models-dev.test.ts` exactly as
  required by the extraction brief.

## Boundary and tooling changes

- Root workspaces are explicit: `apps/web`, `apps/worker`, and `packages/*`.
  Root scripts, Bun 1.4.2 lock metadata, CI, production workflow, and local
  deploy script no longer address the transferred applications. Production CI
  now uses a pinned Bun version and a strict frozen lockfile.
- Canonical `AGENTS.md`, `PRODUCT.md`, `README.md`, `CLAUDE.md`, `DESIGN.md`,
  `SECURITY.md`, and `docs/ARCHITECTURE.md` describe Aggregator only. Historical
  suite context remains in Git and is indexed by
  `docs/archive/legacy-suite-context.md`.
- The two old TMA nginx files are explicitly labelled legacy snapshots owned
  by `/home/bob/Projects/agents-market`; they are not deploy inputs here.
- Billing header and shared Startonus/safe-fetch edits only replace stale
  in-repository `apps/agent-worker` references with the external Agents Market
  owner or a generic Node-service description. They do not change pricing,
  settlement, NFT, provider, or request behavior.

## Vitest discovery repair

The root environment is Node. Only tests under `apps/web` receive jsdom.
Recursive `node_modules`, `dist`, `.next`, recovered donor documentation, E2E,
and deliberate fixtures are excluded. `vitest.setup.ts` no longer assumes a
browser while initializing Node suites.

`tests/fixtures/vendor/node_modules/vendor-fixture.test.ts` throws immediately
if collected. It is deliberately committed through narrow `.gitignore`
exceptions. The factual discovery command ran against the containing `tests`
directory and collected only the configuration proof:

```text
vitest run --dir tests --reporter=verbose
Test Files  1 passed (1)
Tests       2 passed (2)
```

Log: `/tmp/ai-aggregator-vitest-discovery-proof-focused.log`.

## Build repairs required by the baseline

The shared TypeScript preset previously made `rootDir` and `outDir` relative to
`packages/typescript-config`, causing TS6059 in leaf packages. A `${configDir}`
attempt fixed plain `tsc` but resolved to `/src` inside tsup's DTS worker. The
portable repair removes relative paths from the shared preset and declares
local `src`/`dist` paths in each leaf package (`upstream-adapters` retains its
intentional `rootDir: "."`). This is build configuration only.

After that repair, gateway DTS generation exposed one production type mismatch:
`registerEgressExecutor` accepts a vetted `connectAddr` string, while
`fetchViaProxy` accepts `{ connectAddr }`. `packages/api-gateway/src/index.ts`
now uses the direct adapter between those existing contracts. No routing,
provider, payment, or money feature was added.

## Reproducible verification

Every build/test command below used `flock /tmp/ai-ecosystem-build.lock`. Test
and build commands ran through `/tmp/ai-ecosystem-run aggregator`, which
provides an empty isolated Postgres and Redis environment.

- `bun install --frozen-lockfile`: 823 installs across 926 packages, no
  changes. Log: `/tmp/ai-aggregator-bun-install.log`.
- Focused extraction baseline: 5 files, 60 tests passed. This is the prior
  54-test pricing/billing/Tinkoff baseline, the 2-test discovery contract, and
  the 4-test gateway billing-header contract. Log:
  `/tmp/ai-aggregator-extraction-green.log`.
- `apps/worker` standalone type-check: passed. Log:
  `/tmp/ai-aggregator-typecheck-worker-final.log`.
- API gateway ESM and DTS build: passed. Log:
  `/tmp/ai-aggregator-build-gateway-final.log`.
- Direct web build: passed and generated 219 static pages. Log:
  `/tmp/ai-aggregator-build-web.log`.
- Final root `bun run build`: 9/9 Turbo tasks passed, 7 cached, 2 executed;
  219 static pages generated. Log: `/tmp/ai-aggregator-build-final.log`.
- JSON configs, both workflow YAML files, deploy shell syntax, and
  `git diff --check`: passed.

The successful build retains non-fatal warnings for the Next 14
`serverExternalPackages` key, non-literal health-route runtime, old
Browserslist data, Tailwind's ambiguous `duration-[400ms]`, and a dynamic
dependency in built shared server code.

## Honest broad-suite snapshot and retained blockers

One broad run was started while diagnosing discovery, before the recovered
donor exclusion and before restoring the required sync-test import. It is a
historical snapshot, not the post-repair final suite count:

```text
Test Files  10 failed | 94 passed (104)
Tests       14 failed | 796 passed (810)
```

Log: `/tmp/ai-aggregator-vitest-discovery-proof.log`. The broad suite was not
repeated after the discovery repair because Task 2B does not include repairing
the product and historical contest suite. The snapshot included these failures:

- `packages/database/scripts/__tests__/sync-models-dev.test.ts`: cannot resolve
  `../../scripts/sync-models-dev`. No implementation exists in any checked
  source under `/home/bob/Projects`; the original test is preserved as the
  explicit missing-implementation blocker.
- `docs/superpowers/recovered/aiag-web/apps/web/src/__tests__/me-submit-model.test.ts`:
  recovered donor material was collected. It is now excluded as non-source.
- `apps/web/src/__tests__/api-register.test.ts`: empty test database has no
  `users` table; teardown also fails.
- `apps/web/src/__tests__/payments/routes.test.ts`: two cancellation tests use
  a DB mock without `db.query.subscriptions.findFirst`.
- `apps/web/src/__tests__/api-playground-run.test.ts`: unknown model expected
  404 but returned 200.
- `apps/web/src/__tests__/register-consents.test.tsx`: two tests hit
  `invariant expected app router to be mounted` through duplicate nested Next
  resolution.
- `apps/web/src/__tests__/ModelCard.test.tsx`: two stale transfer-warning and
  RF-badge expectations.
- `apps/web/src/__tests__/marketplace/catalog-related.test.ts`: fixture expects
  missing `openai/gpt-4-turbo`.
- `apps/web/src/__tests__/marketplace/scenarios.test.ts`: fixture expects
  missing `yandex/yandexgpt-5`.
- `apps/worker/src/eval-runner/__tests__/runner.test.ts`: three 5-second
  timeouts and one SIGKILL timeout-result mismatch. This historical contest
  code remains pending Arena transfer.

Standalone gateway/web `tsc --noEmit` diagnostic snapshots also exposed
pre-existing test-program issues: gateway tests import web catalog sources
outside the package `rootDir`, and web tests lack Testing Library matcher type
augmentation plus several old strict-test errors. These were not used to hide
or bypass tests. The final production root build, worker type-check, focused
tests, and factual discovery proof are green.

No refund implementation, provider port, schema mutation, production deploy,
or money feature was added in Task 2B.
