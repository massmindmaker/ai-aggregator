# Durable Batch Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `POST /v1/batches` a durable stored-billing container whose 202 owns every item, exact quote and hold, with one provider execution and one settlement per completed item.

**Architecture:** The gateway validates and prepares all items, then atomically creates the batch/items plus every item admission before enqueue. BullMQ carries only the owned batch id. A real worker loads durable item facts, reuses side-effect-free gateway execution primitives, and records/settles outcomes through the existing admission authority.

**Tech Stack:** TypeScript, Hono, postgres.js/PostgreSQL, BullMQ/Redis, Vitest, existing gateway admission/quota/recovery primitives.

**Spec:** `docs/superpowers/specs/2026-09-27-durable-batch-lifecycle-design.md`

## Global Constraints

- New mode: `stored_chat_embeddings_completions_stream_media_batches`; earlier stored modes keep batch POST 501 before state.
- V1 operations: homogeneous `chat | embeddings | completions`; 1..100 items; 2 MiB request cap.
- Stored billing only; no BYOK, media, STT, stream, tools, files/S3, webhooks or batch discount.
- A 202 requires one committed parent, immutable items and one confirmed held V2 admission per item.
- Queue payload is only `{ batchId }` with deterministic BullMQ job id; no body/org/key/quote/provider/secret.
- Post-dispatch uncertainty never redispatches or refunds automatically; it becomes reconciliation-required.
- Migration 0085 is additive; migrations <=0084 are immutable.
- No production activation, paid provider call, deploy, push/merge or production migration in this plan.
- Keep unrelated `.v2c/` and `.video_agent/` untouched.
- One heavy build/native gate at a time under `flock /tmp/ai-ecosystem-build.lock`.
- Execution method is Native with `superpowers:executing-plans`: TDD task-by-task, no fresh reviewer after each task, one whole-branch review after the complete package.

## Review Focus

- Item N admission failure after N-1 holds must roll back parent, items and every hold.
- Concurrent same-key POST must create one batch; same key with changed body must return conflict.
- Crash after dispatch confirmation must never create a second provider request.
- Batch execution must reject any provider response/usage shape that the direct route rejects.
- Duplicate queue/scanner delivery must preserve item state, counters and exactly-once settlement.

---
### Task 1: Strict batch HTTP identity and reusable body normalizers

**Files:**
- Create: `packages/api-gateway/src/billing/stored-batch-http-contract.ts`
- Create: `packages/api-gateway/src/billing/stored-batch-http-identity.ts`
- Modify: `packages/api-gateway/src/billing/stored-chat-http-identity.ts`
- Modify: `packages/api-gateway/src/billing/stored-embeddings-http-identity.ts`
- Modify: `packages/api-gateway/src/billing/stored-completions-http-identity.ts`
- Test: `packages/api-gateway/src/__tests__/stored-batch-http-identity.test.ts`
- Test: existing direct identity suites for chat/embeddings/completions

**Interfaces:**
- Produce `normalizeStoredChatBodyV1(body): { attemptBody; requestedMode }`.
- Produce `normalizeStoredEmbeddingsBodyV1(body): { attemptBody; requestedMode }`.
- Produce `normalizeStoredCompletionsBodyV1(body): { attemptBody; requestedMode }`.
- Produce `captureStoredBatchHttpIdentity({ body, idempotencyKey, declaredSessionId, byokKeyPresent }): StoredBatchHttpIdentity`.
- Produce `captureStoredBatchHttpRequest(request): Promise<{ identity: StoredBatchHttpIdentity }>`.
- `StoredBatchHttpIdentity` pins contractVersion 5, type, ordered items, session id, key digest and parent/item fingerprints.

- [ ] **Step 1: Add failing identity tests**
  Assert: exact top-level/item keys, 1..100 items, unique safe `custom_id`, homogeneous type, 2 MiB cap, malformed UTF-8/JSON, missing/bad idempotency key, BYOK header, changed ordered body fingerprint, session-id participation, and direct-normalizer parity.

- [ ] **Step 2: Run RED**
  Run: `npx vitest run packages/api-gateway/src/__tests__/stored-batch-http-identity.test.ts`
  Expected: FAIL because batch contract/identity exports do not exist.

