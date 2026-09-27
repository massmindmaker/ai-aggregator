# Durable batch lifecycle — design

Дата: 27.09.2026.
Статус: approved design; implementation not started.
Base checkpoint: `2f6c15b` (local durable async media acceptance).

## Goal

Replace the legacy “persist row + enqueue raw requests + 202” batch producer with a durable paid batch lifecycle.
A successful public 202 must already own every item, every exact quote and every financial hold.
Worker execution may happen later, but it must never invent billing facts or retry an ambiguous provider call.

V1 supports homogeneous stored batches for:
- non-stream chat;
- embeddings;
- scalar non-stream completions.

Media-inside-batch, BYOK, STT, tools, streaming, files/S3 and webhooks are outside this package.

## Existing problem

Legacy `POST /v1/batches` writes one `batches` row, then puts the whole request array plus org/key identifiers into BullMQ.
There is no real `batch-process` consumer, no admission ownership and no terminal settlement.
Redis failure still leaves a durable row while the response can claim queued work.
Restricted stored modes therefore correctly return 501 before calling this producer.
## Public HTTP contract

New explicit mode: `stored_chat_embeddings_completions_stream_media_batches`.
All earlier stored modes keep batch POST unavailable before any row, queue, provider or charge effect.

`POST /v1/batches` requires:
- `Idempotency-Key`;
- JSON body with exactly `type` and `requests`;
- `type` is exactly `chat | embeddings | completions`;
- `requests` contains 1..100 items;
- total request body is bounded to 2 MiB before JSON parsing;
- `X-Upstream-Key` is forbidden.

Each item is exactly:
`{ "custom_id": <1..128 safe ASCII string>, "body": <strict operation body> }`.

`custom_id` is unique inside the batch.
Unknown keys reject before storage/admission.
The item `body` is normalized by the same strict stored body rules as the direct route.
Implementation may extract pure body normalizers from the current HTTP identity modules, but direct-route behavior must remain unchanged; batch code must not fake per-item HTTP idempotency headers.
Each item fingerprint is derived from parent identity + item index + custom_id + normalized body.
Chat is non-stream plaintext, completions uses one scalar prompt, embeddings keeps the accepted 1..16 input contract.

Parent batch identity is contractVersion 5 and billingMode `stored`.
Optional `X-AIAG-Session-Id` is captured by the existing declared-session rules, included in the parent fingerprint and applied to every item admission.
Its canonical fingerprint includes type, ordered custom IDs, declared session id and every normalized item body.
Same org + same Idempotency-Key + same fingerprint replays the same batch; changed body returns 409.
Public identifiers never expose DB UUIDs or provider IDs.
Batch id remains opaque `batch_<uuidhex>`.
Item identity is `custom_id` plus immutable array index; internal item UUID stays private.

Reads:
- `GET /v1/batches/:id` returns summary only;
- `GET /v1/batches/:id/results?cursor=<index>&limit=<1..10>` returns ordered item results;
- both are authenticated, org-scoped and DB-only;
- reads never poll a provider or enqueue work.

Public batch states:
`queued | processing | completed | completed_with_errors | failed | reconciliation_required`.
Public item states:
`queued | processing | completed | failed | reconciliation_required`.

## Financial contract

There is no parent batch charge and no batch-discount formula in V1.
Every item uses the exact existing direct-route quote, supplier quote and route kind:
- chat -> `chat`;
- embeddings -> `embeddings`;
- completions -> `completions`.

Exact DB decimal text remains pricing authority; JS float pricing is never billing authority.
Batch execution does not change formulaVersion, markup or supplier valuation.
The batch summary may expose the sum of settled item microcredits, but that sum is derived from item admissions/settlements, not a second ledger.
## Admission lifecycle before 202

The gateway first parses and normalizes the complete batch without writes.
It then resolves the accepted reviewed candidate and exact quote for every item.
V1 fails closed if any item needs BYOK, streaming, tools, unsupported parameters, per-candidate egress proxy or global egress proxy.

