# Task 1 — stored-chat HTTP identity

Implemented the approved pure B2 identity builder.

Files:

- `packages/api-gateway/src/billing/stored-chat-http-identity.ts`
- `packages/api-gateway/src/__tests__/stored-chat-http-identity.test.ts`

Behavior covered: exact ASCII idempotency digest, existing SID contract, strict detached body admission with only `aiag_mode` extension, absent-mode versus explicit `auto`, immutable attempt body, and the documented tuple-based canonical v1 fingerprint. The test suite includes a fixed canonical-bytes/SHA-256 golden fixture.

Validation:

- RED: `flock /tmp/ai-ecosystem-build.lock node_modules/.bin/vitest run packages/api-gateway/src/__tests__/stored-chat-http-identity.test.ts` failed because the new module did not exist.
- GREEN: `flock /tmp/ai-ecosystem-build.lock node_modules/.bin/vitest run packages/api-gateway/src/__tests__/stored-chat-http-identity.test.ts packages/api-gateway/src/__tests__/stored-chat-attempt-contract.test.ts packages/api-gateway/src/__tests__/stored-chat-attempt.test.ts` — 3 files, 159 tests passed.
- `flock /tmp/ai-ecosystem-build.lock sh -c 'node_modules/.bin/tsc --noEmit -p packages/api-gateway/tsconfig.json && node_modules/.bin/tsc --noEmit -p packages/api-gateway/tsconfig.test.json && node_modules/.bin/eslint packages/api-gateway/src/billing/stored-chat-http-identity.ts packages/api-gateway/src/__tests__/stored-chat-http-identity.test.ts'` — passed.
- `git diff --check` for both new source/test files — passed.

Limitations: this is an unused pure builder only. It does not mount an HTTP route, compose trusted credentials or policy, write the database, resolve routing defaults, or run native/production checks.