- [ ] **Step 3: Extract pure direct-route body normalizers**
  Move only body parsing/normalization from the three identity modules into exported pure functions; keep direct HTTP identity outputs byte-for-byte compatible with existing tests.

- [ ] **Step 4: Implement batch bounded reader + canonical identity**
  Use a streaming 2 MiB reader before JSON parse, exact key allowlists, parent SHA-256 key digest/fingerprint, and per-item fingerprints from parent identity + index + custom_id + normalized body.

- [ ] **Step 5: Run GREEN + direct regressions**
  Run the new batch identity test plus the three existing direct identity suites.
  Expected: all PASS.

- [ ] **Step 6: Commit**
  `git commit -m "feat(batch): add strict durable batch identity"`

### Task 2: Shared serializable execution preparation with direct-route parity

**Files:**
- Create: `packages/api-gateway/src/billing/stored-chat-execution-preparation.ts`
- Create: `packages/api-gateway/src/billing/stored-embeddings-execution-preparation.ts`
- Create: `packages/api-gateway/src/billing/stored-batch-item-preparation.ts`
- Modify: `packages/api-gateway/src/billing/stored-chat-attempt.ts`
- Modify: `packages/api-gateway/src/billing/stored-embeddings-attempt.ts`
- Modify: `packages/api-gateway/src/billing/stored-chat-attempt-contract.ts`
- Modify: `packages/api-gateway/src/billing/stored-embeddings-attempt-contract.ts`
- Test: `packages/api-gateway/src/__tests__/stored-batch-item-preparation.test.ts`
- Test: existing stored chat/embeddings/completions attempt suites

**Interfaces:**
- Produce `prepareStoredChatExecution(args): StoredChatExecutionPreparation` for route kind `chat | completions`.
- Produce `prepareStoredEmbeddingsExecution(args): StoredEmbeddingsExecutionPreparation`.
- Each preparation is serializable authority: billingRequestId, attemptId, admissionArgs, pricingSnapshot, adapterKey, pinned upstream/model facts, provider request and normalized body; it contains no secret and performs no DB/provider work.
- Produce pinned evidence helpers that compute/validate usage from the persisted pricing snapshot, and make direct attempts use the same helpers.
- Produce `prepareStoredBatchItems({ identity, key, requestId, deadlineAt }): Promise<readonly StoredBatchPreparedItem[]>`; all items prepare before any write.

- [ ] **Step 1: Add failing parity tests**
  For the same direct body and batch item, assert exact route kind, authorized max, quote snapshot, supplier quote, pricing snapshot, provider request and evidence/actual-cost equality. Include invalid provider response/usage shapes from Review Focus.

- [ ] **Step 2: Run RED**
  Expected: FAIL because preparation APIs do not exist.

- [ ] **Step 3: Extract preparation from direct attempts**
  Refactor without changing their public result types. Direct `createStoredChatAttempt` and `createStoredEmbeddingsAttempt` must call the new preparation functions before admission.

- [ ] **Step 4: Extract pinned evidence capture**
  Make both direct attempts and future batch runtime validate usage/result against the same persisted pricing facts; do not let worker recalculate from mutable catalog pricing.

- [ ] **Step 5: Implement batch item preparation**
  Resolve fresh model/policy per item using existing fresh resolver/policy modules, reject proxy-required candidates, allocate unique billing/attempt UUIDs, and return immutable serializable preparations only after all items are valid.

- [ ] **Step 6: Run GREEN + direct regressions**
  Run new preparation tests and existing stored chat/embeddings/completions attempt suites.
  Expected: all PASS with unchanged direct-route behavior.

- [ ] **Step 7: Commit**
  `git commit -m "refactor(gateway): share stored execution preparation"`

### Task 3: Migration 0085 and atomic batch/admission storage

**Files:**
- Create: `packages/database/migrations/0085_gateway_durable_batches.sql`
- Modify: `packages/database/src/schema/gateway.ts`
- Modify: `packages/database/scripts/__tests__/native-baseline.integration.test.ts`
- Create: `packages/database/scripts/__tests__/gateway-durable-batches.native.integration.test.ts`
- Create: `packages/api-gateway/src/billing/stored-batch-storage.ts`
- Modify if required for transaction typing only: `packages/api-gateway/src/lib/db.ts`
- Test: `packages/api-gateway/src/__tests__/stored-batch-storage.test.ts`

