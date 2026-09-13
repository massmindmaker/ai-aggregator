# AG-P1 / 2B.3a: bounded stored-chat settlement recovery

Status: design candidate13.09; independent financial/spec review required before implementation.

> Execute with Superpowers subagent-driven-development, one scoped owner and independent review per task. Canonical root `/home/bob/Projects/ai-aggregator`; Arena and Agents Market paused.

## Goal and source boundary

Close the missing background callsite for the already accepted SQL function `aiag_recover_gateway_http_settlement_v1` (final definition migration0071). A successful plaintext stored-chat outcome/result may have committed while settlement or its ACK was lost. Recovery validates existing immutable evidence and invokes the accepted financial settlement exactly once. It never calls a provider, mints admission, writes an outcome/result, cancels a hold, recreates response payload or estimates usage.

Spec: [admission](2026-09-07-gateway-charge-admission.md), [mounted acceptance](2026-09-08-stored-chat-public-cutover.md), [terminal recovery](2026-09-08-http-terminal-recovery.md), [programme](2026-09-07-production-continuation.md). Accepted C1 single-record bridge and MC1–4 remain unchanged. This task does not accept SSE, completions, embeddings, media, BYOK, batches, refund activation or production cutover.

Research inputs → Decision → Acceptance → Deferred: D03/D11 durable accounting and unknown outcome → invoke only validated SQL settlement over stored evidence → local concurrency/restart/fault proof → provider recovery, uncovered routes, deployment-wide drain/opening balances and paid pilot remain separate gates. Existing snapshot/evidence facts take precedence over replaying a request.

## Global constraints

- Source and owned local guarded tests only. No production DB/migration, provider network, paid API, credentials output, push or deployment.
- SQL prepared values only. Existing migrations0066–0072 and settlement functions unchanged. No direct financial UPDATE/INSERT from worker, no lock before the SQL function acquires organization ownership.
- One heavy run under `/tmp/ai-ecosystem-build.lock`; use `/tmp/ai-ecosystem-run aggregator`. Guard and positive connected marker before production imports/mutations in native tests. Only UUID-owned fixtures; clean all owned resources even setup failure.
- Worker and test TypeScript plus scoped lint must pass; production tsconfig excludes tests. Native evidence uses accepted HTTP/quota setup contracts, not fabricated financial states or disabled immutable triggers.
- Each task has a narrow report and independent spec/quality verdict. Preserve adjacent TON/catalog work and untracked files.

## Frozen runtime and DB boundary

Use a dedicated worker module and an owned native `pg.Pool`, not an import of the API gateway server/config singleton. Add `pg` and its types to worker dependencies at exactly the existing workspace-resolved versions, update only the worker lock entry through pinned Bun1.4.2; no new package family. This worker capability supports the existing self-hosted PostgreSQL deployment; it does not claim Neon HTTP parity.

Setting `GATEWAY_SETTLEMENT_RECOVERY_MODE` accepts absent/`disabled` or exact `stored_chat_v1`; any other value fails before pool/timer creation. Disabled creates no pool, timers, queries or lazy database/provider import. Enabled requires explicit `GATEWAY_BILLING_MODE=stored_chat_only` and nonempty valid postgres/postgresql `DATABASE_URL`; local mode agreement is a startup check, not proof of deployment-wide exclusivity. No runtime settings are changed by this implementation.

Pool maximum1, connection timeout8000ms, server statement_timeout8000ms, client query_timeout9000ms. Queries execute sequentially and no transaction spans candidates. Pool options must be fixed by the capability, not overwritten by a connection URL's timeout/options parameters; reject conflicting URL parameters rather than claim a false timeout bound. Native test URL identity checks remain governed by existing test guard. Neither SQL errors nor URL are logged.

The SQL recovery result is projected to only `{org_id, api_key_id, billing_request_id, state, route_kind, billing_mode, outcome_kind}`. Strict parser requires exactly one plain row, canonical UUIDs matching the requested triple, and `settled/chat/stored/success`. Only that confirmed projection counts `settled`; malformed/lost ACK is `unconfirmed`, not inferred failure or no-effect. The SQL function remains the financial authority and validates the full stored evidence; the worker never recalculates amounts. Repeated SQL calls are safe because accepted DB locks and receipts own idempotency.

## Bounded selector and fairness

Hints are not grants. Prepared read joins admissions with same-owner HTTP request/result and quota-v2 context; requires `state='outcome_recorded'`, `outcome_kind='success'`, `route_kind='chat'`, `billing_mode='stored'`, nonnull `reconcile_after <= clock_timestamp()`, request contract1/chat/stored, result contract1/status200/JSON, quota_version2 and no rejection row. Do not filter revoked keys: existing owner accounting remains legal after revocation; SQL revalidates ownership. Missing or contradictory facts are skipped by selector or rejected by SQL, never repaired here. Valid expired result tombstones remain eligible; payload is not recreated.

One tick processes at most20 hints and uses a server-owned in-memory cursor `{afterBillingId, cycleUpperBillingId}`. At a new cycle capture the highest eligible billing UUID (descending order limit1); an empty snapshot ends the tick. Then select eligible UUIDs `> after` (or no lower bound) and `<= cycleUpper`, ascending, limit20. Both queries are prepared, no row locks or advisory locks. Preserve the captured upper across ticks. New/later-due IDs behind the cursor wait until the next cycle. Exact UUID ordering matches PostgreSQL UUID order; never compare UUID locale strings to invent DB ordering.