After preparation, one DB transaction:
1. claims/replays the parent batch identity;
2. inserts the durable batch container and immutable item rows;
3. creates one gateway charge admission per item using the existing V2 stored admission entrypoint;
4. records each item's pinned request/candidate/quote facts;
5. commits only if every admission is confirmed held.

If any item validation, policy, pricing, quota or funds check fails, the transaction rolls back the whole new batch.
There is no partial newly-created batch and no surviving hold from a rejected POST.

Only after commit does the gateway enqueue `{ batchId }`.
Queue payload contains no request body, org id, API-key id, quote, provider id or secret.
The BullMQ job id is deterministic from the owned batch identity so duplicate POST/scanner enqueue converges on one logical queue owner.
Successful enqueue returns 202.
Enqueue failure after commit returns fixed 503 `BATCH_RECONCILIATION_REQUIRED`; the durable batch and holds remain recoverable by scanner.
A same-key replay never recreates items or admissions. If the durable batch is nonterminal and queue ownership is missing, replay may re-enqueue only the batch id; terminal replay returns the stored summary without queue/provider work.

## Durable storage

Additive migration: `0085_gateway_durable_batches.sql`.
Historical migrations through 0084 are immutable.
Extend `batches` additively with durable-contract metadata while preserving historical rows:
- `contract_version SMALLINT NOT NULL DEFAULT 1`;
- `billing_mode VARCHAR`;
- `idempotency_key_digest TEXT`;
- `request_fingerprint TEXT`;
- `queued_at TIMESTAMPTZ`;
- `reconcile_after TIMESTAMPTZ`;
- `terminal_at TIMESTAMPTZ`.

Add `batch_items` with:
- internal UUID and parent `batches.id` FK;
- immutable `item_index`, `custom_id`, `route_kind`, `request_fingerprint`;
- strict normalized `request_body JSONB`;
- durable `billing_request_id UUID UNIQUE` and `attempt_id UUID`;
- pinned `model_slug`, `model_upstream_id`, `upstream_id`, `upstream_model_id`, `adapter_key`;
- item `status`, sanitized `output JSONB`, fixed `error_code`, `result_digest`;
- `deadline_at`, `settled_at`, timestamps.

Unique constraints: parent + item_index, parent + custom_id.
No raw API key, BYOK key, proxy credential, provider response blob or client-selected billing ID is stored.

The accepted request body is stored because the worker must execute after the HTTP request is gone.
It is the already-normalized public request body, not arbitrary JSON.
## Worker execution

`batch-process` becomes a real consumer.
V1 processes one item at a time per batch; worker concurrency may execute different batches in parallel.
After each item it re-enqueues or continues the same owned batch until no runnable item remains.

The worker loads all authority from DB using only the queued batch id.
It claims one queued item, reads its held admission and pinned facts, and uses the durable item `attempt_id`.
Before dispatch it must confirm the reviewed adapter mechanics and required platform provider configuration are available. Temporary pre-dispatch unavailability leaves the item queued/retryable until deadline.
Only then is dispatch confirmed with the existing `markGatewayChargeDispatched` before provider execution.

Provider mechanics are reused, not reimplemented:
- chat uses the accepted `admittedChat.execute`;
- embeddings uses the accepted `admittedEmbeddings.execute`;
- completions uses the accepted admitted chat mechanics and the existing strict completion projection.

The worker validates the same reviewed adapter contract and exact pinned model/candidate facts before dispatch.
Batch V1 does not persist proxy URLs and therefore fails closed before admission when egress proxying would be required.

After a validated provider response, existing exact usage/outcome rules record actual cost and settlement.
The sanitized direct-route DTO is stored as item output.
No raw provider metadata or provider error detail becomes public or durable output.

## Crash and ambiguity rules

A queued/held item may be retried safely before confirmed dispatch.
Once dispatch is confirmed, a worker retry must never call the provider again unless durable evidence proves no call was possible.
A crash or network ambiguity after confirmed dispatch therefore moves the item to `reconciliation_required` and keeps the hold.
Lost settlement ACK is recovered through the existing durable settlement recovery path without another provider call.
Pre-dispatch items that reach batch expiry are cancelled through the existing undispatched-admission cancellation path and become failed with fixed `BATCH_ITEM_EXPIRED`.
A dispatched ambiguous item is not refunded merely because the batch expiry passed.

