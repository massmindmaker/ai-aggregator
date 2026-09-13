# Gateway Settlement Recovery Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a default-disabled worker that discovers a finite historical window of already recorded stored-chat successes and invokes the accepted `aiag_recover_gateway_http_settlement_v1` once per hint without creating a second financial algorithm.

**Architecture:** A pure loop owns the in-memory tuple cursor, tick accounting, serial scheduling, and stop semantics. A dedicated native `pg.Pool` capability owns the three prepared SQL statements and connection lifecycle; a separate bootstrap module validates settings before the dynamic database import and is the only recovery-specific logger boundary used by `apps/worker/src/index.ts`.

**Tech Stack:** TypeScript, Vitest, Bun 1.4.2, Node.js worker runtime, `pg@8.20.0`, `@types/pg@8.11.6`, guarded local PostgreSQL.

**Spec:** [gateway admission](2026-09-07-gateway-charge-admission.md), [mounted stored-chat acceptance](2026-09-08-stored-chat-public-cutover.md), [terminal recovery](2026-09-08-http-terminal-recovery.md), [programme](2026-09-07-production-continuation.md), and final migration `packages/database/migrations/0071_gateway_http_recovery_validation.sql`.

**Design gate: APPROVED_FOR_IMPLEMENTATION.** Candidate `ecfa54e` passed independent financial/spec and design-quality re-review: I1-I6 addressed, zero Critical/Important findings. Implement Tasks 1-3 in order with independent source review after each; runtime activation remains outside this approval.

## Global Constraints

- Canonical root is `/home/bob/Projects/ai-aggregator`; Arena and Agents Market remain outside this work.
- Source and owned local guarded tests only. No production DB or migration, provider network, paid API, runtime setting change, credentials output, push, or deployment.
- Existing migrations `0066`-`0072`, the final `0071` function, gateway wrappers, provider adapters, pricing, outcomes/results, admission/cancellation/refund functions, and runtime env files are unchanged.
- SQL values are prepared. The selector takes no row/advisory/financial lock and returns hints only. Each hint is one separate autocommit call to `aiag_recover_gateway_http_settlement_v1`; only that function reacquires organization/advisory/admission ownership and calls the accepted settlement writer.
- The worker never calls a provider, grants or mints an admission, records or edits an outcome/result, cancels a hold, recreates a response, estimates usage, or writes money/quota/receipts directly.
- All heavy commands run one at a time under `flock /tmp/ai-ecosystem-build.lock` through `/tmp/ai-ecosystem-run aggregator`. A native test calls `assertTestDatabaseEnvironment(process.env)` before opening/importing a production database capability and enters `withGuardedTestDatabase` so connected identity and marker pass before any mutation.
- Native fixtures use fresh UUID-owned users, organizations, keys, requests, admissions, and quota facts; verify a foreign sentinel and clean every owned row/resource even when setup fails. Use accepted public fixture APIs and legal state transitions. Never disable immutable triggers or backdate admission, dispatch, outcome, settlement, quota, or receipt facts to manufacture a case.
- Existing HTTP result-retention fixture setup may create an expired tombstone using the already accepted guarded delete/reinsert + expiry-function pattern; it must not alter admission/outcome financial timestamps or weaken immutability.
- Worker production TypeScript, dedicated test TypeScript, focused Vitest, scoped ESLint, focused native evidence, the amended root database baseline, and one final worker build are required. A previous baseline is context, not evidence for this change.
- Every task ends in its own commit and independent review. Preserve adjacent TON/catalog edits and all unrelated tracked/untracked files.

## Frozen startup and PostgreSQL contract

`GATEWAY_SETTLEMENT_RECOVERY_MODE` accepts absent/`disabled` as disabled and exact `stored_chat_v1` as enabled. Any other value becomes the fixed recovery startup refusal. The bootstrap order is mandatory and does not import the API-gateway config singleton:

1. `apps/worker/src/index.ts` calls `loadSharedEnv()`.
2. Recovery bootstrap parses `GATEWAY_SETTLEMENT_RECOVERY_MODE` first.
3. Absent/`disabled` returns `null` immediately, before reading or validating `GATEWAY_HTTP_EXECUTION_MODE`/`DATABASE_URL`, before dynamic import of the DB module or `pg`, and with zero recovery pool/query/timer/log activity.
4. Exact `stored_chat_v1` next requires exact `GATEWAY_HTTP_EXECUTION_MODE=stored_chat_only`. Missing, `legacy`, or any other value throws the same fixed sanitized startup error before reading/parsing `DATABASE_URL`, dynamic DB/`pg` import, pool creation, query, or timer.
5. Only then validate `DATABASE_URL`: the raw value must be nonempty without surrounding whitespace; `new URL` must parse it; protocol is exactly `postgres:` or `postgresql:`; hostname and a non-root database pathname are present; fragment is absent. Iterate every decoded query key case-insensitively and reject any occurrence, including an equal-valued or duplicate occurrence, of `statement_timeout`, `query_timeout`, `connect_timeout`, or `options`.
6. Only after all pure validation succeeds dynamically import `gateway-settlement-recovery-db.js`, create the capability, and start its immediate tick. The bootstrap invokes the shared pure URL parser from `gateway-settlement-recovery.ts`, which never imports `pg`; after the dynamic import, the DB factory defensively invokes that same parser again before constructing `Pool`. If anything fails after the capability has been returned, await its close and discard both raw failures before throwing one `GatewaySettlementRecoveryBoundaryError("startup_refused")` with no `cause`. The DB factory itself constructs `Pool` only after its repeated validation and has no fallible initialization step after construction, so it cannot orphan a pool before returning the capability.