Validate every returned hint and the entire page before recovering any candidate: maximum20, canonical UUID triple, strict ascending IDs, no duplicates, exact cursor range. A malformed page is a fixed `selection_unavailable` result with no financial calls and unchanged cursor. After each valid candidate's success or caught error, advance in-memory `afterBillingId` to that candidate so one failing row cannot monopolize a page. A short/empty page or reaching upper resets the cycle after its valid candidates were considered. On restart cursor resets; revisits are safe. A bounded closed cycle prevents continuous arrivals from postponing earlier failures forever. Do not persist a second recovery state or add a migration.

Tick errors are isolated per item and emit only aggregate counts plus a fixed classification. Log no prompt, response, key, raw SQL/database error, upstream diagnostic or full DB row. Expose result counts `{selected, settled, unconfirmed}` and cursor for unit tests; no public HTTP endpoint. This runner does not resolve `held`/`dispatched` unknown outcomes or escalate them as settled.

## Scheduling and shutdown

Start one immediate tick after enabled initialization, then schedule the next tick with a60000ms delay after the current tick finishes. Do not use overlapping setInterval calls. Stop marks closing before clearing a timer; the current query/candidate may finish, but no next candidate/page starts. Close waits for the in-flight query/tick and closes the owned pool exactly once. Stop is idempotent; timer creation after stop is forbidden. Tests inject scheduler/DB seams, never start the entire worker with its unrelated queues.

Integrate the returned close handle into the existing `apps/worker/src/index.ts` shutdown list after validation. If initialization fails after pool creation, close that pool; index must not retain a partial handle. Default disabled index behavior remains unchanged. Source startup wiring is not runtime activation.

## Task 1: pure page loop and strict contracts

Files: create `apps/worker/src/queues/gateway-settlement-recovery.ts` and `apps/worker/src/queues/__tests__/gateway-settlement-recovery.test.ts`.

- [ ] Define mode parser, canonical hint/cursor/result parser and dependency-injected page loop with the exact limits/state above. No DB/provider/package import or bootstrap side effect in this module.
- [ ] RED: invalid mode/cursor/whole page rejected before recover; empty/short/full pages; fixed upper and inserted IDs; one failed item followed by successful item; unknown ACK advances only discovery cursor; restart/revisit; close during a candidate and repeated close.
- [ ] Implement minimal pure loop and nonoverlapping injected scheduling, sanitized counters/classification. No unbounded attempts or financial retry inside one item.
- [ ] Focused units and test/source types/lint; independent TypeScript/spec review before Task2.

## Task 2: native SQL capability and integration proof

Files: create `apps/worker/src/queues/gateway-settlement-recovery-db.ts`; create `apps/worker/src/queues/__tests__/gateway-settlement-recovery.native.integration.test.ts`; modify worker package/lock for exact existing pg dependency; add only necessary dedicated test tsconfig. Root database baseline registration may be amended only to include this guarded test without optional skip when explicitly invoked in the required native path; inspect existing runner before changing it and record exact ownership in task brief.

- [ ] Implement native pool factory, bound selector and one-call SQL recovery projection. Factory receives explicit trusted configuration; disabled mode must not invoke it. Keep query values parameterized and all driver errors classified without diagnostics.
- [ ] Unit-test exact SQL shape/params, resource options, result parser identity/state and cleanup after connection/query errors. Do not mirror SQL financial calculations in JS.
- [ ] Before native execution, audit guard ordering, marker, UUID fixture ownership, foreign sentinel, client cleanup and immutable-trigger preservation. Use current schema; no full migration run is needed for this additive worker slice.
- [ ] Native RED→GREEN: accepted outcome/result before settle → once-only settlement; two concurrent workers and replay/lost ACK produce one financial event and quota terminal effect; revoked owner key accounting; accepted expired payload tombstone; held/dispatched/cancelled/rejected/foreign/missing proof excluded; rollback error leaves outcome_recorded then next cycle settles. Use existing accepted native fixture helpers where import-safe, otherwise copy only narrow setup pattern and explain why. Do not disable triggers to invent impossible states.
- [ ] Native test must execute the new selector/adapter/loop with real PostgreSQL and fixed injected scheduling; testing only the old function is insufficient. Verify no provider dependency/call path exists, counts are ACK-based, failed prefix does not starve later owned rows, and all owned fixtures/resources are cleaned.
- [ ] Focused types/lint/native evidence and independent financial/spec review. Full unchanged DB baseline is not new proof and need not rerun unless the scope actually changes.

## Task 3: default-disabled bootstrap and acceptance record

Files: modify `apps/worker/src/index.ts`; create narrow bootstrap module/test if necessary; update `docs/product/acceptance/AG-P1.md` and canonical handoff only after independent source/runtime-seam review.

- [ ] Wire exact setting after shared env load, lazy-create the native pool only in enabled mode, add idempotent close handle to worker shutdown. Do not start paid/production runtime or change env files.
- [ ] Tests: disabled zero pool/query/timer; unknown mode and mismatched gateway mode fail before initialization; enabled bounded schedule; setup failure cleanup; graceful stop during item prevents remaining candidates and new timer; secret-free failure classification.
- [ ] Source/test types/lint, relevant worker regression and focused native gate if composition changed. One worker build only at final wiring if required for its import/output boundary.
- [ ] Record exact accepted source/checks and remaining gates. No claim of deployment-wide cutover, refund activation, full2B or full product readiness.

## Remaining release gates

Recovery of successful stored evidence can be implemented and reviewed locally. Before activating refund Tasks3–5, prove deployment-wide legacy-writer drain and authoritative quota opening balances/policies, then integrate confirmation/refund/webhook/UI as one reviewed release boundary. Other billable routes require their own admission/usage/async contracts; returning501 in restricted mode is a safety fence, not completion of the product's frozen v1 modalities. Mainnet, external payments and production changes retain separate authorization.
