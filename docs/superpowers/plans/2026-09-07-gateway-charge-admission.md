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

Status: accepted at `9493d1`; native45/45, database types, TypeScript/SQL and React review passed.

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

- [x] **Step 1: Add guarded RED native tests using real functions, not copied test SQL.** Reuse native harness fixtures and pg_blocking_pids barriers. Representative assertions:

```ts
expect(afterConcurrentAdmissions.openHoldTotal).toBeLessThanOrEqual(100n);
expect(refundThenSettle).toEqual(settleThenRefund);
expect(refundThenSettle).toMatchObject({ payg: 0n, debt: 20n });
expect(refundThenCancel).toEqual(cancelThenRefund);
expect(duplicateSettlement.receipts).toEqual(firstSettlement.receipts);
expect(zeroOutcome.apiUsageRows).toBe(0);
```

Cover two concurrent holds, real claim-first/admit-first waits, exact replay/conflicting org/key/mode/quote/amount, refund/debt block only for stored, funded BYOK, actual over max rollback, duplicate outcome/settle/cancel, expiry before dispatch and no cancellation after dispatch, zero cost, expired/changed subscription expiry, injected audit uniqueness conflict rolling back every balance/state mutation. Validate wrong key org and null/invalid snapshots. Exact replay works after settlement and new refund block; dispatch replay returns durable state but must never authorize a second provider call (consumer must observe one-shot transition flag).

- [x] **Step 2: Run new native tests and record the missing table/function RED.** Use the established guarded runner, no ungated DB client. Existing migrations should remain intact.
- [x] **Step 3: Implement additive schema/functions.** Lock org first; revalidate all immutable identity under locks. On a fresh admission verify key ownership and positive max, reject insufficient funds, then debit held parts with UPDATE guards/RETURNING, insert admission and hold audit in the same transaction. Dispatch is one-shot CAS before deadline; exact replay must expose whether the transition was performed now. Outcome is immutable, only dispatched can first record. Settlement uses the following arithmetic inside one locked transaction:

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
- [x] **Step 4: Verify new suite plus mandatory native baseline, database types and mirror equality.** Expected new migration total67 (prior66) and two new tables (prior96); derive assertions from manifest where existing harness does so. First apply67th and repeat no-op; if development checksum changes, use only the existing explicitly guarded disposable DB rehearsal and record refusal/fresh/no-op evidence. Do not modify historical hashes or weaken safety guards. Add meaningful exact-bigint schema assertion beyond Number.MAX_SAFE_INTEGER.
- [x] **Step 5: Self-review and commit exact owned files.** Report commands/results, SQL interfaces, transition return shape and remaining gateway dependency in private SDD report. No force-add private files. Mandatory TypeScript/SQL spec+quality review follows.

### Evidence for token bounds