The DB factory receives the validated opaque URL, repeats validation without logging or rewriting it, and constructs exactly:

```ts
new Pool({
  connectionString: databaseUrl,
  max: 1,
  connectionTimeoutMillis: 8_000,
  statement_timeout: 8_000,
  query_timeout: 9_000,
  options: "-c statement_timeout=8000",
});
```

The explicit capability-owned `options` prevents ambient `PGOPTIONS` from supplying server options; forbidden URL keys cannot overwrite these values when `pg@8.20.0` parses `connectionString`. Do not forward `process.env.PGOPTIONS` or accept timeout overrides.

Every adapter statement uses `Pool.query({ text, values })` directly; `pool.connect()` and manually released clients are forbidden. On query timeout/connection loss, `pg-pool` releases with the caught error and removes that client before the returned promise rejects. The adapter awaits that promise, so the loop cannot begin another candidate until the ambiguous connection has been discarded. Timeout, connection loss, malformed ACK, and any other thrown recovery error are `unconfirmed`; they never prove rollback or no effect.

The capability tracks at most one active query, rejects a new query after closing begins, and implements `close()` as a non-`async` memoized promise: mark closing, await the current adapter promise (swallowing its already-classified failure), then call `pool.end()` exactly once. The runner close marks stopping and clears the timer first, waits its in-flight tick, then invokes this capability close. Two simultaneous close calls return the same promise.

## Exact interfaces

Task owners implement these names and readonly shapes exactly in `apps/worker/src/queues/gateway-settlement-recovery.ts`, unless a comment names another owner file:

```ts
export type CanonicalRecoveryUuid = string;
export type CanonicalRecoveryTimestamp = string; // exact YYYY-MM-DDTHH:mm:ss.ffffffZ

export type GatewaySettlementRecoveryMode = "disabled" | "stored_chat_v1";
export type GatewaySettlementRecoveryTickClassification =
  | "complete"
  | "partial_unconfirmed"
  | "selection_unavailable"
  | "stopped";

export type GatewaySettlementRecoveryPosition = Readonly<{
  reconcileAt: CanonicalRecoveryTimestamp;
  billingRequestId: CanonicalRecoveryUuid;
}>;

export type GatewaySettlementRecoveryCycle = Readonly<{
  cycleDueBefore: CanonicalRecoveryTimestamp;
  after: GatewaySettlementRecoveryPosition | null;
  upper: GatewaySettlementRecoveryPosition;
}>;

export type GatewaySettlementRecoveryHint = GatewaySettlementRecoveryPosition &
  Readonly<{
    orgId: CanonicalRecoveryUuid;
    apiKeyId: CanonicalRecoveryUuid;
  }>;

export type GatewaySettlementRecoverySelectorPage = Readonly<{
  hints: readonly GatewaySettlementRecoveryHint[];
}>;

export type GatewaySettlementRecoveryAck = Readonly<{
  orgId: CanonicalRecoveryUuid;
  apiKeyId: CanonicalRecoveryUuid;
  billingRequestId: CanonicalRecoveryUuid;
  state: "settled";
  routeKind: "chat";
  billingMode: "stored";
  outcomeKind: "success";
}>;

export type GatewaySettlementRecoveryTickResult = Readonly<{
  classification: GatewaySettlementRecoveryTickClassification;
  selected: number;
  attempted: number;
  settled: number;
  unconfirmed: number;
  deferred: number;
  cursor: GatewaySettlementRecoveryCycle | null;
}>;

export interface GatewaySettlementRecoveryDb {
  captureCycle(): Promise<Readonly<{
    cycleDueBefore: CanonicalRecoveryTimestamp;
    upper: GatewaySettlementRecoveryPosition;
  }> | null>;
  selectPage(input: Readonly<{
    cycleDueBefore: CanonicalRecoveryTimestamp;
    after: GatewaySettlementRecoveryPosition | null;
    upper: GatewaySettlementRecoveryPosition;
    limit: 20;
  }>): Promise<GatewaySettlementRecoverySelectorPage>;
  recover(hint: GatewaySettlementRecoveryHint): Promise<GatewaySettlementRecoveryAck>;
  close(): Promise<void>;
}

export interface GatewaySettlementRecoveryLoop {
  runTick(isStopping: () => boolean): Promise<GatewaySettlementRecoveryTickResult>;
  getCursor(): GatewaySettlementRecoveryCycle | null;
}

export interface GatewaySettlementRecoveryScheduler {
  setTimeout(callback: () => void, delayMs: 60_000): unknown;
  clearTimeout(handle: unknown): void;
}

export interface GatewaySettlementRecoveryHandle {
  close(): Promise<void>;
}

export function parseGatewaySettlementRecoveryMode(
  raw: string | undefined,
): GatewaySettlementRecoveryMode;

export function parseGatewaySettlementRecoveryDatabaseUrl(raw: string): string;

export function createGatewaySettlementRecoveryLoop(
  db: GatewaySettlementRecoveryDb,
): GatewaySettlementRecoveryLoop;

export function startGatewaySettlementRecovery(input: Readonly<{
  db: GatewaySettlementRecoveryDb;
  scheduler: GatewaySettlementRecoveryScheduler;
  onTick: (result: GatewaySettlementRecoveryTickResult) => void;
}>): GatewaySettlementRecoveryHandle;
```