**Interfaces:**
- Produce `createOrReplayStoredBatch(args, client = sql): Promise<{ kind: 'created' | 'replay'; batch: StoredBatchRead }>`.
- Produce `readStoredBatch(orgId, batchId, client?): Promise<StoredBatchRead | null>`.
- Produce `readStoredBatchResults(orgId, batchId, cursor, limit, client?): Promise<StoredBatchResultPage>`.
- Produce DB helpers for worker ownership: `claimNextStoredBatchItem`, `loadStoredBatchItem`, `markStoredBatchItemTerminal`, `refreshStoredBatchAggregate`, `markStoredBatchQueueRecoveryNeeded`, `listRecoverableStoredBatches`.
- `refreshStoredBatchAggregate` derives status/counters/settled microcredits from `batch_items` + existing admissions; legacy parent counters are caches, never independent authority.
- New parent uniqueness must make `org_id + contract_version + billing_mode + idempotency_key_digest` one durable identity.
- New `batch_items` owns one unique `billing_request_id` per item and exact pinned request/candidate/quote fields.

- [ ] **Step 1: Add failing migration/native tests**
  Assert migration count85, historical <=0084 hashes unchanged, additive parent columns/table/indexes, parent/item uniqueness, org-scoped reads and no secret columns.

- [ ] **Step 2: Run RED migration tests**
  Expected: FAIL because migration0085/table/columns do not exist.

- [ ] **Step 3: Add migration + Drizzle schema**
  Preserve historical columns for compatibility; add contract metadata and `batch_items` exactly as the spec.

- [ ] **Step 4: Add failing atomic-admission test**
  In a real guarded DB transaction create a multi-item batch where item N fails funds/quota after earlier admission calls. Assert zero new parent/items/admissions/reservations/ledger after rollback. Add same-key concurrent replay and changed-fingerprint conflict cases.

- [ ] **Step 5: Implement `createOrReplayStoredBatch`**
  Use one postgres.js transaction. Claim/lock parent identity first; replay exits without new UUID/admission use. For a new parent, insert items and call existing `admitGatewayChargeV2(item.admissionArgs, tx)` for each item inside the same transaction; verify every returned admission is held and matches its immutable item before commit.

- [ ] **Step 6: Implement read/worker storage helpers**
  All SQL is prepared/tagged, org scope applies to public reads, worker claims use row locking/skip-locked or equivalent single-owner semantics, and terminal writes are idempotent.

- [ ] **Step 7: Run GREEN native + storage tests**
  Run migration test, new native batch DB test and storage unit tests under guarded runtime.
  Expected: all PASS; migration applies once then no-op.

- [ ] **Step 8: Commit**
  `git commit -m "feat(database): persist and admit durable batches"`

### Task 4: Stored batch route, mode composition and ID-only queue producer

**Files:**
- Create: `packages/api-gateway/src/lib/batch-queue.ts`
- Create: `packages/api-gateway/src/routes/v1/stored-batches.ts`
- Modify: `packages/api-gateway/src/config.ts`
- Modify: `packages/api-gateway/src/server.ts`
- Modify: `packages/api-gateway/src/catalog/public-catalog.ts` only to recognize the new execution mode without advertising unsupported operation metadata
- Test: `packages/api-gateway/src/__tests__/stored-batches-composition.test.ts`
- Test: `packages/api-gateway/src/__tests__/server.test.ts`
- Test: `packages/api-gateway/src/__tests__/public-catalog.test.ts`
- Test: `tests/config/vitest-discovery.test.ts`

**Interfaces:**
- Produce `enqueueOwnedBatch(batchId: string): Promise<void>` using queue `batch-process`, payload exactly `{ batchId }`, deterministic job id `batch-<internal-or-opaque-stable-id>`.
- Produce Hono `storedBatches` route with POST, summary GET and results GET.
- POST flow: capture identity -> durable replay read -> prepare all items -> atomic create/admit -> enqueue -> response.
- New mode includes all previously accepted chat/embeddings/completions/stream/media behavior plus stored batches.

- [ ] **Step 1: Add RED composition/queue tests**
  Assert old stored modes POST batches ->501 with zero storage/queue; new mode mounts POST; queue data contains only batchId; missing Redis ACK maps to fixed503; GET never enqueues/providers.