A recovery scanner selects durable nonterminal batch containers that have runnable queued items but no reliable queue progress and re-enqueues only the batch id.
Scanner and duplicate delivery must be idempotent.

Batch status is derived from durable item states:
- all completed -> `completed`;
- all terminal and all failed -> `failed`;
- all terminal with mixed success/failure -> `completed_with_errors`;
- any reconciliation-required item -> `reconciliation_required`;
- otherwise any processing item -> `processing`;
- otherwise, if all remaining nonterminal items are queued -> `queued`.

## Result contract

Summary GET returns batch id, type, status, total/completed/failed/reconciliation counts, created/expires timestamps and derived settled microcredits.
`batch_items` is authority for status/counters; legacy aggregate columns on `batches` may be maintained transactionally as caches but must never disagree with item state in accepted tests.
Legacy `cost_rub` is not billing authority and is not used for V1 settlement.

Results GET is cursor-paginated by immutable item index, default/max limit 10.
Each row exposes `custom_id`, index, status, and only:
- completed: sanitized operation result + settled microcredits;
- failed: fixed public error code/message;
- reconciliation_required: fixed reconciliation error code/message;
- nonterminal: no output/error.

No provider task IDs, upstream IDs, raw usage diagnostics, internal DB UUIDs or secrets are public.
## Acceptance

1. Parent identity: missing/malformed key, unknown keys, changed replay, cross-org isolation and 2 MiB cap reject before writes.
2. Item validation: every operation reuses its direct strict body contract; duplicate custom_id or item101 rejects the whole batch.
3. Atomic admission: all item holds exist before 202; insufficient funds/quota on any item leaves no new batch/items/holds.
4. Exact money: direct and batch versions of the same item pin the same quote/formula and settle the same microcredits.
5. Queue safety: payload is exactly owned batch id; enqueue failure returns503 and scanner later restores work.
6. Worker lifecycle: partial success, explicit failure, expiry, duplicate delivery and restart do not double provider execution or settlement.
7. Ambiguity: crash/network uncertainty after confirmed dispatch leaves held reconciliation-required state and never redispatches automatically.
8. Reads: summary/results are org-scoped DB-only; GET creates no queue/provider effect and leaks no internal/provider fields.
9. Compatibility: earlier stored modes return fixed501 before batch state; legacy mode behavior is not silently rewritten by this package.
10. Final package gate: focused unit/native, worker/gateway types, builds, supported lint/diff-check, amended guarded DB baseline and one whole-branch review.

## Explicit non-goals

No 50,000-item inline payload, file ingestion, S3 output, webhook completion, cancellation API, priority scheduling or per-item custom provider selection.
No batch discount in V1.
No media, STT, stream, tools or BYOK inside a batch.
No production mode activation, paid provider call, deployment or production migration.

## Rejected approaches

One parent admission/one final batch charge was rejected because partial failure would require a second allocation/accounting model.
“Just add a consumer to the legacy producer” was rejected because it keeps 202-without-financial-ownership and raw queue payloads.
Media-inside-batch was rejected because media already owns an async job lifecycle and would create async-inside-async orchestration before it is needed.
## Review focus

The final reviewer must deliberately check:
- atomic rollback when item N admission fails after earlier item holds were created in the same transaction;
- crash windows around dispatch confirmation versus the first provider byte, ensuring retries never create a second inference;
- reuse of direct chat/embeddings/completions usage validation so batch cannot settle a provider shape the direct route rejects;
- idempotency races: two concurrent POSTs with the same parent key/body and same key/changed body;
- queue/scanner races and status aggregation under duplicate workers, including reconciliation-required items.

## Success criterion

The batch endpoint is locally accepted only when a 202 proves:
one durable batch container, one durable admitted owner per item, no request body in the queue, and a tested path from queued work to exactly one provider execution and exactly one settlement per completed item.

This design does not declare the full service production-ready.
After batches, the remaining Aggregator program continues with author/revenue lifecycle, AG→AM integration, TON/login/checkout and operational release gates.