Task 3 owns these exact exports in `apps/worker/src/gateway-settlement-recovery-bootstrap.ts`:

```ts
export type GatewaySettlementRecoveryStartupConfig =
  | Readonly<{ mode: "disabled" }>
  | Readonly<{
      mode: "stored_chat_v1";
      httpExecutionMode: "stored_chat_only";
      databaseUrl: string;
    }>;

export type GatewaySettlementRecoveryLogger = Pick<
  import("./logger.js").Logger,
  "info" | "warn" | "error" | "fatal"
>;

export class GatewaySettlementRecoveryBoundaryError extends Error {
  readonly classification: "startup_refused";
  constructor(classification: "startup_refused");
}

export function parseGatewaySettlementRecoveryStartupConfig(
  env: Readonly<Record<string, string | undefined>>,
): GatewaySettlementRecoveryStartupConfig;

export async function startGatewaySettlementRecoveryFromEnv(input: Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  logger: GatewaySettlementRecoveryLogger;
  scheduler?: GatewaySettlementRecoveryScheduler;
  loadDb?: (databaseUrl: string) => Promise<GatewaySettlementRecoveryDb>;
}>): Promise<GatewaySettlementRecoveryHandle | null>;

export function logGatewaySettlementRecoveryBoundaryFailure(
  logger: Pick<GatewaySettlementRecoveryLogger, "fatal">,
  error: unknown,
): boolean;
```

Production omits `scheduler` and `loadDb`; defaults are native `setTimeout`/`clearTimeout` and the dynamic import plus `createGatewaySettlementRecoveryDb`. `parseGatewaySettlementRecoveryStartupConfig` performs the first URL validation through the pure core parser; it must not statically import the DB module. The URL parser returns the original opaque string unchanged on success and otherwise throws only `Error("invalid gateway settlement recovery database URL")`, with no input or `cause`. `GatewaySettlementRecoveryBoundaryError` always has name `GatewaySettlementRecoveryBoundaryError`, message `gateway settlement recovery startup refused`, and no raw error, `cause`, URL, SQL, row, or driver diagnostic. The returned bootstrap handle catches a close error, logs only `{ component: "gateway_settlement_recovery", classification: "close_unavailable" }` with message `gateway settlement recovery close unavailable`, and resolves after the single close attempt so shutdown never emits the raw error.

`logGatewaySettlementRecoveryBoundaryFailure` returns `true` only for the fixed boundary error and calls the actual Pino `fatal` seam with only `{ component: "gateway_settlement_recovery", classification: "startup_refused" }` and its fixed message. `index.ts` keeps its existing raw fatal branch only for unrelated bootstrap failures.

## Exact SQL owned by Task 2

Export the following three constants from `gateway-settlement-recovery-db.ts`. SQL aliases and parameter order are contract, and unit tests compare normalized whitespace plus the exact values arrays.

```sql
-- CAPTURE_GATEWAY_SETTLEMENT_RECOVERY_CYCLE_SQL; values: []
WITH cutoff AS (
  SELECT clock_timestamp() AS cycle_due_before
)
SELECT
  to_char(cutoff.cycle_due_before AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cycle_due_before,
  to_char(candidate.reconcile_after AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS upper_reconcile_at,
  candidate.billing_request_id::text AS upper_billing_id
FROM cutoff
CROSS JOIN LATERAL (
  SELECT admission.reconcile_after, admission.billing_request_id
  FROM gateway_charge_admissions AS admission
  JOIN gateway_http_requests AS request
    ON request.org_id = admission.org_id
   AND request.api_key_id = admission.api_key_id
   AND request.billing_request_id = admission.billing_request_id
  JOIN gateway_http_results AS http_result
    ON http_result.org_id = admission.org_id
   AND http_result.api_key_id = admission.api_key_id
   AND http_result.billing_request_id = admission.billing_request_id
  JOIN gateway_charge_quota_contexts AS quota
    ON quota.org_id = admission.org_id
   AND quota.api_key_id = admission.api_key_id
   AND quota.billing_request_id = admission.billing_request_id
  WHERE admission.state = 'outcome_recorded'
    AND admission.outcome_kind = 'success'
    AND admission.route_kind = 'chat'
    AND admission.billing_mode = 'stored'
    AND admission.reconcile_after IS NOT NULL
    AND admission.reconcile_after <= cutoff.cycle_due_before
    AND admission.outcome_recorded_at IS NOT NULL
    AND admission.outcome_recorded_at <= cutoff.cycle_due_before
    AND request.contract_version = 1
    AND request.route_kind = 'chat'
    AND request.billing_mode = 'stored'
    AND http_result.contract_version = 1
    AND http_result.http_status = 200
    AND http_result.content_type = 'application/json'
    AND quota.quota_version = 2
    AND NOT EXISTS (
      SELECT 1
      FROM gateway_http_rejections AS rejection
      WHERE rejection.org_id = admission.org_id
        AND rejection.api_key_id = admission.api_key_id
        AND rejection.billing_request_id = admission.billing_request_id
    )
  ORDER BY admission.reconcile_after DESC, admission.billing_request_id DESC
  LIMIT 1
) AS candidate;
```

