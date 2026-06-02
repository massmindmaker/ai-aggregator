# Testing Patterns

**Analysis Date:** 2026-06-02
**Scope:** `apps/tg-miniapp/`, `apps/agent-worker/`, shared gateway/worker billing path

---

## Test Framework

**Runner:**
- Vitest (root config: `vitest.config.ts`)
- Single config at monorepo root covers all packages

**Assertion Library:**
- Vitest built-in (`expect`)

**React Testing:**
- `@vitejs/plugin-react` for JSX support
- jsdom environment for browser-simulated tests

**Run Commands:**
```bash
bun run test                # Run all tests (monorepo root)
bun run test --watch        # Watch mode
bun run test --coverage     # Coverage report (v8 provider)
```

**Coverage thresholds** (enforced globally):
```
branches:   50%
functions:  50%
lines:      50%
statements: 50%
```
Threshold is low and applies globally (not per-app). TMA and agent-worker are NOT covered, so the threshold passes only because the well-tested packages (`apps/web`, `packages/api-gateway`, etc.) carry the averages.

---

## Test File Organization

**Location:**
- Pattern: tests in `__tests__/` subdirectories co-located next to source
- OR `.test.ts`/`.test.tsx` files directly in `src/`

**Naming:**
- `*.test.ts` for unit/integration tests
- `*.spec.ts` for E2E (Playwright in `e2e/` at monorepo root)

**Vitest include pattern:**
```
**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}
```
Excludes: `node_modules`, `dist`, `.next`, `e2e`

---

## Test Coverage by Component — CRITICAL ASSESSMENT

### apps/tg-miniapp — ZERO test coverage

There are **no test files** anywhere in `apps/tg-miniapp/`:
```
apps/tg-miniapp/
  app/              # ← no tests
  src/              # ← no tests
  middleware.ts     # ← no tests
```

Zero coverage for:
- All 14 API route handlers under `app/api/tma/`
- Auth verification logic (`src/lib/verify-init-data.ts`)
- JWT middleware (`middleware.ts`)
- Crypto (encrypt/decrypt API keys) (`src/lib/crypto.ts`)
- TON rate fetcher (`src/lib/ton-rate.ts`)
- External agent validator + prober (`src/lib/external-agent.ts`)
- All React page components (`app/agents/`, `app/market/`, `app/nft/`, `app/profile/`)
- Auth hook (`src/hooks/useAuth.ts`)

### apps/agent-worker — ZERO test coverage

There are **no test files** anywhere in `apps/agent-worker/`:
```
apps/agent-worker/
  src/
    agent-runner.ts   # ← no tests
    db.ts             # ← no tests
    tools.ts          # ← no tests
    bot-api.ts        # ← no tests
    index.ts          # ← no tests
```

Zero coverage for:
- The entire agent execution loop (`agent-runner.ts:runAgent`)
- Budget enforcement logic (monthly + daily gates)
- `resolveUpstream` — external vs. aiag routing
- `estimateCostRub` — pricing calculation
- All DB helper functions (`loadRun`, `loadAgent`, `sumMonthlySpend`, `getOrResetDailyBucket`, `incrementDailySpend`, `markStarted`, `markCompleted`, `markFailed`)
- Tool implementations (`webSearch`, `calc`, `imageGen`, `memoryTool`)
- Bot notification helpers (`buildRunCompletedMessage`, `buildRunFailedMessage`)

### apps/worker — Partial coverage (the only tested worker)

The `apps/worker` (NOT agent-worker — this is the gateway worker for contest eval) has tests:
- `apps/worker/src/queues/__tests__/contest-eval.test.ts` — 3 tests covering the `buildContestEvalProcessor` factory (success/timeout/invalid-json paths)
- `apps/worker/src/queues/__tests__/email-send.test.ts`
- `apps/worker/src/queues/__tests__/upstream-poll.test.ts`
- `apps/worker/src/queues/__tests__/webhook-retry.test.ts`
- `apps/worker/src/__tests__/close-contests-cron.test.ts`
- `apps/worker/src/__tests__/finalize-earnings-cron.test.ts`
- `apps/worker/src/eval-runner/__tests__/runner.test.ts`

### apps/web — Good coverage

The web app has ~45 test files covering API routes, components, payment flows, marketplace, admin, etc.

### packages/api-gateway — Good coverage

12+ test files covering auth, pricing, routing, rate-limiting, policies, etc.

### packages/upstream-adapters — Good coverage

12+ test files.

---

## What The Smoke Test Covers (Manual Only)

The only test document for TMA is `.planning/phases/15-tg-miniapp/SMOKE.md` — a **manual checklist**, not automated. It covers:

- Liveness: `GET /tg/health` → 200
- Telegram auth flow (open bot → tap menu button → auth verify)
- Agents CRUD (create from template, view detail)
- Agent run round-trip (`pending → running → completed`, DM notification)
- TON wallet linking + top-up (testnet)
- Marketplace → use-in-agent handoff
- NFT purchase via Startonus + webhook
- Negative cases (no JWT, bad JWT, budget exceeded, max iterations)

