# Aggregator Task 1 report — guarded native database baseline

Date: 2026-09-07

## Scope and repository evidence

- Repository: `/home/bob/Projects/ai-aggregator`.
- Branch: `feat/three-projects-completion`.
- Required review base and canonical HEAD at dispatch: `7c464d2f3e4537af31880be7e0fb46fce7d09e19`.
- While Task 1 was in progress, the controller added `ba64367c491c5c5b03acf866686ed21eb4e303b2` (`docs: record reviewed Arena foundation and canonical verification`). That commit and its tracked documentation were preserved; this task did not edit them.
- Historical source reads used only the extraction mapping target `/home/bob/Projects/archive/ai-ecosystem-sources-20260906/aggregator-sourcecontainer/core`, whose checked HEAD was `2252c95f3dbcfcae693a7a51bc3f910bfcf9b3cc`.
- No remote or production database was contacted. The only mutable database was the explicitly opted-in disposable target `127.0.0.1:15432/ai_aggregator_test`. The archived calling tree `/home/bob/Projects/archive/aiag-web` was not touched.
- Refund schema and refund money semantics are outside Task 1 and were not added.

## Migration inventory

The native migrator reads the complete historical schema rather than a reduced test schema:

1. `packages/database/drizzle/0000_moaning_the_fury.sql`.
2. All 64 files in `packages/database/migrations`, sorted by the validated filename in C/default lexical order, from the two `0004_*` files through `0065_model_catalog_drafts.sql`.

Total: **65 ordered migrations**. The history requires no explicit `CREATE EXTENSION`; PostgreSQL 16 provides the used built-ins. Eleven historical files have one true outer `BEGIN`/`COMMIT` pair; the native migrator removes only that wrapper and owns the surrounding transaction. `0060_tma_own_org.sql` has the only two vetted psql value placeholders, `key_hash` and `key_prefix`. The harness creates a random local test key in memory and sends only its SHA-256 hash and prefix as PostgreSQL bind values. It does not read a production service key and never prints the raw key.

## Implemented behavior

- Added a fail-closed database guard. It requires `DATABASE_URL`, `TEST_DATABASE_URL`, and `AIAG_TEST_DATABASE=1`; normalizes `postgres://` and `postgresql://`, decoded database name, host and effective port; ignores credentials and harmless parameters; requires the two URLs to identify the same allowed local target; and rejects `host`, `hostaddr`, `port`, `database`, and `dbname` query overrides before client construction.
- The PostgreSQL package is dynamically imported only inside the client factory after the pure environment check. After connection, the guard verifies `current_database()` and the exact marker `ai-aggregator:test-database:v1` before any schema or fixture mutation. Only the explicit guarded `bootstrap` command can create an absent marker, after identity validation.
- Added native migration discovery, original SHA-256 checksums, effective SQL SHA-256 checksums, ledger validation, idempotent rerun behavior, and a migrator-owned transaction around each migration plus its ledger insert. A forced error after DDL leaves neither the DDL object nor its ledger row.
- Preserved historical SQL files unchanged. Two controller-approved, narrowly matched runtime adaptations are applied in memory:
  - `0005_contests.sql`: the stale `payouts_author_idx` statement runs only when introspection confirms that `public.payouts.author_id` exists. The canonical `payouts.user_id` schema is not modified. The adapter fails closed unless the exact historical statement matches once.
  - `0011_admin.sql`: before its `CREATE TABLE IF NOT EXISTS audit_log`, the adapter adds only missing `actor_email VARCHAR(255)`, `details JSONB`, and `ip_address VARCHAR(45)` with the source definition's defaults and nullability, then adds the separate `audit_log_actor_email_idx`. Existing `actor_id`, `metadata`, `ip`, `ua`, and the legacy `audit_log_actor_idx(actor_id)` remain intact. The adapter fails closed unless its exact anchor matches once.
- Effective checksums include the adapted SQL, so an adapter change cannot be mistaken for an already applied unchanged migration.
- Added guarded CLI commands, root package scripts, a PostgreSQL 16 CI service/job, focused real PostgreSQL integration fixtures, and a guard before the existing registration test imports its production database client.

## TDD and migration rehearsal evidence

RED began with:

```bash
flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-tools/node_modules/.bin/bun x vitest run packages/database/scripts/__tests__/test-db-guard.test.ts packages/database/scripts/__tests__/native-migrate.test.ts
```

The two suites initially failed because the guard and migrator modules did not exist. Subsequent focused RED cases exposed and then covered:

- a parser override reaching client construction;
- a JSON object key being mistaken for a psql variable;
- JavaScript replacement-string handling corrupting PostgreSQL `$$` delimiters;
- original/effective checksum drift;
- `0005` failing against canonical `payouts.user_id`;
- `0011` seeing an early `audit_log` table and then failing on missing runtime columns;
- a failed migration after DDL retaining partial state.

Before the final effective-SQL/index adjustment, the interrupted real migration rehearsals rolled back at `0005` and then `0011`. After the two approved adapters, the accumulated database reached all 65 migrations (`applied=55 skipped=10` on the completing run), followed by an idempotent rerun (`applied=0 skipped=65`). This was a resumed diagnostic sequence, not represented as a clean 65/65 run.

After the final `0011` separate-index effective checksum change, the guard verified identity and marker, and the disposable local `public` schema was reset. The final clean rehearsal was:

```bash
flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator env AIAG_TEST_DATABASE=1 /tmp/ai-ecosystem-tools/node_modules/.bin/bun run db:test:migrate
```

Result: `Native migrations: total=65 applied=65 skipped=0.`

The exact command was repeated. Result: `Native migrations: total=65 applied=0 skipped=65.`

Final readback:

```bash
flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator env AIAG_TEST_DATABASE=1 /tmp/ai-ecosystem-tools/node_modules/.bin/bun run db:test:status
```

Result: `Native database status: migrations=65 tables=96.`

## Verification

Focused guard and migrator unit tests:

```bash
flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-tools/node_modules/.bin/bun x vitest run packages/database/scripts/__tests__/test-db-guard.test.ts packages/database/scripts/__tests__/native-migrate.test.ts --reporter=dot
```

Result: **2 files passed, 32 tests passed** (19 guard, 13 migrator).

Real PostgreSQL baseline and registration scenarios:

```bash
flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator env AIAG_TEST_DATABASE=1 RUN_NATIVE_DB_INTEGRATION=1 /tmp/ai-ecosystem-tools/node_modules/.bin/bun x vitest run packages/database/scripts/__tests__/native-baseline.integration.test.ts apps/web/src/__tests__/api-register.test.ts --reporter=verbose
```

Result: **2 files passed, 10 tests passed**. Readbacks/scenarios cover:

- 65 immutable ledger rows and a zero-mutation rerun;
- 96-table complete historical schema plus registration tables and the real settlement function;
- both `audit_log_actor_idx(actor_id)` and `audit_log_actor_email_idx(actor_email)`;
- `0005` on canonical `payouts.user_id` and on a transaction-local `author_id` variant;
- exact `0011` column type/default/nullability, already-complete additive behavior, and rollback of its prelude on a later error;
- forced DDL failure with no table and no migration-ledger row left behind;
- real subscription-first then PAYG settlement (`7 + 3`), replay idempotency, and insufficient-funds rollback with balances and ledger unchanged;
- real `POST /api/auth/register` rejection without required consent and persistence of all three consent flags, timestamp, IP, and user agent.

The repository-facing aggregate command also passes on the fully migrated database:

```bash
flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator env AIAG_TEST_DATABASE=1 /tmp/ai-ecosystem-tools/node_modules/.bin/bun run test:database-baseline
```

Result: bootstrap ready, migration rerun `applied=0 skipped=65`, **2 files passed, 10 tests passed**.

Focused TypeScript check:

```bash
flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-tools/node_modules/.bin/bun x tsc --noEmit --module esnext --moduleResolution bundler --target es2022 --strict --esModuleInterop --skipLibCheck --types node,vitest/globals packages/database/scripts/test-db-guard.ts packages/database/scripts/pg-test-client.ts packages/database/scripts/native-migrate.ts packages/database/scripts/native-test-db.ts packages/database/scripts/__tests__/test-db-guard.test.ts packages/database/scripts/__tests__/native-migrate.test.ts packages/database/scripts/__tests__/native-baseline.integration.test.ts
```

Result: exit 0, no diagnostics. `package.json` files parse as JSON, `.github/workflows/ci.yml` parses as YAML, and `git diff --check` passes.

## Deferred observations

- The broad repository test/build baseline belongs to Task 2 and was deliberately not expanded here after the scoped checks passed.
- Previously extracted non-Task-1 failures (model sync coverage, payment-cancellation mocks, and the playground route expectation) were not changed or hidden.
- No additional numbered compatibility migration was needed, so `0066` remains free for the separately planned refund work.
- There are no Task 1 blockers.