```sql
-- SELECT_GATEWAY_SETTLEMENT_RECOVERY_PAGE_SQL
-- values: [cycleDueBefore, afterReconcileAtOrNull, afterBillingIdOrNull,
--          upperReconcileAt, upperBillingId, 20]
SELECT
  admission.org_id::text AS org_id,
  admission.api_key_id::text AS api_key_id,
  admission.billing_request_id::text AS billing_request_id,
  to_char(admission.reconcile_after AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS reconcile_at
FROM gateway_charge_admissions AS admission
JOIN gateway_http_requests AS request
  ON request.org_id = admission.org_id
 AND request.api_key_id = admission.api_key_id
 AND request.billing_request_id = admission.billing_request_id
JOIN gateway_http_results AS http_result
  ON http_result.org_id = admission.org_id
 AND http_result.api_key_id = admission.api_key_id
 AND http_result.billing_request_id = admission.billing_request_id
JOIN gateway_charge_quota_contexts AS quota
  ON quota.org_id = admission.org_id
 AND quota.api_key_id = admission.api_key_id
 AND quota.billing_request_id = admission.billing_request_id
WHERE admission.state = 'outcome_recorded'
  AND admission.outcome_kind = 'success'
  AND admission.route_kind = 'chat'
  AND admission.billing_mode = 'stored'
  AND admission.reconcile_after IS NOT NULL
  AND admission.reconcile_after <= $1::timestamptz
  AND admission.outcome_recorded_at IS NOT NULL
  AND admission.outcome_recorded_at <= $1::timestamptz
  AND request.contract_version = 1
  AND request.route_kind = 'chat'
  AND request.billing_mode = 'stored'
  AND http_result.contract_version = 1
  AND http_result.http_status = 200
  AND http_result.content_type = 'application/json'
  AND quota.quota_version = 2
  AND NOT EXISTS (
    SELECT 1
    FROM gateway_http_rejections AS rejection
    WHERE rejection.org_id = admission.org_id
      AND rejection.api_key_id = admission.api_key_id
      AND rejection.billing_request_id = admission.billing_request_id
  )
  AND (
    $2::timestamptz IS NULL
    OR (
      $3::uuid IS NOT NULL
      AND (admission.reconcile_after, admission.billing_request_id)
        > ($2::timestamptz, $3::uuid)
    )
  )
  AND (admission.reconcile_after, admission.billing_request_id)
    <= ($4::timestamptz, $5::uuid)
ORDER BY admission.reconcile_after ASC, admission.billing_request_id ASC
LIMIT $6::integer;
```

```sql
-- RECOVER_GATEWAY_HTTP_SETTLEMENT_SQL
-- values: [orgId, apiKeyId, billingRequestId]
SELECT
  recovered.org_id::text AS org_id,
  recovered.api_key_id::text AS api_key_id,
  recovered.billing_request_id::text AS billing_request_id,
  recovered.state::text AS state,
  recovered.route_kind::text AS route_kind,
  recovered.billing_mode::text AS billing_mode,
  recovered.outcome_kind::text AS outcome_kind
FROM aiag_recover_gateway_http_settlement_v1(
  $1::uuid,
  $2::uuid,
  $3::uuid
) AS recovered;
```

Capture accepts exactly zero or one plain row with exactly `cycle_due_before`, `upper_reconcile_at`, and `upper_billing_id`, requires `upper_reconcile_at <= cycle_due_before`, and maps zero rows to `null`. Page accepts `rowCount === rows.length`, at most 20 plain rows, and exactly `org_id`, `api_key_id`, `billing_request_id`, `reconcile_at` per row. Recovery ACK accepts `rowCount === 1`, one plain row, and exactly the seven projected fields. Normalize UUIDs to lower-case canonical form and require timestamps in exact UTC six-microsecond form; never round-trip timestamps through `Date`.

The capture and page eligibility predicates are deliberately identical apart from bound/cursor clauses. There is no join to `gateway_api_keys` and no predicate on `gateway_api_keys.revoked_at` or `gateway_api_keys.disabled_at`: both revoked and disabled same-owner obligations remain recoverable, while final SQL remains the authority for ownership and immutable evidence.

## Finite historical window, ordering, and tick invariants

At cycle creation, the capture statement obtains one server `cycleDueBefore` and the greatest eligible `(reconcile_after, billing_request_id)` among rows satisfying both `reconcile_after <= cycleDueBefore` and `outcome_recorded_at <= cycleDueBefore`. All later pages reuse that exact cutoff, require tuple `> after` when a cursor exists and tuple `<= upper`, order by the tuple ascending, and limit 20.

This is a finite historical eligibility window, not a repeatable-read transaction or an MVCC snapshot held across ticks. A transaction that records an outcome after the cutoff receives a later `outcome_recorded_at` and must wait for the next cycle even when its former dispatched `reconcile_after` was old. A transaction that executed the accepted outcome write before the cutoff but commits after capture may become visible in a later page of the current cycle if its tuple lies inside the frozen bounds. Such late commits come only from the finite set of pre-cutoff writes; post-cutoff outcome churn cannot extend the window. Final SQL still decides whether any visible hint is settleable.