- [ ] **Step 2: Run RED**
  Expected: FAIL because new mode/route/queue helper do not exist.

- [ ] **Step 3: Add config/mode composition**
  Extend the exact enum/compatibility checks in config/server/catalog. Do not change default `legacy`. New mode must inherit media and stream behavior.

- [ ] **Step 4: Implement route**
  First create returns202 only after atomic storage/admission and successful enqueue. Enqueue failure after commit calls `markStoredBatchQueueRecoveryNeeded` then returns503. Same-key nonterminal replay may restore missing queue ownership and returns202; terminal replay returns200 stored summary. Changed replay returns409. Summary/results GET use only Task3 DB reads.

- [ ] **Step 5: Run GREEN**
  Run route/composition/server/catalog/config tests.
  Expected: all PASS and older-mode boundaries unchanged.

- [ ] **Step 6: Commit**
  `git commit -m "feat(gateway): mount durable stored batches"`

### Task 5: Side-effect-free batch runtime and real worker consumer

**Files:**
- Create: `packages/api-gateway/src/batch-runtime.ts`
- Modify: `packages/api-gateway/package.json`
- Modify: `packages/api-gateway/tsup.config.ts`
- Create: `packages/api-gateway/src/__tests__/batch-runtime.test.ts`
- Create: `apps/worker/src/queues/batch-process.ts`
- Create: `apps/worker/src/queues/__tests__/batch-process.test.ts`
- Modify: `apps/worker/src/index.ts`
- Modify: `apps/worker/package.json`

**Interfaces:**
- Add package subpath export `@aiag/api-gateway/batch-runtime`; importing it must not import `server.ts`, Hono bootstrap, CORS/middleware, or register legacy gateway app side effects.
- Produce `preparePinnedStoredBatchRuntime(item): StoredBatchRuntimePreparation | null`; it captures reviewed admitted mechanics and validates persisted provider request/pinned facts before dispatch.
- Produce `runStoredBatchWorkerStep(batchId): Promise<{ kind: 'requeue' | 'idle' | 'terminal' }>`; this is the sole batch provider-execution orchestration called by worker.
- Produce `startBatchProcessWorker(connection, deps?)`; BullMQ consumes only `{ batchId }`.

- [ ] **Step 1: Add RED import-boundary/runtime tests**
  Assert subpath import does not load server/bootstrap; missing/mismatched adapter mechanics returns pre-dispatch unavailable; valid chat/embeddings/completions preparations bind the exact persisted provider request and pricing facts.

- [ ] **Step 2: Add RED worker lifecycle tests**
  Cover one successful item, pre-dispatch provider-config unavailability, expired held item, post-dispatch provider throw, invalid usage/response, duplicate delivery, and lost settlement ACK. Review-focus assertion: once dispatch was granted, retry never calls provider again.

- [ ] **Step 3: Run RED**
  Expected: FAIL because batch runtime and worker do not exist.

- [ ] **Step 4: Add side-effect-free package entry**
  Build `src/batch-runtime.ts` as its own tsup entry/subpath export. It may import billing/upstream/storage primitives but never `index.ts`, `server.ts` or route modules.

- [ ] **Step 5: Implement worker step**
  Claim one durable item. If expired while held, cancel existing admission then mark failed zero-cost. Otherwise preflight mechanics/config first, confirm existing dispatch using the persisted attempt/upstream/pricing snapshot, execute provider at most once, capture pinned evidence, record outcome, settle, then mark item completed and refresh the parent aggregate. V1 marks `failed` only for proven pre-dispatch terminal/cancel/expiry paths; any error or uncertainty from dispatch invocation onward marks item reconciliation-required and preserves the hold; no redispatch.

- [ ] **Step 6: Implement BullMQ consumer/bootstrap**
  Worker invokes one step, requeues the same batch id when more runnable work remains, and never accepts body/org/key/provider data from queue payload.

- [ ] **Step 7: Run GREEN + type/build**
  Run batch runtime/worker tests, existing direct attempt tests, worker type-check/build and api-gateway batch-runtime build/import-boundary test.
  Expected: all PASS.

- [ ] **Step 8: Commit**
  `git commit -m "feat(worker): execute durable batch items"`

### Task 6: Recovery scanner and mounted native acceptance

