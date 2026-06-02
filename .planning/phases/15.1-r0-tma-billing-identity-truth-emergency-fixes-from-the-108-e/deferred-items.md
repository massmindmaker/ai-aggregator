# Deferred Items — Phase 15.1

Items discovered during plan execution that are OUT OF SCOPE for the current task but should not be lost.

## Pre-existing test failure: resolve-upstream "AIAG_GATEWAY_KEY not set" message mismatch

**Discovered during:** Plan 03 (Task 2 — running full vitest suite to verify no regressions)
**Introduced by:** Plan 01 commit `aab50ee` (graceful OpenRouter fallback) changed the error message from `'AIAG_GATEWAY_KEY not set'` to `'neither AIAG_GATEWAY_KEY nor OPENROUTER_API_KEY set'`, but the unit test in `resolve-upstream.test.ts` was not updated to match.
**File:** `apps/agent-worker/src/__tests__/resolve-upstream.test.ts` — the assertion `expect(...).toThrow('AIAG_GATEWAY_KEY not set')` fails because the actual error is `'neither AIAG_GATEWAY_KEY nor OPENROUTER_API_KEY set'`.
**Impact:** The test itself is about correct unit-level behavior; the production code error message is intentional (covers the case where both keys are absent). The fix is trivial: update the test's expected string to match the current error message.
**Fix:** Change the test assertion to `toThrow('neither AIAG_GATEWAY_KEY nor OPENROUTER_API_KEY set')` (or use a partial match).
**Priority:** Medium — doesn't block any features or prod safety, only CI signal accuracy.