The pure parser compares canonical timestamps by direct code-unit order only because the fixed UTC six-digit format preserves chronological order. If timestamps are equal, it removes UUID hyphens, decodes the 32 lower-case hex digits to 16 bytes, and compares those bytes unsigned in order, matching PostgreSQL UUID order. Locale comparison and JavaScript `Date` comparison are forbidden.

One tick performs at most one page and begins at most 20 recovery calls, sequentially. Validate the complete page, including exact shapes, unique triples, strict tuple ascent, `> after`, `<= upper`, and the fixed cutoff, before the first recovery call. A capture result of `null` means no eligible row and returns `complete` with zero counts and a `null` cursor. A capture failure/malformed capture returns `selection_unavailable` with zero counts and no cycle installed. A page query failure or malformed page returns `selection_unavailable` with zero counts, makes zero recovery calls, and leaves the complete existing cycle/cursor unchanged. A valid empty page closes its cycle and returns `complete` with zero counts and a `null` cursor.

For every valid page:

- `selected` is the count of validated hints returned by the page.
- `attempted` increments immediately before each `recover` call begins.
- `settled` increments only for a strict ACK matching that hint's org/key/billing triple and exact `settled/chat/stored/success` constants.
- A thrown error, timeout/lost connection, or malformed/mismatched ACK increments `unconfirmed`.
- `deferred` is the validated suffix not attempted because stop was observed.
- Always `attempted = settled + unconfirmed`, `selected = attempted + deferred`, and `0 <= selected <= 20`.
- Advance `after` only after an attempted candidate returns a strict ACK or a caught unknown error. Never advance over a shutdown-deferred row.
- After processing, reset the cycle only when the valid page is short/empty or its last attempted tuple equals `upper`. A full 20-row page below `upper` retains the cycle; if the upper row disappears or settles, the next empty/short page closes it. A failed selection retains it.
- Classification precedence is exact: `selection_unavailable` for capture/page failure; otherwise `stopped` when `deferred > 0` or stop prevents the next capture/page; otherwise `partial_unconfirmed` when `unconfirmed > 0`; otherwise `complete`.

An old failed prefix is advanced as `unconfirmed`, so later hints in the frozen window are attempted; after the finite window closes, the next cycle resets `after` and revisits any still-eligible earlier row. Restart loses only the in-memory cursor and safely begins a new cycle.

The bootstrap logger receives only the fixed classification and five counts. Exact mappings are:

| Classification | Pino method | Fixed message |
|---|---|---|
| `complete` | `info` | `gateway settlement recovery tick complete` |
| `partial_unconfirmed` | `warn` | `gateway settlement recovery tick unconfirmed` |
| `selection_unavailable` | `warn` | `gateway settlement recovery selection unavailable` |
| `stopped` | `info` | `gateway settlement recovery tick stopped` |

Bindings are exactly `{ component: "gateway_settlement_recovery", classification, selected, attempted, settled, unconfirmed, deferred }`. Never log the cursor, IDs, prompt, response, key, URL, SQL, row, original `Error`/`cause`, stack, or driver/upstream diagnostic.

## Scheduling and shutdown

`startGatewaySettlementRecovery` begins one immediate tick after enabled initialization. Only after that tick and `onTick` finish may it create one native `setTimeout` for 60,000 ms. The timer callback clears its own stored handle before starting the next tick. There is no `setInterval` and never more than one tick/query/candidate in flight.

`close()` memoizes one promise, sets `stopping=true` before clearing the pending timer, and waits the in-flight tick. A tick checks stop before capture, before page selection, and before every candidate. A candidate already started may finish and advances/counts according to its ACK; the remaining selected suffix is deferred. No page, candidate, or timer starts after stopping. After the tick resolves, close the DB capability once.

## Task 1: Pure loop, tuple cursor, counters, and scheduler

**Files:**

- Create: `apps/worker/src/queues/gateway-settlement-recovery.ts`
- Create: `apps/worker/src/queues/__tests__/gateway-settlement-recovery.test.ts`
- Create: `apps/worker/tsconfig.gateway-settlement-recovery-test.json`

**Interfaces:** Produces all core types plus `parseGatewaySettlementRecoveryMode`, the pure `parseGatewaySettlementRecoveryDatabaseUrl`, `createGatewaySettlementRecoveryLoop`, and `startGatewaySettlementRecovery` exactly as declared above. Consumes only platform `URL` plus the injected DB/scheduler/callback; no DB/provider/package import or bootstrap side effect.

