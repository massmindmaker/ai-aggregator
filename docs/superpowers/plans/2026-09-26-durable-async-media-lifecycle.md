# Durable async media lifecycle

Дата: 2026-09-26. Статус: controller-approved architecture for implementation after accepted BYOK checkpoint 3303d64.

## Goal
Replace restricted-mode 501 for paid async media with one real durable prediction lifecycle. Accept image first, then video and flat-price audio/music on the same persistence/worker/financial contract. Do not activate production, paid provider calls, media BYOK or STT.

## Runtime boundary
Add HTTP mode `stored_chat_embeddings_completions_stream_media`; every previous mode stays unchanged and default remains `legacy`.
Add worker mode `MEDIA_PREDICTION_WORKER_MODE=disabled|image_v1|media_v1`; default `disabled`.

## Storage boundary
Do not reuse `gateway_http_results` as the async job store. It models one request/terminal response, while media requires long-lived GET-visible jobs, leases, repeated polls and terminal state. Reuse charge admission/quota/settlement primitives; make `prediction_jobs` the durable media source of truth.

## Public v1 operations
Image POST accepts only: model, prompt, optional n=1, optional aiag_mode. Prompt is well-formed non-empty UTF-8 <=32768 bytes. Size, negative_prompt, reference_image_url, BYOK and unknown fields reject before durable state. First reviewed profile is `nano-banana-2-kie` -> upstream `kie` -> `google/nano-banana-2`.

Video POST is prompt-only v1. duration_s, aspect_ratio and image_url overrides reject. First profile: `kling-1-6-kie` -> `kling/v1.6`; existing price_per_image is one default clip price.

Audio speech POST is input-only v1. voice/format overrides reject. First flat-price profile: `suno-v3-5-kie` -> `suno/v3.5`, using existing per-generation price_per_image. Models priced only by price_per_audio_sec remain unavailable until trusted duration evidence exists. Audio transcription remains 501.

Fresh successful POST returns 202 with only our job_id, status, model, type and created_at. Never expose provider id/name, upstream task id, raw error or poll URL.

Owner-scoped GET:
- /v1/images/jobs/:id
- /v1/video/jobs/:id
- /v1/audio/jobs/:id

Public states: queued, processing, completed, failed, unknown. Completed returns sanitized data:[{url}] plus authoritative receipt. Failed is verified terminal no-charge. Unknown means provider outcome uncertain; hold remains and there is no automatic refund/resubmit.

## Identity
Require Idempotency-Key with the existing strict ASCII 1..128 contract. Canonical identity includes version, media kind, stored billing mode, model, mode/SID and normalized body. Store only SHA-256 digest/fingerprint.

Managed prediction jobs have unique scope (org_id,api_key_id,media_kind,idempotency_key_digest). Same key+changed body conflicts. Concurrent same identity returns the existing job and cannot create a second provider submit.

## Fresh model/policy/price
Use a direct fresh DB resolver, not legacy Redis cache. Read live model/type, model_upstream UUID, upstream/model ids, provider, RU residency, egress, exact price_per_image::text, price_per_audio_sec::text and markup::text.

Reuse stored policy semantics: whitelist/provider/RU/PII checks before reserve. Reviewed media profile binds exact model/upstream/upstream-model/adapter contract. No failover in v1.

Exact fixed-unit formula:
- retail microcredits = half-up(price_unit_cents * units * markup * 1000)
- supplier USD-micro = half-up(price_unit_cents * units * 10000)
- units=1 in v1
- reserve == successful actual retail
- terminal provider failure actual retail/supplier=0 and full hold releases
No Number-based monetary authority.

## Managed prediction_jobs
Migration 0081 extends additively with:
billing_request_id unique, media_kind, contract_version=1, idempotency_key_digest, request_fingerprint, model_upstream_id, upstream_model_id, attempt_id, pricing_snapshot, poll_family, fixed status contract, fixed error_code, poll_due_at/poll_attempts/poll lease owner+until/last_polled_at. Output is sanitized JSON only. Legacy rows remain readable.

Managed states:
claimed -> admitted -> dispatch_granted -> submitted -> processing -> completed|failed|unknown.

Existing admin retry/cancel endpoints must refuse managed v1 rows; provider cancellation is not supported in v1.

## Claim/admission/submit
A media-specific SQL claim/admit function owns idempotency and calls existing `aiag_admit_gateway_charge_v2` in the same transaction. Expected no-funds/quota/policy admission failures become durable fixed rejections without provider effect.

After admission, existing `markGatewayChargeDispatched` is the only submit grant. Then exactly one admitted provider submit runs.

Recording upstream_task_id is idempotent. If provider returned a task id but DB ACK is lost, reread the job: if the id is durable, replay it; otherwise leave dispatch_granted/unknown and never submit again.

Any post-dispatch submit ambiguity retains the hold.

## Worker
BullMQ delivery is not financial authority. Managed v1 jobs use a DB selector/lease with SKIP LOCKED and DB clock.

Pending poll -> reschedule with bounded backoff.
Completed -> sanitize HTTPS URL list, atomically record success outcome, settle exact fixed charge and mark completed.
Terminal failed -> atomically record verified_no_charge actual=0, settle/release and mark failed.
Network/schema ambiguity -> reschedule.
Operational deadline exceeded without trusted terminal evidence -> mark unknown and retain dispatched hold.

Finalization invokes accepted gateway outcome and settlement functions inside one DB transaction. A repeated committed finalization is idempotent.

## Quota evidence
Extend v2 quota validation for modelType image|video|audio and formula `db-media-fixed-unit-cents-v1`.
Snapshots contain exact model-upstream id, media kind, units, price decimal, markup, reviewed profile revision, adapter contract and upstream id. Usage evidence binds billingRequestId/attemptId/upstreamId/mediaKind/units/verified. Prompt/provider secrets never enter financial snapshots.

## Acceptance
- pure exact price tests incl half-up/overflow/noncanonical decimal
- strict admitted Kie submit/poll tests using mocked fetchUpstream only
- native claim/admit/dispatch/submission race/lost-ACK
- DB lease/takeover/restart
- completed exact charge; failed release; unknown hold
- mounted real Hono/Postgres/Redis POST+GET with mocked external transport
- concurrent/replay provider submit count=1
- old modes media501/default legacy unchanged
- video/audio reuse same money/storage worker lifecycle
- one combined independent financial/SQL/security/TypeScript review
