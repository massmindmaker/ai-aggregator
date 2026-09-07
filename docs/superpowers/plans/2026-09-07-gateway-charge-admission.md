# Gateway Charge Admission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Authorize and reserve every gateway charge before provider dispatch, preserving money under concurrent requests, refunds and interrupted streams.

**Architecture:** A server-generated billing UUID owns a durable hold removed from spendable organization buckets. Dispatch freezes provider/pricing facts; an immutable outcome settles the hold exactly once. Unknown provider outcomes retain funding until reconciliation.

**Tech Stack:** PostgreSQL native migrations/functions, Drizzle, TypeScript, Hono, BullMQ, Vitest.

**Spec:** User-authorized three-product completion and refund binding amendments in [refund plan](2026-09-06-topup-refund-clawback.md). This document is the binding admission design; the private read-only draft provides source investigation only.

## Global Constraints

- Canonical repository `/home/bob/Projects/ai-aggregator`; no source-archive changes, external provider calls, production DB access, push or deployment.
- One implementation worker and one heavy build/test under `flock /tmp/ai-ecosystem-build.lock` at a time.
- SQL values use prepared bindings. Financial mutations are atomic and guarded with RETURNING. New monetary BIGINT fields use exact bigint, never Drizzle number mode.
- Historical migrations 0000–0066 and both legacy settlement functions remain unchanged. New migration number must be verified before creation.
- Database tests use the existing dual-URL/loopback/marker guard before production imports or mutations. New suite belongs in mandatory `test:database-baseline`.
- Every operation acquiring both organization and admission locks uses **organization → admission**. Never admission → organization. Payment refund primitives remain organization → payment.
- 1 credit = 1000 integer micro-credits. No currency conversion or invented tariff changes.
- Server billing UUID is distinct from client trace ID. `gw:<uuid>` is the usage receipt key. No public request-idempotency promise.
- `stored` admission calls the existing refund admission guard within the hold transaction. `byok_fee` preserves the configured platform fee and requires funded balance, but does not use the stored-only claim/debt guard.
- Replay checks validate the original org/context/amount before returning. Exact completed replay remains valid after new claim/debt. Conflicting replay fails without mutations.
- Refund activation requires all active paid routes to use admission or be disabled before any external side effect. Additive DB functions alone do not meet this gate.

## Binding design

Admission removes subscription first, then PAYG from spendable buckets. Actual cost consumes held subscription first, then held PAYG. Unused PAYG repays `refund_debt_credits` first; only its remainder becomes spendable PAYG. Thus PAYG100, hold30, cost20, refund100 ends in debt20 in either settlement/refund order. Cancellation gives debt0 in either order.

Unused held subscription is restored only if the captured expiry is still valid and exactly matches the organization's current expiry (including null-safe equality); changed or expired entitlement is audited as expired, never resurrected. New subscription confirmation must respect these captured entitlement semantics.

States: `held → dispatched → outcome_recorded → settled`, or `held → cancelled`. `dispatched` without an outcome is funded unknown, not a deadline-triggered release. There is no automatic post-dispatch no-charge classifier in the first DB increment; a verified successful zero-cost outcome is allowed, network errors are not zero evidence.

The admission row is financial authority. Dedicated append-only admission events audit hold/release/debt repayment/expired entitlement; they do not duplicate usage in `gateway_transactions`. Positive actual portions produce existing `api_usage` receipts only, with `gw:<uuid>` identity; zero outcome is terminal/audited without fake positive usage. Hold events and usage receipts are different measures and must not be summed as one balance ledger.

Quote snapshot (server-derived maximum and limits) is immutable at admission; actual selected provider/pricing snapshot is immutable at dispatch. Snapshot JSON contains no API key, request prompt or provider secret. API key ownership must match org at admission. Privileged functions remain SECURITY INVOKER; caller authentication remains the gateway boundary.

### Task 1: Durable database hold and exact admitted settlement (2B.1)

**Files:**
- Create `packages/database/migrations/0067_gateway_charge_admissions.sql` after verifying next number.
- Create `packages/database/src/functions/gateway-charge-admission.sql` as exact function-body mirror.
- Modify `packages/database/src/schema/gateway.ts` and its existing export surface if needed.
- Create `packages/database/scripts/__tests__/gateway-charge-admission.native.integration.test.ts`.
- Modify `packages/database/scripts/__tests__/native-baseline.integration.test.ts`, root `package.json`.

**Interfaces:** SQL functions return the current admission row (or an explicitly typed table covering identity/state/held/actual/release fields). All arguments are bound. Names and parameter sequence are shared contract:

```sql
aiag_admit_gateway_charge(_org_id uuid, _billing_request_id uuid,
  _api_key_id uuid, _client_request_id varchar, _route_kind varchar,
  _billing_mode varchar, _model_slug varchar, _authorized_max_credits bigint,
  _quote_snapshot jsonb, _pre_dispatch_deadline_at timestamptz)
aiag_mark_gateway_charge_dispatched(_org_id uuid, _billing_request_id uuid,
  _attempt_id uuid, _upstream_id varchar, _pricing_snapshot jsonb)
aiag_record_gateway_charge_outcome(_org_id uuid, _billing_request_id uuid,
  _actual_cost_credits bigint, _usage_snapshot jsonb, _outcome_kind varchar)
aiag_settle_admitted_gateway_charge(_org_id uuid, _billing_request_id uuid)
aiag_cancel_undispatched_gateway_charge(_org_id uuid, _billing_request_id uuid)
```