- [ ] **Step 1 — RED tests and exact test config.** Create `apps/worker/tsconfig.gateway-settlement-recovery-test.json` extending `./tsconfig.json`, with `rootDir: "../.."`, `noEmit: true`, `declaration: false`, `declarationMap: false`, `types: ["node", "vitest/globals"]`, `include: ["src/queues/gateway-settlement-recovery.ts", "src/queues/__tests__/gateway-settlement-recovery.test.ts"]`, and `exclude: ["node_modules", "dist"]`; keep production `apps/worker/tsconfig.json` excluding tests. Add exact parser/tuple/page/tick/scheduler cases: absent/disabled/stored/invalid mode; the complete database URL matrix from the frozen startup contract, including fixed secret-free failure and unchanged successful return; invalid timestamp and UUID; same-millisecond microsecond order; PostgreSQL bytewise UUID order; null capture and valid empty/short/full pages; malformed capture/page rejected before recover; duplicate/out-of-range/out-of-order rows; new UUID numerically between cursor/upper, new UUID below cursor, and a formerly dispatched row whose outcome is recorded after cutoff all wait for the next cycle; a pre-cutoff write committed after capture may join only within frozen tuple bounds; upper disappearance; exact 20 then empty; failed old prefix followed by success then revisited next cycle; mismatched/lost ACK; stop before capture/page/candidate and during candidate; no next call before the first rejection settles; no overlapping timers; simultaneous closes return one promise and close DB once.
- [ ] **Step 2 — run RED.** From repository root run `flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator node node_modules/vitest/vitest.mjs run apps/worker/src/queues/__tests__/gateway-settlement-recovery.test.ts`. Expected: nonzero exit with missing exports/behavior; no DB connection.
- [ ] **Step 3 — minimal implementation.** Implement exact interfaces, canonical parsers/comparator, whole-page validation, cursor transitions, counter invariants, classification precedence, serial immediate/delayed scheduling, and memoized stop/close. No financial retry inside an item and no persisted recovery state.
- [ ] **Step 4 — GREEN and static checks.** Run `flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator node node_modules/vitest/vitest.mjs run apps/worker/src/queues/__tests__/gateway-settlement-recovery.test.ts` (exit 0), `flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator node node_modules/typescript/bin/tsc --noEmit -p apps/worker/tsconfig.json` (exit 0), `flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator node node_modules/typescript/bin/tsc --noEmit -p apps/worker/tsconfig.gateway-settlement-recovery-test.json` (exit 0), and `flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator node node_modules/eslint/bin/eslint.js --no-eslintrc -c packages/api-gateway/.eslintrc.cjs apps/worker/src/queues/gateway-settlement-recovery.ts apps/worker/src/queues/__tests__/gateway-settlement-recovery.test.ts` (exit 0).
- [ ] **Step 5 — commit/review boundary.** Commit only the two Task 1 source/test files plus the dedicated test tsconfig as `feat(worker): add bounded settlement recovery loop`; obtain independent TypeScript/spec approval before Task 2.

## Task 2: Native `pg` capability and guarded financial evidence

**Files:**

- Create: `apps/worker/src/queues/gateway-settlement-recovery-db.ts`
- Create: `apps/worker/src/queues/__tests__/gateway-settlement-recovery-db.test.ts`
- Create: `apps/worker/src/queues/__tests__/gateway-settlement-recovery.native.integration.test.ts`
- Modify: `apps/worker/tsconfig.gateway-settlement-recovery-test.json`
- Modify: `apps/worker/package.json`
- Modify: `bun.lock`
- Modify: root `package.json`, only the `test:database-baseline` file list
- Modify: Task 1 core/test only where the reviewed DB contract requires it

**Interfaces:** Consumes `GatewaySettlementRecoveryDb`, core readonly types, and the shared pure `parseGatewaySettlementRecoveryDatabaseUrl`. Produces the three exported SQL constants and `createGatewaySettlementRecoveryDb(databaseUrl: string): GatewaySettlementRecoveryDb`. The factory calls the shared parser before `new Pool`. The factory and constants have no API-gateway import.

