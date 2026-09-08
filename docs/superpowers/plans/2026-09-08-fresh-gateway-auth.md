# AG — fresh authentication for mounted gateway routes

## Goal and boundary

Remove Redis as an authorization source from the already mounted `requireApiKey` middleware. Every accepted bearer must be resolved by one prepared PostgreSQL lookup of its SHA-256 digest on that request. The result placed in Hono context must therefore contain current active-key state and current policy fields.

This is a narrow gateway-auth change only. It does not add a route, alter SQL schema or migrations, change the API-key format, introduce a new public helper, change rate limiting or billing, or activate stored-chat execution. Existing `setApiKeyResolver()` remains the explicit unit-test/harness seam; production uses the fresh database path whenever that seam is unset.

## Current evidence

- `packages/api-gateway/src/server.ts` mounts `requireApiKey` for every `/v1/*` request before rate limits, PII and routes.
- `packages/api-gateway/src/middleware/auth-plan04.ts` currently reads/writes Redis for 300 seconds and caches the complete `AuthenticatedApiKey`, including `policies` and enforcement fields. A disabled/revoked key or policy change can therefore be stale for that window.
- The current prepared lookup already selects the required context fields and filters `revoked_at IS NULL` and `disabled_at IS NULL`; it must become the only production resolver.
- `packages/database/migrations/0004_gateway_core.sql`, `0010_dashboard_keys.sql`, and `packages/database/src/schema/gateway.ts` establish the relevant stored columns. Existing guarded native fixtures exercise disable/revoke/policy writes, but there is no separate gateway HTTP-auth native harness. No SQL behavior changes in this task.

## Binding behavior

1. Keep bearer parsing and `KEY_PREFIX_REGEX` unchanged. Missing, malformed, unknown, revoked, or disabled credentials stop before `next()` with the existing sanitized `UNAUTHORIZED` error. A database or injected-resolver failure stops before `next()` with a fixed `SERVICE_UNAVAILABLE` error. Do not expose database, cache, key, hash, policy, SQL, or resolver failure detail.
2. With no injected resolver, compute `hashKey(key)` once and use it only as a prepared interpolation in a single `SELECT` of the existing `AuthenticatedApiKey` projection. It must include `key_hash = digest`, `revoked_at IS NULL`, and `disabled_at IS NULL`.
3. Remove `makeRedis`, `CACHE_TTL_SEC`, cache key construction, `get`, JSON parsing, and `setex`. A warm legacy Redis value is never read, written, or trusted.
4. Preserve current Hono context names and shape: set `apiKey` and `orgId` only after a successful resolver result. Preserve `X-Upstream-Key` passthrough and `byok=true` exactly after authentication succeeds.
5. Preserve best-effort `last_used_at`: issue its existing prepared update only after a successful fresh lookup, using the resolved key id rather than bearer plaintext/hash. Swallow its rejected promise and do not log credentials. It is telemetry, never an authorization dependency.
6. Catch unexpected database or injected-resolver rejection at the middleware boundary and convert it to a new fixed `errors.unavailable('Authentication unavailable')`. This is safe for `applyAiagErrorHandler`: its log sees only the fixed `AiagError`, not an original database diagnostic. Absence of a row remains `errors.unauthorized()`. No downstream, billing, adapter, or provider call may occur after either failure.
7. The fresh lookup is an authorization decision at middleware time, not a transaction-wide revocation lock. A later revocation can still race an already authorized legacy request; financial/storage entrypoints retain their own active-key and admission checks. This task removes the five-minute cache window and does not claim a new atomic revoke guarantee.

## Task 1: fresh mounted authentication and regression tests

**Owned files:**

- `packages/api-gateway/src/middleware/auth-plan04.ts`
- `packages/api-gateway/src/__tests__/auth.test.ts`