Checked2026-09-07: [OpenRouter parameters](https://openrouter.ai/docs/api_reference/parameters) and [Groq Chat API](https://console.groq.com/docs/api-reference) document an output-token cap within total context. This supports the conditional mathematical bound below; it does not certify every routed model or additional reasoning/tool tariffs. Admission needs an explicit reviewed adapter/model capability and trusted context metadata. A provider name or a successful usage parser alone is not that evidence. No live inference was performed.

### Task 2: Exact bounded token quote arithmetic (2B.2a)

Status: accepted at `b44bab1`; focused21/21, gateway source/test types and TypeScript review passed.

**Files:** Create `packages/api-gateway/src/billing/token-quote.ts` and `packages/api-gateway/src/__tests__/billing-token-quote.test.ts`. No route, resolver, config, DB or legacy pricing changes in this pure increment.

**Interfaces:** The next gateway lifecycle task consumes these pure contracts. Prices are USD cents per1000tokens; markup/discount are exact decimal strings. Runtime parsers enforce plain canonical nonnegative decimal syntax, at most18 fractional digits and38 total digits before BigInt allocation; monetary results must be within PostgreSQL signed BIGINT. Token counts/context/cap are positive safe integers where required, never coerced from string. Use immutable input objects or readonly types; do not mutate inputs.

```ts
export type TokenPrices = Readonly<{
  inputCentsPer1k: string;
  outputCentsPer1k: string;
  markup: string;
}>;
export type TokenUsage = Readonly<{
  promptTokens: number;
  completionTokens: number;
  cachedInputTokens: number;
}>;
export function quoteChatMaximum(prices: TokenPrices,
  contextWindowTokens: number, maxOutputTokens: number): bigint;
export function quoteEmbeddingMaximum(prices: TokenPrices,
  contextWindowTokens: number, inputCount: number): bigint;
export function calculateTokenCharge(prices: TokenPrices,
  usage: TokenUsage, cachingDiscount: string): bigint;
export function calculateByokFee(feeCredits: string): bigint;
export function microCreditsToUsdMicroString(amount: bigint): string;
```

- [x] **Step1: Write focused RED tests against real exported functions.** Representative exact assertions:

```ts
const p = { inputCentsPer1k: '0.015', outputCentsPer1k: '0.06', markup: '1.3' };
expect(quoteChatMaximum(p, 128000, 4096)).toBe(2736n);
expect(calculateTokenCharge(p,
  { promptTokens: 100, completionTokens: 20, cachedInputTokens: 0 }, '1')).toBe(4n);
expect(microCreditsToUsdMicroString(123n)).toBe('1230');
expect(microCreditsToUsdMicroString(9007199254740993n)).toBe('90071992547409930');
```

Also test output<input branch, embedding array count factor, existing whole-cost cached-fraction discount once (prompt100/output50, Pin1/Pout2, cached50, discount0.5 =>150micro), nearest half rounds up, zero actual from valid tiny tariff, exact zero tariff/fee remains zero (caller must handle unsupported free lifecycle explicitly), huge intermediate rational arithmetic with valid final amount, overflow rejection, invalid/noncanonical decimal (sign/exponent/whitespace/empty/NaN), invalid markup<=0, discount outside[0,1], invalid/unsafe/negative token counts, cached>prompt, cap>context, inputCount0, and input immutability.
- [x] **Step2: Run the new file from root Vitest and record RED.** Command: `flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator bunx vitest run packages/api-gateway/src/__tests__/billing-token-quote.test.ts` (no DB use in these tests).
- [x] **Step3: Implement rational bigint arithmetic.** Decimal parser yields numerator/10^scale. Apply multiplication/addition exactly and round only once at final result; use ceiling for maximum and nonnegative nearest-half-up for actual, preserving legacy business formula.

```text
chatMaximum = ceil((C*Pin + cap*max(0,Pout-Pin))*markup)
embeddingMaximum = ceil(N*C*Pin*markup)
cacheFactor = prompt > 0 ? (prompt-cached+cached*discount)/prompt : 1
actual = round((prompt*Pin + completion*Pout)*markup*cacheFactor)
byokFee = round(feeCredits*1000)
chargedUsdMicro = actualMicroCredits*10
```

Compatibility ruling: existing `lib/pricing.ts` applies the cached-input fraction factor to the whole input+output cost. Preserve this exact legacy formula in this increment, even though its comment can be read as input-only discount. Switching to input-only discount would increase charges for cached requests with output; any such tariff correction needs a separate versioned policy and acceptance. These functions do not attest a model/provider or validate provider evidence. The bound applies only when the later reviewed capability enforces prompt+completion<=C and completion<=cap. They never estimate tokens from bytes, silently clamp monetary values, fabricate a minimum charge, expose floating monetary results or consult mutable configuration.
- [x] **Step4: Verify focused tests, gateway source/test type checks and diff hygiene.** No broad unit/build or DB suite repetition for this isolated pure module. Demonstrate at least one input beyond Number.MAX_SAFE_INTEGER monetary precision and adversarial decimal boundary in tests.
- [x] **Step5: Self-review, commit both owned files and report privately.** Mandatory TypeScript spec+quality review; no React diff. Then proceed to lifecycle/route integration with its own capability/quote snapshot plan.

### Task 3: Exact gateway wrapper for the reviewed admission functions (2B.2b-1)

**Dependency and ordering:** Database2B.1 is accepted at `9493d1`; pure arithmetic2B.2a must pass its task review before implementation begins. This wrapper is independent of provider capability selection, so it precedes the candidate-trust increment proposed by the private lifecycle draft. The final SQL result has **31 named fields**, not32. The following task contract supersedes the draft where they differ.

**Files:** Create `packages/api-gateway/src/billing/admission-result.ts` (runtime row parser and types), `packages/api-gateway/src/billing/admission.ts` (five prepared SQL wrappers and error mapping), `packages/api-gateway/src/__tests__/billing-admission-result.test.ts`, and `packages/api-gateway/src/__tests__/billing-admission.test.ts`. No route, config, resolver, adapter, migration, historical settlement or refund activation change. A private report in the ignored SDD workspace is required and is not a product file.

**Boundary:** The wrapper calls the five accepted SQL functions; it does not open a caller transaction, acquire locks, calculate prices, contact providers or retry mutations. PostgreSQL retains financial authority. Use the existing gateway `SqlClient`/`sql` boundary with dependency injection for focused tests. Default-client use must remain compatible with the existing gateway startup; tests mock the DB module before importing it.

**Row contract:** Parse every named field of `gateway_charge_admission_result` from `unknown`, checking runtime type, required/nullability, UUID identity, nonempty bounded identifiers, exact nonnegative signed-PG-BIGINT amounts, mode/state and lifecycle facts. Return immutable camelCase data. Financial inputs and outputs are `bigint`; bind them as canonical decimal strings. Never coerce a financial string through Number, a boolean through Boolean, or assert an unchecked row type. Verify hold-sum/max, actual<=max, state-dependent dispatch/outcome/terminal/reconciliation fields and nonnegative release bounds. The parser does not replace the SQL constraints or invent a new allowed state.

All five queries project the **same explicit named result contract**, avoiding five copied projection/parser bodies. UUID and BIGINT fields are projected as text, JSONB as JSON, and `did_transition` as boolean. Timestamps have one documented string representation with a timezone; compare timestamps without discarding PostgreSQL fractional precision or equating distinct instants through millisecond truncation. Avoid dependence on the connection's timezone/DateStyle. An empty, multirow or malformed result is a neutral server-contract failure, never an authorization.

Quote/pricing/usage snapshots are immutable plain JSON objects at this transport boundary. Validate and clone JSON safely; compare object contents independent of key order, reject missing/undefined/non-JSON values and non-object roots. This increment deliberately does not invent provider-specific snapshot schemas. The later candidate/executor task must define those versioned schemas and omit prompts/credentials before calling this wrapper.

**Wrapper interfaces:** Export `admitGatewayCharge`, `markGatewayChargeDispatched`, `recordGatewayChargeOutcome`, `settleAdmittedGatewayCharge`, `cancelUndispatchedGatewayCharge` with explicit readonly argument types and optional injected SQL client. Admit takes the10 published function inputs using camelCase and exact bigint maximum. Later operations take the previously parsed admission as their immutable identity anchor plus their operation-specific attempt/provider/pricing or actual/usage/outcome facts; pass org/billing IDs to SQL in the published order. Compare the returned immutable admission identity and all facts known before the operation, plus the newly requested dispatch/outcome facts. Settlement must match the expected recorded actual and return `settled`; cancellation must return `cancelled`. Mismatches are server-contract failures. SQL still revalidates ownership and state; the parsed object is not an alternative DB authority.

A fresh admit result must be `held` with `didTransition=true`; exact admit replay may return a later durable state with `didTransition=false`. Dispatch returns a discriminated result: `kind: 'dispatch_granted'` only for `state='dispatched' && didTransition===true`; `kind: 'replay'` for an exact already-dispatched/outcome/settled result with false. Replay **never** grants provider invocation. A fresh outcome must be `outcome_recorded`; exact replay may be `outcome_recorded` or `settled`, with identical actual/usage/outcome. Exact settled/cancelled replay is successful with false. The executor will consume this contract explicitly; no provider invocation exists here.

**Errors:** P0003 maps to neutral402, P0004 to neutral503, P0005 to a typed admission conflict409. `ADMISSION_DEADLINE_EXPIRED` is classified only for the exact reviewed code/message pairs: admit P0001 or dispatch P0005. It is a typed deadline conflict and grants zero calls. Other P0001/P0002, malformed rows and unknown DB transport errors become neutral server/unavailable errors without raw SQL/provider details. These errors may live in `admission.ts` and extend existing `AiagError`; do not add unrelated global error API. Never infer rollback, no-charge or permission to retry from a transport error. Exact message matching is internal classification only, not response/log disclosure.

- [ ] **Step1: Write focused RED tests against the actual exported parser/wrappers.** Pin all31 named fields and every money cast; use realistic held/dispatched/outcome/settled/cancelled rows. Cover amounts beyond JS safe integer, malformed numeric strings/types, false vs `'false'`, missing/null lifecycle fields, inconsistent sums/state, timezone/fractional timestamp identity, JSON key-order equivalence and immutable inputs. For wrappers capture the bound tagged SQL to verify actual function/argument order and shared explicit projection, rather than returning canned success without assertions.
- [ ] **Step2: Implement the parser and prepared wrappers minimally.** Keep transport parsing separate from SQL orchestration and operation identity checks; do not copy the full parser/projection five times. The future executor cannot mistake a replay for dispatch permission.
- [ ] **Step3: Exercise all fresh/replay paths and failures.** Admit/dispatch/outcome/settle/cancel each perform exactly one SQL call. Invalid local inputs make zero calls. Wrong org/billing/key/mode/model/quote/known dispatch or actual facts in a returned row fail closed. SQLSTATE and exact deadline classification must be tested; raw error strings must not appear in public error bodies. No automatic retry/cancel/failover is performed by the wrapper.
- [ ] **Step4: Run the two focused test files and gateway source/test type checks under the build lock, then diff hygiene.** Existing real-DB lifecycle proof is the accepted45/45 suite; do not repeat the full DB/build/unit baseline for this additive unused wrapper. Report explicitly that new wrapper-to-native-driver integration remains part of the later route cutover verification.
- [ ] **Step5: Self-review, commit only the four owned product files, and write a private report with BASE/finalSHA and RED/GREEN evidence.** Mandatory TypeScript financial spec+quality review follows; no React diff. Candidate capability, one-attempt executor, routes, SSE and refund activation remain subsequent work.

### Task 4: Reviewed first candidate, adapter mechanics and frozen stored-chat quote (2B.2b-2)

**Dependency:** Task3 wrapper accepted; implementation may follow the independent Arena baseline repair. This task adds an unused admitted transport/preparation path. It does not switch routes or complete agent compatibility.

**Files:** Create `billing/reviewed-token-profiles.ts`, `billing/candidate-quote.ts` and focused `reviewed-token-profiles.test.ts`, `candidate-quote.test.ts`, `openrouter-admitted-chat.test.ts` under gateway src. Modify only `config.ts`, `routing/resolver.ts`, `routing/engine.ts`, `upstreams/interface.ts`, `upstreams/openrouter.ts` and their directly affected tests. No wrapper/DB/migration/seeds/routes/failover/registry/headers/legacy pricing changes. The private `ag-candidate-trust-execution-design.md` contains inspected interfaces; this task and the controller amendments below are binding where they differ.

**Primary evidence checked2026-09-07:** [exact OpenRouter endpoints](https://openrouter.ai/api/v1/models/openai/gpt-4o-mini/endpoints), [model schema](https://openrouter.ai/docs/guides/overview/models), [parameter bounds](https://openrouter.ai/docs/api_reference/parameters), [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection), [native usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting). Source snapshots and detailed assessment are in `ag-reviewed-first-profile-evidence.md`; no paid inference was used.

**First reviewed profile:** exact modelSlug/upstreamModelId `openai/gpt-4o-mini`, modelType `chat`, upstreamId/adapterKey `openrouter`, context128000, maximum output16384. Stable profile id/revision1 and contract `openrouter-pinned-provider-chat-v1`. Required server-owned endpoint policy `only:['openai']`, `allow_fallbacks:false`, `require_parameters:true`. Manifest holds evidence and limits, never tariff values; runtime model metadata/provider name/admin routing do not grant reviewed capability. Validate/freeze the manifest and reject mismatched tuple or transport contract. Types may support future profiles without hardcoding all values into an oversized singleton literal type; only this actual entry is reviewed now.

**Mechanics:** Add optional `UpstreamAdapter.admittedChat` with the named contract and separate non-stream execute method. It emits only the reviewed model, validated plain-text messages, stream:false, selected explicit max_tokens and pinned provider policy. Key selection and existing vetted fetch/egress boundary are preserved. Exact request model/policy/cap and plain-text message shape must be validated before network even though route validation comes later. No arbitrary body spread or caller override. Do not change legacy chat/chatStream/embeddings behavior.

The admitted response returns a minimal validated OpenAI-shaped public DTO plus strict usage; do not copy arbitrary provider metadata/cost fields and then hope a denylist removed everything. Keep existing shared legacy ChatResponse compatible by using a separate admitted type if necessary. Validate identifiers/choice/message/finish shape and permit legitimate null text content where the supported provider response contract requires it. Prompt/completion/total counts must all exist as safe nonnegative integers and total must equal their sum; no synthetic total or zero fallback. Cached count is read only from nested prompt_tokens_details.cached_tokens; missing optional count means no proven cache discount (zero for the existing arithmetic), malformed present value fails. Unknown usage after a request is an error, not no-charge evidence. Client function tools and provider-hosted tools are not admitted by this first plain-text contract.

**Exact resolver and quote:** Select live routing-row UUID and input/output/markup decimal text explicitly. Add optional `candidate.billing` for legacy compatibility; resolver fills validated facts, admitted preparation requires them. Use versioned model:v2 cache with runtime validation; old/malformed cache is a miss and reviewed profile is bound after cache parsing. Retain existing numeric ranking fields only for legacy selection. No live supplier price import/seed update.

`prepareStoredChatQuote` takes resolved model, requested mode/policy, optional client max_tokens, configured default and an injected adapter lookup. Filter exact profiles/mechanics/facts and allow/block/forbid_non_ru once; choose mode winner only from this eligible pool and freeze winner/rest order and all financial/routing facts. Never re-expand from original candidates through legacy orderCandidates. Adapter unavailable, no eligible candidates, invalid money, overflow or unsupported zero maximum returns a typed neutral unavailable result before admission/provider. Caller validation errors such as invalid client cap are typed bad request. No automatic retry or provider call in preparation.

`GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS` is a positive safe integer default4096 **only for omitted max_tokens**. Explicit valid10000 remains10000;20000 is capped to16384. Candidate cap is min(requested,context,providerMax); no silent global4096 ceiling. Each maximum uses accepted quoteChatMaximum with exact DB prices and no cache discount; authorized maximum is the largest frozen candidate value. Snapshot version includes exact tuple/row UUID/profile revision/endpoint policy/context/cap/prices/markup and decimal-string maxima. No messages/keys/provider response or evidence supplier rates. Later execution owns exact caching/BYOK fee snapshots and lifecycle activation.

- [ ] **Step1: Focused RED.** Prove exact tuple and mechanical contract, emitted pinned request JSON, pre-network rejection, missing/malformed usage, cache optionality, public response redaction, exact decimal/UUID resolver and stale-cache misses. No real provider calls.
- [ ] **Step2: Implement reviewed manifest and separate admitted adapter path.** Minimal runtime parsers, immutable objects and existing vetted transport; preserve legacy behavior and tests.
- [ ] **Step3: Implement exact resolver facts and pure eligible quote.** Test blocked candidate cannot reappear, source mutation cannot change frozen pool/quote, invalid defaults/client caps, omitted/explicit/candidate cap, zero/overflow, actual injected DB rates and no pricing from evidence.
- [ ] **Step4: Run focused changed tests and gateway source/test typechecks under flock.** No full build/native baseline; route cutover later proves new wrapper+driver+emitted transport as one lifecycle.
- [ ] **Step5: Scoped commit and private report, mandatory TypeScript financial/spec review.** No React diff. Unused mechanics is not a released capability, and plain text success is not a working Agents Market tool loop.

## Subsequent execution increments

These remain required work; each gets its concrete task brief after its predecessor's reviewed interfaces are known.

1. **2B.2 bounded non-stream gateway.** New `billing/admission.ts`; chat/completions/embeddings and failover use server UUID, trusted mode, immutable quote/dispatch. For missing max_tokens inject a documented server cap; reject unsupported unbounded content before provider. Snapshot maximum candidate price, pass actual cap, no caching discount in worst-case quote. Ambiguous post-dispatch failure stops automatic failover. Preserve BYOK configured fee.
2. **2B.3 SSE and durable reconciliation.** Hold before iterator/first output; usage is authoritative or explicitly marked estimate, never double-counted. Record immutable outcome then settle. Worker retries DB outcome_recorded rows; unknown remains funded and observable. No Redis-only financial state and no maximum charge guessed after process loss.
3. **2B.4 complete route activation gate.** Every money-producing mounted route is admitted or explicitly disabled before provider/queue calls. Incomplete media/batches return stable unavailable response before dispatch. No successful 202 without durable ownership and working terminal polling/settlement.
4. **2B.5 restore media capability.** Admission-linked prediction_jobs, real provider poll and DB sink, authenticated org-scoped job read, exact once terminal outcome. Full product completion requires restoration; temporary disabling is not final marketplace completion. Batches require their own real consumer/admission plan.

No refund route is activated until 2B.1–2B.4 and refund confirmation/admin/webhook tasks have all passed review. Public release additionally requires media capability, product/integration acceptance and explicit external release authorization.