- [ ] **Step 1 — exact dependency/config ownership.** Add exact runtime dependency `"pg": "8.20.0"` and exact dev dependency `"@types/pg": "8.11.6"` to `apps/worker/package.json`, then run `flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator bun install --offline --lockfile-only` and verify that only the worker workspace dependency map changed while resolved `pg@8.20.0`/`@types/pg@8.11.6` entries stayed fixed. Extend the existing `apps/worker/tsconfig.gateway-settlement-recovery-test.json` `include` with `src/queues/gateway-settlement-recovery-db.ts`, `src/queues/__tests__/gateway-settlement-recovery-db.test.ts`, and `src/queues/__tests__/gateway-settlement-recovery.native.integration.test.ts`; change no other compiler option and keep production `apps/worker/tsconfig.json` excluding tests.
- [ ] **Step 2 — exact root registration.** In root `package.json`, append `apps/worker/src/queues/__tests__/gateway-settlement-recovery.native.integration.test.ts` to the explicit Vitest file list inside `test:database-baseline`, before `&& bun run test:ton-core-native`; change no other script/token.
- [ ] **Step 3 — RED DB units.** Pass every URL case from the core parser matrix through the DB factory and assert rejection occurs before Pool construction, while a successful value reaches the exact Pool constructor object unchanged and ambient `PGOPTIONS` cannot replace `options`; verify exact SQL text/projections/value order; zero/one capture rows; strict page/ACK parser; direct `Pool.query` with no `connect`; timeout/error rejection only after the fake pool's disposal marker; second candidate starts after that marker; closing blocks new query; active query settles before one `pool.end`; simultaneous closes share one promise. Task 3 repeats the same matrix through the pre-import bootstrap boundary.
- [ ] **Step 4 — run unit RED.** Run `flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator node node_modules/vitest/vitest.mjs run apps/worker/src/queues/__tests__/gateway-settlement-recovery-db.test.ts`. Expected: nonzero exit with missing DB exports; no DB connection.
- [ ] **Step 5 — implement the native capability.** Copy the three SQL constants exactly, parse/normalize only the documented shapes, call `Pool.query({ text, values })` sequentially, and implement fixed constructor/active-query/memoized-close ownership. Do not mirror evidence validation or financial calculations in TypeScript.
- [ ] **Step 6 — native RED fixture.** At module top, gate on `RUN_NATIVE_DB_INTEGRATION === "1"` and call `assertTestDatabaseEnvironment` before any production DB import. Inside `withGuardedTestDatabase`, verify the connected marker, then dynamically import the accepted HTTP/admission wrappers and the new worker DB/loop. Build legal UUID-owned states through `claimGatewayHttpRequest`, `admitGatewayHttpCharge`, `markGatewayChargeDispatched`, and `recordGatewayHttpOutcome`; those calls are fixture setup only, never runner capabilities. Preserve a separately committed foreign sentinel and verify cleanup from another connection.
- [ ] **Step 7 — native financial/fairness cases.** Exercise the actual new selector, adapter, and loop with real PostgreSQL and injected scheduler: recorded success settles once; two worker pools race/replay to one settlement event, receipt set, and quota terminal effect; application-level lost ACK counts `unconfirmed`, then after closing that capability a newly created Pool replays with `settled`, while money/events/quota remain single; separate revoked-key and disabled-key outcomes both settle from immutable same-owner facts; accepted expired payload tombstone settles without recreating/extending payload; held, dispatched, cancelled, rejected, foreign-owner, missing-result, and missing-quota proof are excluded; a legal settlement failure leaves `outcome_recorded` and a later cycle settles; failed prefix does not starve later rows.
- [ ] **Step 8 — native cutoff truth without backdating.** Use two real connections: hold open an accepted outcome-write transaction, capture from the other connection, then commit. If the outcome write executed after `cycleDueBefore`, assert it waits for the next cycle even though the prior dispatch deadline was old. In a separate case execute the accepted outcome write before cutoff but delay commit until after capture; document/assert that it may join the current cycle only when its tuple falls within `after/upper`. Do not update protected timestamps directly, disable triggers, or claim snapshot membership.
- [ ] **Step 9 — run GREEN and static checks.** Run these commands separately, each expecting exit 0:

  ```bash
  flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator node node_modules/vitest/vitest.mjs run apps/worker/src/queues/__tests__/gateway-settlement-recovery.test.ts apps/worker/src/queues/__tests__/gateway-settlement-recovery-db.test.ts
  flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator bun run db:test:bootstrap
  flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator bun run db:test:migrate
  flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator env RUN_NATIVE_DB_INTEGRATION=1 node node_modules/vitest/vitest.mjs run --no-file-parallelism apps/worker/src/queues/__tests__/gateway-settlement-recovery.native.integration.test.ts
  flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator node node_modules/typescript/bin/tsc --noEmit -p apps/worker/tsconfig.json
  flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator node node_modules/typescript/bin/tsc --noEmit -p apps/worker/tsconfig.gateway-settlement-recovery-test.json
  flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator node node_modules/eslint/bin/eslint.js --no-eslintrc -c packages/api-gateway/.eslintrc.cjs apps/worker/src/queues/gateway-settlement-recovery.ts apps/worker/src/queues/gateway-settlement-recovery-db.ts apps/worker/src/queues/__tests__/gateway-settlement-recovery.test.ts apps/worker/src/queues/__tests__/gateway-settlement-recovery-db.test.ts apps/worker/src/queues/__tests__/gateway-settlement-recovery.native.integration.test.ts
  ```
- [ ] **Step 10 — commit/review boundary.** Commit only Task 2 files as `feat(worker): add native settlement recovery capability`; obtain independent TypeScript plus financial/spec approval before Task 3. The review must inspect guard-before-import ordering, unchanged immutable triggers/migrations, SQL/params, URL/Pool lifecycle, ACK counters, and cleanup.

## Task 3: Sanitized bootstrap, native index wiring, and acceptance record

**Files:**

- Create: `apps/worker/src/gateway-settlement-recovery-bootstrap.ts`
- Create: `apps/worker/src/__tests__/gateway-settlement-recovery-bootstrap.test.ts`
- Modify: `apps/worker/src/index.ts`
- Modify: `apps/worker/tsconfig.gateway-settlement-recovery-test.json` to include the bootstrap/test/index types
- After independent source/runtime-seam approval only, modify: `docs/product/acceptance/AG-P1-route-coverage.md`
- After independent source/runtime-seam approval only, modify: `docs/consolidation/2026-09-13-aggregator-only-handoff.md`

**Interfaces:** Consumes the Task 1 starter/scheduler/handle and Task 2 dynamic factory. Produces the exact startup config, sanitized boundary error, `startGatewaySettlementRecoveryFromEnv`, and actual Pino fatal helper declared above. `index.ts` owns only env-load order, passing `process.env`/`logger`, adding the non-null handle to its existing close list, and routing the fixed recovery startup error through the helper.