**Files:**
- Create: `apps/worker/src/queues/batch-process-recovery.ts`
- Create: `apps/worker/src/queues/__tests__/batch-process-recovery.test.ts`
- Modify: `apps/worker/src/index.ts`
- Create: `packages/api-gateway/src/__tests__/stored-batches-mounted.native.integration.test.ts`
- Modify: root `package.json` database baseline registration
- Modify: `tests/config/vitest-discovery.test.ts`

**Interfaces:**
- Produce `startBatchProcessRecovery(connection, store, options?)`; it scans only durable nonterminal batches whose queued items need queue ownership and enqueues deterministic batch ids.
- Recovery does not create admissions, infer outcomes or call providers.
- Mounted native fixture uses real Hono/PostgreSQL/Redis/admission/worker step with mocked admitted provider transport only.

- [ ] **Step 1: Add RED recovery tests**
  Assert bounded scan, duplicate scanner enqueue convergence, terminal/reconciliation-only batches skipped, and no raw item data in queue.

- [ ] **Step 2: Add RED mounted acceptance**
  Cover: three-item successful batch; exact per-item holds before202; insufficient funds on later item rolls everything back; same-key replay; changed replay409; enqueue failure503 then scanner recovery; mixed completed + pre-dispatch expired item; post-dispatch ambiguity held/reconciliation; foreign-org GET404; results pagination; GET network/queue silence.

- [ ] **Step 3: Run RED**
  Expected: new scanner/mounted suite fails before implementation/registration.

- [ ] **Step 4: Implement recovery scanner**
  Reuse Task3 recoverable selector and Task4 deterministic queue helper. Keep bounded page/cadence and idempotent BullMQ ownership.

- [ ] **Step 5: Complete mounted fixture and baseline registration**
  Block external network except mocked admitted transport; assert ledger count equals settled successful items, no double provider/settlement on duplicate worker delivery, and queue data is ID-only.

- [ ] **Step 6: Run GREEN native**
  Under isolated runtime + build lock run new mounted suite, DB batch suite, worker batch native/unit suites and config discovery.
  Expected: all PASS without skip.

- [ ] **Step 7: Commit**
  `git commit -m "test(batch): prove durable batch recovery lifecycle"`

### Task 7: Whole-package verification, review fixes and acceptance checkpoint

**Files:**
- Modify after evidence: `.superpowers/sdd/2026-09-27-durable-batch-lifecycle/progress.md`
- Modify after acceptance: `docs/product/acceptance/AG-P1.md`
- Modify after acceptance: `docs/product/acceptance/AG-P1-route-coverage.md`
- Modify after acceptance: `docs/consolidation/2026-09-20-priorities-and-routing.md`
- Modify after acceptance: `docs/DEVELOPMENT-ENTRYPOINT.md`

- [ ] **Step 1: Run fresh focused unit gate**
  Include batch identity/preparation/storage/runtime/worker/recovery/composition plus all direct chat/embeddings/completions suites affected by refactors.
  Expected: zero failures.

- [ ] **Step 2: Run fresh type/build/lint/diff gates**
  Gateway source+test types (using the worktree-local path mapping if root node_modules contamination still exists), worker types, api-gateway+worker builds, supported gateway lint and `git diff --check`.
  Expected: exit0 for every supported gate; record any environment-only limitation exactly.

- [ ] **Step 3: Run full guarded DB baseline**
  Restore only the owned local PG15432/Redis16379 runtime if needed; run root `test:database-baseline` under flock.
  Expected: all registered native files PASS plus mandatory TON core58/58 cleanup/canonical checks.

- [ ] **Step 4: Whole-branch review**
  Review exact financial atomicity, SQL/idempotency races, provider ambiguity, response/secret leakage, queue/scanner races and runtime composition. Use one final fresh reviewer if available; otherwise document Superpowers self-review fallback. Fix Critical/Important findings once with RED→GREEN tests; defer Minor explicitly.

- [ ] **Step 5: Re-run impacted gates after review fixes**
  Then rerun the complete final acceptance commands required by `verification-before-completion`.

- [ ] **Step 6: Update acceptance docs and ledger**
  Record exact commits/test counts, local-only boundary, reviewer status, and set next package to author/revenue lifecycle (batches no longer listed open if accepted).

- [ ] **Step 7: Commit acceptance docs**
  `git commit -m "docs(gateway): accept local durable batch lifecycle"`