Table `gateway_charge_admissions` includes UUID/org/key/trace/route/model/mode identity; maximum and original held sub/PAYG; captured expiry; quote and dispatch pricing snapshots; attempt/upstream; actual/usage/outcome; constrained state and timestamps created/deadline/dispatched/outcome/settled/cancelled/reconcile_after. Add database CHECKs for valid mode/state, positive max, exact nonnegative hold sum, actual within max, lifecycle all-or-none facts. Add retry index and org/state index. Append-only `gateway_charge_admission_events` stores admission identity, event kind, exact bucket/debt movement amounts and safe metadata with unique event identity; prefer exact numeric audit columns over untyped amount JSON. Expose exact bigint schema types.

- [ ] **Step 1: Add guarded RED native tests using real functions, not copied test SQL.** Reuse native harness fixtures and pg_blocking_pids barriers. Representative assertions:

```ts
expect(afterConcurrentAdmissions.openHoldTotal).toBeLessThanOrEqual(100n);
expect(refundThenSettle).toEqual(settleThenRefund);
expect(refundThenSettle).toMatchObject({ payg: 0n, debt: 20n });
expect(refundThenCancel).toEqual(cancelThenRefund);
expect(duplicateSettlement.receipts).toEqual(firstSettlement.receipts);
expect(zeroOutcome.apiUsageRows).toBe(0);
```

Cover two concurrent holds, real claim-first/admit-first waits, exact replay/conflicting org/key/mode/quote/amount, refund/debt block only for stored, funded BYOK, actual over max rollback, duplicate outcome/settle/cancel, expiry before dispatch and no cancellation after dispatch, zero cost, expired/changed subscription expiry, injected audit uniqueness conflict rolling back every balance/state mutation. Validate wrong key org and null/invalid snapshots. Exact replay works after settlement and new refund block; dispatch replay returns durable state but must never authorize a second provider call (consumer must observe one-shot transition flag).

- [ ] **Step 2: Run new native tests and record the missing table/function RED.** Use the established guarded runner, no ungated DB client. Existing migrations should remain intact.
- [ ] **Step 3: Implement additive schema/functions.** Lock org first; revalidate all immutable identity under locks. On a fresh admission verify key ownership and positive max, reject insufficient funds, then debit held parts with UPDATE guards/RETURNING, insert admission and hold audit in the same transaction. Dispatch is one-shot CAS before deadline; exact replay must expose whether the transition was performed now. Outcome is immutable, only dispatched can first record. Settlement uses the following arithmetic inside one locked transaction:

```sql
used_sub := LEAST(actual_cost, held_sub);
used_payg := actual_cost - used_sub;
unused_payg := held_payg - used_payg;
debt_repaid := LEAST(unused_payg, refund_debt);
returned_payg := unused_payg - debt_repaid;
-- Return eligible unused subscription; audit expired/changed remainder.
-- One receipt per positive used portion; one settlement event; one terminal CAS.
```

Cancel releases all eligible hold using the same debt/expiry arithmetic, only if never dispatched. No external API, no SECURITY DEFINER, no automatic dispatched expiry release. Typed conflicts use stable SQLSTATE/messages; preserve existing P0002/P0003/P0005 meanings. Native fixtures and tests must exercise real public functions.
- [ ] **Step 4: Verify new suite plus mandatory native baseline, database types and mirror equality.** Expected new migration total67 (prior66) and two new tables (prior96); derive assertions from manifest where existing harness does so. First apply67th and repeat no-op; if development checksum changes, use only the existing explicitly guarded disposable DB rehearsal and record refusal/fresh/no-op evidence. Do not modify historical hashes or weaken safety guards. Add meaningful exact-bigint schema assertion beyond Number.MAX_SAFE_INTEGER.
- [ ] **Step 5: Self-review and commit exact owned files.** Report commands/results, SQL interfaces, transition return shape and remaining gateway dependency in private SDD report. No force-add private files. Mandatory TypeScript/SQL spec+quality review follows.

## Subsequent execution increments

These remain required work; each gets its concrete task brief after its predecessor's reviewed interfaces are known.

1. **2B.2 bounded non-stream gateway.** New `billing/admission.ts`; chat/completions/embeddings and failover use server UUID, trusted mode, immutable quote/dispatch. For missing max_tokens inject a documented server cap; reject unsupported unbounded content before provider. Snapshot maximum candidate price, pass actual cap, no caching discount in worst-case quote. Ambiguous post-dispatch failure stops automatic failover. Preserve BYOK configured fee.
2. **2B.3 SSE and durable reconciliation.** Hold before iterator/first output; usage is authoritative or explicitly marked estimate, never double-counted. Record immutable outcome then settle. Worker retries DB outcome_recorded rows; unknown remains funded and observable. No Redis-only financial state and no maximum charge guessed after process loss.
3. **2B.4 complete route activation gate.** Every money-producing mounted route is admitted or explicitly disabled before provider/queue calls. Incomplete media/batches return stable unavailable response before dispatch. No successful 202 without durable ownership and working terminal polling/settlement.
4. **2B.5 restore media capability.** Admission-linked prediction_jobs, real provider poll and DB sink, authenticated org-scoped job read, exact once terminal outcome. Full product completion requires restoration; temporary disabling is not final marketplace completion. Batches require their own real consumer/admission plan.

No refund route is activated until 2B.1–2B.4 and refund confirmation/admin/webhook tasks have all passed review. Public release additionally requires media capability, product/integration acceptance and explicit external release authorization.
