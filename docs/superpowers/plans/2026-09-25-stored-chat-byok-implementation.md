# Stored Chat BYOK Implementation Plan

> **For agentic workers:** use superpowers:executing-plans or subagent-driven-development task-by-task, TDD first.

**Goal:** Implement the durable fixed-fee BYOK contract in docs/superpowers/plans/2026-09-25-stored-chat-byok-lifecycle.md.

**Architecture:** contractVersion3/billingMode byok_fee extends the existing chat HTTP storage with additive migration0080; a dedicated BYOK attempt reuses reviewed chat mechanics and accepted admission/quota primitives; route composition enables only non-stream BYOK in the newest explicit mode.

## Tasks

### Task 1 — identity, exact fee and v2 BYOK admission wrapper
- Modify stored-chat-http-identity.ts / stored-chat-http-contract.ts / config.ts / quota-admission.ts.
- Tests: stored-chat-http-identity.test.ts, stored-chat-http-contract.test.ts, stored-chat-http-config.test.ts, quota-admission.test.ts.
- RED: contractVersion3 + byok_fee only when strict header present; provider-key digest changes fingerprint; raw secret absent from identity serialization/errors; stream+BYOK rejected; exact fee string preserved and positive; new wrapper admits byok_fee with exact byok-zero supplier snapshot.
- GREEN then source/test TypeScript and lint.
- Commit feat(gateway): add durable BYOK identity and fee admission.

### Task 2 — fixed-fee BYOK attempt
- Create stored-chat-byok-attempt.ts and tests.
- Reuse fresh policy + reviewed admittedChat mechanics; no egress proxy, no failover.
- Admission max = exact fixed fee; dispatch/pricing/usage snapshots match accepted SQL BYOK contracts.
- Provider success stores sanitized chat response, records actual=fee and settles. Provider/malformed/ACK loss after dispatch -> reconciliation_required with hold preserved.
- Raw key never enters snapshots/results.
- Commit feat(gateway): add durable BYOK chat attempt.

### Task 3 — additive HTTP storage contract3 and recovery
- Create migration0080; update gateway schema + SQL mirrors + native manifest/baseline/storage/recovery tests + worker selectors if required.
- Allow only chat/byok_fee/version3 JSON results.
- Cross-mode same idempotency digest must conflict.
- Version3 validator checks chat response shape/self-consistent usage and fixed-fee usage snapshot; no raw key.
- Recovery accepts coherent outcome_recorded BYOK rows; unknown dispatched remains excluded.
- Upgrade79→80/no-op80 and checksum evidence.
- Commit feat(database): persist stored chat BYOK results.

### Task 4 — route composition and mounted native acceptance
- Modify stored-chat.ts plus focused composition/config tests.
- Newest explicit mode permits non-stream BYOK; old stored modes still501; stream+BYOK501.
- Mounted native fixture proves fee1000, supplier0, caller key authorization, provider1/ledger1, replay, concurrency/conflicts, provider-error hold, actual recovery once.
- Register native suite in database baseline.
- One combined independent review; fix Critical/Important only.
- Update AG-P1/checkpoint/entrypoint and commit local acceptance.
