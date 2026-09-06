# Minimal localhost PostgreSQL support for isolated AI Arena E2E

## Finding

The current code is Neon-only in four separate paths:

1. `src/db/index.ts` uses `@neondatabase/serverless` Pool and `drizzle-orm/neon-serverless` for every app request.
2. `scripts/migrate.ts` uses `neon-http` migrator.
3. `scripts/run-isolated-e2e.mjs` reads the direct marker through `neon()`.
4. `scripts/e2e-fixtures.ts` and `scripts/e2e-run.ts` issue direct Neon tagged SQL.

Thus merely pointing `E2E_DATABASE_URL` at `postgresql://127.0.0.1:15432/...` cannot work: the serverless driver needs a Neon HTTP/WebSocket endpoint. The app does not declare `pg`; the only observed copy is an unrelated `/tmp/ai-ecosystem-tools/node_modules/pg` (v8.23.0), which must not be imported or relied on. `psql` is absent here, so this review did not probe the user-supplied local database or any credentials.

The marker gate itself is sound and must remain: direct DB marker is checked before migrations/build; then the running app checks the same marker with an in-memory guard token before fixtures/scenarios.

## Recommended adapter boundary

Add one **explicit E2E-only** native driver selection; never infer the driver from a PostgreSQL URL.

```text
AI_ARENA_E2E_DB_DRIVER=neon | native-pg   # default: neon
```

`native-pg` is legal only when all of these hold:

- `AI_ARENA_E2E_MODE=1`;
- `E2E_DATABASE_KIND=test`;
- `DATABASE_URL` and `E2E_DATABASE_URL` have the same normalized identity inside the spawned child (the orchestrator sets this deliberately);
- the parent has already passed `assertE2EEnvironment`, direct `{kind:'test', markerHash}` validation, and the existing HTTP marker check.

Any missing/mismatched condition throws before a pool/query is created. Production and ordinary development always stay on the existing Neon path, including when their URL happens to be `postgresql:`.

## Exact implementation scope

1. Add `pg` to `dependencies` (the server may load it) and `@types/pg` to `devDependencies`; regenerate `package-lock.json`. Do not vendor `/tmp` packages.
2. Create `aiarena-app/src/db/driver.ts` with:
   - `databaseDriverFromEnv(env)` returning `neon` by default and rejecting unknown values;
   - `assertNativeE2EDriver(env)`, which enforces the four conditions above using `identityForDatabase`-equivalent URL normalization;
   - factory seams for unit tests.
3. Modify `src/db/index.ts` only behind this factory:
   - Neon branch remains exactly `Pool` + `drizzle-orm/neon-serverless`.
   - Native branch is `new pg.Pool({ connectionString: DATABASE_URL })` + `drizzle-orm/node-postgres`.
   - Keep exported `getDb()` unchanged. If Drizzle's concrete database types differ, expose one existing `Db` alias and localize the audited cast in this file rather than leaking a union into `audit.ts`, `teams.ts`, and `moderation.ts` transaction aliases.
4. Modify `scripts/migrate.ts` to select matching migrators: current `neon-http` path for Neon; `pg.Pool` + `drizzle-orm/node-postgres/migrator` for `native-pg`. Require the native guard before connecting; do not alter migration files or journal.
5. Create `aiarena-app/scripts/e2e-sql.mjs`, a tiny tagged-query adapter with `createE2ESql(env) -> { sql, close }`:
   - Neon implementation wraps the existing `neon(url)`.
   - Native implementation converts template interpolations to `$1…$n` and calls `pg.Pool.query`, returning rows; values are passed separately and never formatted/logged.
   - It asserts `native-pg` guard before connecting and owns `pool.end()`.
   Use it in `run-isolated-e2e.mjs` (direct marker reader), `e2e-fixtures.ts`, and `e2e-run.ts`; close in `finally`. This is the smallest shared change that makes both marker verification and existing direct fixture/assertion SQL work locally.
6. Add `scripts/provision-local-e2e-marker.mjs`; do **not** weaken the existing Neon-only `set-environment-marker.ts` provenance rule. The new script must require all of:
   - `AI_ARENA_LOCAL_E2E_BOOTSTRAP=1`;
   - `AI_ARENA_E2E_DB_DRIVER=native-pg`, `E2E_DATABASE_KIND=test`, a canonical UUID marker, and its expected SHA-256;
   - URL hostname `127.0.0.1`, `::1`, or `localhost`, port `15432`, and an exact dedicated database name such as `aiarena_e2e`.
   It may create/read back only `environment_kind` and `app_environment`, then upsert `primary/test/<marker>`. It must reject any other host/port/database and print no URL, marker, or credentials. The E2E orchestrator still does not bootstrap automatically.
7. Documentation: add a redacted `.env.local.example` block only, explaining that the initial parent `DATABASE_URL` must identify a different non-test database so `assertE2EEnvironment` can reject an accidental same-DB run. The orchestrator continues to override child `DATABASE_URL` with `E2E_DATABASE_URL`.

## Tests required before using localhost

- `src/db/driver.test.ts`: default remains Neon; native rejects missing E2E mode/kind, unequal identities, unknown driver; valid guarded native selects only the native factory.
- `scripts/e2e-sql.test.mjs`: native placeholder/value mapping, no interpolation into SQL text, and `close()`; no live DB.
- Extend `run-isolated-e2e.test.mjs`: native selected direct marker still aborts before `db:migrate` on missing/wrong marker, and child env preserves the selected driver.
- `scripts/provision-local-e2e-marker.test.mjs`: rejects remote host, wrong port, wrong DB name, absent explicit bootstrap, and failed read-back; accepts only a mocked localhost test input.
- Keep existing `e2e-db-guard` and marker-route tests unchanged. A real local run is valid only after one explicit provisioning read-back, then direct marker → migration → HTTP marker → fixtures/scenarios. No fallback to Neon and no marker bypass.

This is sufficient for meaningful isolated E2E against native PostgreSQL while preserving production Neon behavior and the current fail-closed chain.