**Status of the smoke test:** The checkbox fields in the file are **all unchecked** (blank `__________` fields). There is no filled-out run transcript in the file — it was never executed as a documented manual test, or the results were not recorded.

---

## Test Structure (from apps/worker example)

```typescript
// apps/worker/src/queues/__tests__/contest-eval.test.ts
import { describe, it, expect, vi } from 'vitest';
import { buildContestEvalProcessor } from '../contest-eval.js';

// Helper: make a mock BullMQ job shape
function makeJob(data: Record<string, unknown>) {
  return { name: 'eval', data, queue: { add: vi.fn() } } as unknown as Parameters<...>[0];
}

describe('contest-eval processor', () => {
  it('maps successful run to status=success with score', async () => {
    const sink = vi.fn().mockResolvedValue(undefined);
    const run = vi.fn().mockResolvedValue({ ok: true, score: 0.87, output: '...' });
    const proc = buildContestEvalProcessor({ run, sink });
    await proc(makeJob({ submissionId: 's1', ... }), 'tok');
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ submissionId: 's1', status: 'success', publicScore: 0.87 })
    );
  });
});
```

**Pattern:** dependency injection into a factory function, then test via mocked `run`/`sink` collaborators. No network calls, no DB.

---

## Mocking

**Framework:** `vi` from Vitest

**Patterns:**
```typescript
vi.fn()                        // create mock function
vi.fn().mockResolvedValue(x)   // async mock
vi.mock('../module')           // module-level mock
```

**What to mock:**
- External HTTP calls (fetch)
- DB (postgres `sql` tag)
- BullMQ Queue/Worker
- Telegram Bot API

---

## Fixtures and Factories

No shared fixture files or factories exist for TMA or agent-worker. The `apps/worker` tests use inline `makeJob()` factory helpers defined per test file.

---

## Coverage

**Requirements:** 50% global threshold (enforced in `vitest.config.ts`)

**Reality for TMA + agent-worker:** 0% — neither app has any tests. The threshold passes because `apps/web` and `packages/*` carry the averages. This is a structural gap in coverage reporting: `vitest.config.ts` aliases resolve `@` to `apps/web/src`, not TMA. TMA files may not even be discovered for coverage unless explicitly included.

**View Coverage:**
```bash
bun run test --coverage
```

---

## Critical Gap Summary

| Component | Automated Tests | Manual Smoke | Risk Level |
|---|---|---|---|
| `apps/tg-miniapp/app/api/tma/*` routes (14 handlers) | **None** | Partially listed in SMOKE.md (unchecked) | **Critical** |
| `apps/tg-miniapp/middleware.ts` (JWT verification) | **None** | Section 9 in SMOKE.md | **Critical** |
| `apps/tg-miniapp/src/lib/verify-init-data.ts` | **None** | Implicitly via auth flow | High |
| `apps/tg-miniapp/src/lib/external-agent.ts` (SSRF guard) | **None** | None | **Critical** |
| `apps/tg-miniapp/src/lib/crypto.ts` (AES-GCM encrypt/decrypt) | **None** | None | **Critical** |
| `apps/agent-worker/src/agent-runner.ts` (runAgent loop) | **None** | Section 5 in SMOKE.md | **Critical** |
| Budget enforcement (monthly/daily gates) | **None** | Section 9 in SMOKE.md | **Critical** |
| `incrementDailySpend` (race condition risk) | **None** | None | High |
| `getOrResetDailyBucket` (atomic reset) | **None** | None | High |
| Topup/confirm credit (double-credit guard) | **None** | Section 6 in SMOKE.md | **Critical** |
| NFT webhook idempotency | **None** | Section 8 in SMOKE.md | High |
| `apps/worker/src/queues/__tests__/contest-eval.test.ts` | **3 tests** | — | Low |

**The agent execution path — from API run enqueue through worker execution through billing — has no automated test coverage at any layer.** Every path that touches money (daily spend, monthly budget, topup credit) relies on manual smoke testing against production infrastructure, which per the MEMORY.md rule is the intended approach ("No local runtime testing"). This makes regression detection for billing logic entirely dependent on monitoring production errors.

---

## Recommendations for Adding Tests

**Where new TMA/agent-worker tests should live:**
- Unit tests for pure functions: `apps/tg-miniapp/src/lib/__tests__/` (create directory)
- Unit tests for agent-worker: `apps/agent-worker/src/__tests__/` (create directory)

**Highest value tests to add first:**
1. `verify-init-data.ts` — pure function, no external deps, security-critical
2. `external-agent.ts` — SSRF guard `validateExternalUrl`, pure function
3. `crypto.ts` — `encryptSecret`/`decryptSecret` roundtrip
4. `agent-runner.ts` `estimateCostRub` — pure function
5. Budget gate logic in `runAgent` — mockable via injected DB helpers

**Vitest alias gap:** The root `vitest.config.ts` maps `@` to `apps/web/src`. TMA tests using `@/lib/...` imports would need either a separate vitest config in `apps/tg-miniapp/` or the root alias extended.

---

*Testing analysis: 2026-06-02*
