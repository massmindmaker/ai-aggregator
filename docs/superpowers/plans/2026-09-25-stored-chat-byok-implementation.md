# Stored Chat BYOK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:executing-plans or superpowers:subagent-driven-development task-by-task. TDD is mandatory.

**Goal:** Implement the durable fixed-fee BYOK contract in `docs/superpowers/plans/2026-09-25-stored-chat-byok-lifecycle.md`.

**Architecture:** contractVersion3 / billingMode `byok_fee` extends existing chat HTTP storage with additive migration0080. A dedicated BYOK attempt reuses reviewed chat mechanics and accepted admission/quota primitives. Route composition enables only non-stream BYOK in the newest explicit mode.

**Tech Stack:** TypeScript, Hono, Zod, PostgreSQL 16, Redis, Bun 1.4.2, Vitest.

**Spec:** `docs/superpowers/plans/2026-09-25-stored-chat-byok-lifecycle.md`

## Global constraints

- No production deploy/migration, paid provider call, or runtime activation.
- Raw provider key never enters durable state or logs.
- BYOK fee uses existing `calculateByokFee`; no new pricing formula.
- Existing quota SQL byok_fee semantics and supplier-zero evidence are reused.
- Historical migrations <=0079 immutable.
- Old stored modes/default legacy unchanged.
- One heavy command at a time under `flock /tmp/ai-ecosystem-build.lock`.

## Review focus

1. Secret leakage through identity/snapshots/errors.
2. Cross-mode idempotency collision stored vs byok_fee.
3. Provider error after dispatch preserving hold and preventing retry.
4. Exact fixed fee and supplier-zero quota evidence.
5. Recovery only from coherent outcome_recorded BYOK state.

### Task 1 — identity, exact fee and v2 BYOK admission wrapper

**Files**
- Modify `packages/api-gateway/src/billing/stored-chat-http-identity.ts`
- Modify `packages/api-gateway/src/billing/stored-chat-http-contract.ts`
- Modify `packages/api-gateway/src/config.ts`
- Modify `packages/api-gateway/src/billing/quota-admission.ts`
- Tests: identity, contract, config, quota-admission suites

- [ ] RED: strict header parser, digest in fingerprint, no raw secret in identity/errors, contractVersion3/byok_fee, stream+BYOK rejection.
- [ ] RED: exact `BYOK_FEE_CREDITS_EXACT` survives config parse and `calculateByokFee`; zero/invalid fee rejected when durable BYOK mode is active.
- [ ] RED: dedicated v2 BYOK admission wrapper accepts `billingMode:'byok_fee'` + exact supplier-zero snapshot.
- [ ] Run RED focused suites.
- [ ] Implement minimal changes.
- [ ] GREEN focused suites + source/test typecheck + lint.
- [ ] Commit `feat(gateway): add durable BYOK identity and fee admission`.

### Task 2 — fixed-fee BYOK attempt

**Files**
- Create `packages/api-gateway/src/billing/stored-chat-byok-attempt.ts`
- Create `packages/api-gateway/src/__tests__/stored-chat-byok-attempt.test.ts`

- [ ] RED: reviewed candidate/policy only, proxy forbidden, no failover.
- [ ] RED: admission max = exact fee; dispatch pricing and outcome usage exactly match accepted BYOK SQL contracts.
- [ ] RED: provider success stores sanitized chat response, actual=fee, settle once.
- [ ] RED: provider/malformed/ACK loss after dispatch => reconciliation_required, hold preserved, no retry.
- [ ] RED: raw key absent from quote/pricing/usage/result snapshots.
- [ ] Implement using existing admittedChat mechanics and money primitives.
- [ ] GREEN + affected chat tests/types/lint.
- [ ] Commit `feat(gateway): add durable BYOK chat attempt`.

### Task 3 — additive HTTP storage contract3 and recovery

**Files**
- Create `packages/database/migrations/0080_gateway_stored_chat_byok.sql`
- Modify `packages/database/src/schema/gateway.ts`
- Modify `packages/database/src/functions/gateway-http-storage.sql`
- Modify `packages/database/src/functions/gateway-http-terminal-recovery.sql`
- Modify native migration/baseline/storage/recovery tests and worker selector tests as required

- [ ] Recheck migration manifest; if0080 occupied, record ruling and renumber only the new migration.
- [ ] RED native: only chat/byok_fee/version3 JSON accepted; v1/v2 stored unchanged.
- [ ] RED native: cross-mode same idempotency digest conflicts.
- [ ] RED native: version3 validator checks sanitized chat response and fixed-fee usage; no secret field allowed.
- [ ] RED recovery: coherent outcome_recorded BYOK settles once; unknown dispatched excluded.
- [ ] Implement additive SQL + mirrors + typed storage identity union.
- [ ] Upgrade79→80 exactly1; no-op80 exactly0; checksums <=0079 unchanged.
- [ ] GREEN native/types/lint.
- [ ] Commit `feat(database): persist stored chat BYOK results`.

### Task 4 — route composition and mounted native acceptance

**Files**
- Modify `packages/api-gateway/src/routes/v1/stored-chat.ts`
- Modify composition/config tests
- Create BYOK mounted native fixture/integration test
- Modify root native baseline registration
- Update AG-P1/checkpoint/entrypoint after verification

- [ ] RED route: newest explicit mode permits non-stream BYOK; older stored modes501; stream+BYOK501.
- [ ] RED mounted: fee1000, supplier0, caller key authorization, provider1/ledger1, balance5000→4000, replay without network.
- [ ] RED concurrency/conflicts: same identity provider1; changed BYOK key/body409; stored-vs-BYOK same idempotency key409.
- [ ] RED provider error: dispatched/held1000, result0, ledger0, worker selected0, provider1.
- [ ] RED actual recovery: forced settle failure after durable result; worker settles1 then0; provider1/ledger1; replay survives network block.
- [ ] Implement route composition and native fixture.
- [ ] Register suite in database baseline via RED→GREEN config test.
- [ ] Final focused/native/types/build/lint/diff-check verification.
- [ ] One combined independent financial/SQL/security/TypeScript review; fix Critical/Important with regression test and one scoped re-review.
- [ ] Update acceptance docs with exact evidence and unresolved stream+BYOK/other-route/provider-runtime/production gates.
- [ ] Commit `docs(gateway): accept local stored chat BYOK lifecycle`.