1. Write RED tests in the existing Hono fixture. Mock `../lib/db`'s tagged `sql` before importing middleware so the default (non-resolver) branch is observable without a real database; do not treat resolver-only tests as evidence for production lookup. Keep `setApiKeyResolver()` for its existing tests and reset it in `beforeEach`.
2. In `auth-plan04.ts`, delete the Redis import/cache constant/read/write branches. Retain a private default resolver that hashes the parsed bearer and performs the current prepared active-key query every request. Retain the existing best-effort `last_used_at` update with resolved id only. Wrap resolver/database failures at `requireApiKey` so they fail closed as fixed `errors.unavailable('Authentication unavailable')`; only a completed lookup with no row is `errors.unauthorized()`.
3. Keep the selected fields and `AuthenticatedApiKey` compatibility exactly as today: `id`, `org_id`, `policies`, `rpm_limit`, `daily_usd_cap`, `batch_rpm_limit`, `cost_limit_monthly_rub`, `model_whitelist`, and `ru_residency_only`. Do not coerce or default policies in auth.
4. Run only focused unit/type/lint checks under the shared lock. No native DB test is required because query semantics and schema are unchanged; do not claim native proof from the unrelated storage fixtures.

## Meaningful acceptance matrix

| Scenario | Required assertion |
|---|---|
| Warm Redis contains a previously valid serialized key; fresh DB returns no active row | Request is `401 UNAUTHORIZED`, DB `SELECT` occurs, route handler counter stays zero, and no cache operation is used. This fails against the old cache-first implementation. |
| Same valid bearer on two requests; mocked fresh rows change `policies` | Both requests perform the active-key `SELECT`; a test endpoint observes the changed context policy on request two. |
| First fresh row valid, second lookup absent after simulated `disabled_at` or `revoked_at` change | First request reaches handler; next request is `401`, handler count does not increase. Assert query contains both active predicates. |
| Unknown key and malformed/missing bearer | Each produces only `UNAUTHORIZED`; no `next()`/paid-route sentinel runs and no raw error text appears in JSON. |
| Rejecting DB/resolver | Each produces fixed `503 SERVICE_UNAVAILABLE` with no raw error text, SQL diagnostic, key, or hash in body/logged `AiagError`; no `next()`/paid-route sentinel runs. |
| Successful default lookup | Context retains the explicit selected fields (`id`, `org_id`, `policies`, limits, whitelist, and residency flag); SELECT interpolation contains SHA-256 digest rather than plaintext bearer; best-effort `last_used_at` update receives only resolved id. |
| Successful injected resolver plus `X-Upstream-Key` | Existing resolver seam stays functional; `apiKey`, `orgId`, `byok`, and `byokKey` context behavior is unchanged. |

## Verification commands

Run sequentially:

```bash
flock /tmp/ai-ecosystem-build.lock node_modules/.bin/vitest run packages/api-gateway/src/__tests__/auth.test.ts
flock /tmp/ai-ecosystem-build.lock node_modules/.bin/tsc --noEmit -p packages/api-gateway/tsconfig.json
flock /tmp/ai-ecosystem-build.lock node_modules/.bin/tsc --noEmit -p packages/api-gateway/tsconfig.test.json
flock /tmp/ai-ecosystem-build.lock node_modules/.bin/eslint packages/api-gateway/src/middleware/auth-plan04.ts packages/api-gateway/src/__tests__/auth.test.ts
git diff --check -- packages/api-gateway/src/middleware/auth-plan04.ts packages/api-gateway/src/__tests__/auth.test.ts
```

## Risks and non-goals

- This intentionally trades the old Redis authorization cache for one database lookup per mounted `/v1` request. Capacity/latency tuning is deferred until measured; reintroducing a cache would require a separate design with revocation and policy invalidation guarantees.
- The test resolver remains a process-local testing seam. It is not a production credential bypass API and must not be wired to request data.
- A successful auth lookup does not replace later atomic admission checks. It only makes the mounted route's key identity and policies current before those checks.
- The fresh lookup is point-in-time. It deliberately does not promise that a key revoked after middleware acceptance cannot finish an already-started legacy request; closing that lifecycle race belongs to a later admission/cutover gate.
- Existing `last_used_at` remains asynchronous and best-effort; it cannot make a failed authorization succeed and must never carry the raw bearer into SQL, logs, or context.

Root plan review: approved for narrow local implementation. Preserve lookup-time versus transaction-time revocation boundary; use sanitized503 for resolver outages. Independent source review remains required before acceptance.
