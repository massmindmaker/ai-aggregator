# Catalog sync scoped fixwave1 — report

Date: 2026-09-13

## Snapshot and scope

- Declared base: `4459902ec159fb7f17985a9a8dd42138431c8865`.
- Starting HEAD was that base; HEAD immediately before this scoped commit was
  `39a38f139cb2a8b31cd4bd38dc93f90ee6af8173` (an unrelated concurrent change
  advanced the branch).
- Changed here: `apps/worker/src/catalog/__tests__/catalog-native.integration.test.ts`
  and test-only `apps/worker/tsconfig.catalog-test.json`.
- Unchanged: `sync-cron.ts`, checked-in fixture, migrations, generic guard,
  runtime/cron behavior, and other workers' files.

## Safety boundary and preconditions

The test runs only with `RUN_NATIVE_DB_INTEGRATION=1` through
`/tmp/ai-ecosystem-run aggregator` and the shared `flock
/tmp/ai-ecosystem-build.lock`. Its module-level static guard requires matching
`DATABASE_URL` and `TEST_DATABASE_URL`, `AIAG_TEST_DATABASE=1`, and the exact
loopback `ai_aggregator_test` identity. The connected guard then checks the
existing marker with `bootstrapMarker` omitted.

Before importing `@aiag/database` or `sync-cron`, the guarded connection also
checks the existing `model_catalog_drafts` table, its five required columns
(`provider_slug`, `model_slug`, `raw`, `normalized`, `status`) and the unique
key on `(provider_slug, model_slug)`. Absent marker or schema mismatch stops
before the target import and before any fixture/sentinel mutation. This is an
already-migrated shared-DB test, not a clean migration rehearsal.

The checked-in fixture is read unchanged and cloned only in memory. Each of
its original provider and model keys receives the run UUID suffix. The native
test creates, reads, updates and deletes only these exact UUID provider/model
pairs. It inserts one separately named UUID foreign sentinel, verifies its raw
payload, normalized payload and `rejected` status remain unchanged after sync,
then deletes it by its exact pair. There is no full-table deletion and no
mutation of existing natural provider/model pairs.

`withGuardedTestDatabase` closes its guard client in `finally`. After a passed
guard, the suite owns one production-driver pool and one assertion client.
Partial setup errors first attempt exact owned-row cleanup and then close both
resources. Teardown records a cleanup error but still closes both resources;
it also queries that zero owned rows and zero sentinel rows remain before
closing the assertion client.

## Evidence

Static audit before native execution found no migration runner, marker
bootstrap, static import of the catalog target/database driver, or broad table
delete in the native test. The only target imports are dynamic after connected
marker and schema checks. The review's earlier invalid
`@typescript-eslint/no-explicit-any` suppressions were removed with typed
boundaries.

Focused RED to GREEN:

1. The independent review recorded the prior lint RED caused by two invalid
   rule suppressions. After the ownership rewrite, focused lint passed.
2. During this run, the added schema precondition query initially produced a
   PostgreSQL syntax RED at alias `constraint`, before any app/database import
   or fixture mutation. The guard closed its client. Renaming the alias to `c`
   produced the final GREEN run below.

Final commands, all sequential under the shared lock:

```text
flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator \
  bun x --no-install tsc --noEmit -p apps/worker/tsconfig.catalog-test.json
# exit 0

flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator \
  bun x --no-install eslint -c packages/api-gateway/.eslintrc.cjs \
  apps/worker/src/catalog/sync-cron.ts \
  apps/worker/src/catalog/__tests__/catalog.test.ts \
  apps/worker/src/catalog/__tests__/catalog-native.integration.test.ts
# exit 0

flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator \
  bun x --no-install vitest run apps/worker/src/catalog/__tests__/catalog.test.ts
# PASS: 1 file, 6 tests

flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator \
  env RUN_NATIVE_DB_INTEGRATION=1 bun x --no-install vitest run \
  --no-file-parallelism apps/worker/src/catalog/__tests__/catalog-native.integration.test.ts
# PASS: 1 file, 2 tests; two sync cycles each logged providers=8, drafts=38
```

The native assertions prove fixture clone cardinality (8 providers / 38
models), exact original per-model raw payload, repeat upsert cardinality
without duplicates, preservation of one owned `applied` and one owned
`rejected` row, foreign sentinel preservation, and exact cleanup.

## Limitations

No real models.dev/network request, credentials, cron activation, process
startup policy change, migration execution, marker bootstrap, production DB,
or deployment occurred. The historical fail-fast commit claim remains
corrected as evidence only: this scoped change preserves current cron logging
and retry behavior. Full T4 retry/admin diff-apply acceptance remains open.