- [ ] **Step 1 — RED startup/logger tests and exact config extension.** Extend the dedicated test tsconfig `include` with `src/gateway-settlement-recovery-bootstrap.ts`, `src/__tests__/gateway-settlement-recovery-bootstrap.test.ts`, and `src/index.ts`; change no other compiler option. Cover disabled with poisoned gateway/DB values and prove no `loadDb`/pool/query/timer/log call; invalid recovery mode; enabled plus missing `GATEWAY_HTTP_EXECUTION_MODE`; enabled plus `legacy`; enabled plus an arbitrary value; enabled plus exact `stored_chat_only`; the complete URL matrix from the frozen startup contract before loader, including successful preservation of the original string; enabled schedule; setup failure after a returned capability closes once. Supply a credential-bearing URL and a synthetic loader/pool error whose message contains that URL and the recovery SQL, pass the caught boundary error through `logGatewaySettlementRecoveryBoundaryFailure`, and assert every captured actual logger binding/message serialization excludes credentials, URL, SQL, original message, `err`, `error`, `cause`, row, and stack.
- [ ] **Step 2 — run RED.** Run `flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator node node_modules/vitest/vitest.mjs run apps/worker/src/__tests__/gateway-settlement-recovery-bootstrap.test.ts`. Expected: nonzero exit with missing bootstrap exports; no DB connection.
- [ ] **Step 3 — implement bootstrap and logging.** Implement the six-step startup order, default dynamic DB loader, fixed tick method/message table, sanitized startup error, owned partial cleanup, and close-error sanitization. Test complete/partial-unconfirmed/selection-unavailable/stopped bindings and exact counter invariants through the `Logger` seam.
- [ ] **Step 4 — wire `index.ts` exactly.** Keep static imports free of `pg`; import only the pure bootstrap functions/types. Immediately after `loadSharedEnv()`, await `startGatewaySettlementRecoveryFromEnv({ env: process.env, logger })`; only enabled mode dynamically loads the DB. Add the non-null handle to the existing `workers` close array. In `main().catch`, call `logGatewaySettlementRecoveryBoundaryFailure(logger, err)` first; call the existing `logger.fatal({ err }, "worker bootstrap failed")` only when it returns false. No env file or mode value is changed.
- [ ] **Step 5 — shutdown/runtime seam tests.** With injected DB/scheduler/logger prove immediate then 60-second post-completion scheduling, setup cleanup, stop during an item counts the completed attempt and defers the suffix, no later page/candidate/timer, repeated close, pool close once, and fixed close failure logging without raw diagnostics. Do not start unrelated BullMQ workers in these tests.
- [ ] **Step 6 — GREEN focused/static checks.** Run these commands separately, each expecting exit 0:

  ```bash
  flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator node node_modules/vitest/vitest.mjs run apps/worker/src/queues/__tests__/gateway-settlement-recovery.test.ts apps/worker/src/queues/__tests__/gateway-settlement-recovery-db.test.ts apps/worker/src/__tests__/gateway-settlement-recovery-bootstrap.test.ts
  flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator node node_modules/typescript/bin/tsc --noEmit -p apps/worker/tsconfig.json
  flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator node node_modules/typescript/bin/tsc --noEmit -p apps/worker/tsconfig.gateway-settlement-recovery-test.json
  flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator node node_modules/eslint/bin/eslint.js --no-eslintrc -c packages/api-gateway/.eslintrc.cjs apps/worker/src/queues/gateway-settlement-recovery.ts apps/worker/src/queues/gateway-settlement-recovery-db.ts apps/worker/src/gateway-settlement-recovery-bootstrap.ts apps/worker/src/index.ts apps/worker/src/queues/__tests__/gateway-settlement-recovery.test.ts apps/worker/src/queues/__tests__/gateway-settlement-recovery-db.test.ts apps/worker/src/queues/__tests__/gateway-settlement-recovery.native.integration.test.ts apps/worker/src/__tests__/gateway-settlement-recovery-bootstrap.test.ts
  ```

- [ ] **Step 7 — final guarded composition.** Run these commands separately in order:

  ```bash
  flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator env RUN_NATIVE_DB_INTEGRATION=1 node node_modules/vitest/vitest.mjs run --no-file-parallelism apps/worker/src/queues/__tests__/gateway-settlement-recovery.native.integration.test.ts
  flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator bun run test:database-baseline
  flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator bun run --filter @aiag/worker build
  ```

  Expected: each exits 0; the amended baseline lists and executes the recovery native suite without skip. Do not present unchanged legacy suites as new financial proof; the new suite and composition checks are the evidence for this slice.
- [ ] **Step 8 — source/runtime review and records.** Obtain independent TypeScript/runtime-seam and financial/spec approval for the full Task 1-3 diff. Only after approval, update `AG-P1-route-coverage.md` and `2026-09-13-aggregator-only-handoff.md` with exact commit/check counts and remaining gates; do not create a second `AG-P1.md`.
- [ ] **Step 9 — commit/review boundary.** Commit bootstrap/index/tests/config as `feat(worker): wire settlement recovery bootstrap`; commit the two approved acceptance documents separately as `docs(aggregator): record settlement recovery evidence`. Do not activate the mode or start implementation of another gate.

## Remaining release gates

Source wiring is not runtime activation and does not prove deployment-wide `stored_chat_only`, legacy-writer drain, authoritative quota opening balances/policies, refund Tasks 3-5, complete route coverage, SSE/provider unknown-outcome reconciliation, Neon HTTP parity, paid-provider behavior, mainnet, external payments, public cutover, or production readiness. Recovery handles only already persisted plaintext stored-chat success evidence. Full routes and production/refund activation remain separately authorized and reviewed work.
