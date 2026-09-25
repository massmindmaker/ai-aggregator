# Durable async media lifecycle

Дата 26.09.2026. Статус: approved-by-controller implementation contract after local BYOK acceptance 3303d64.

## Goal

Restore image generation, video generation and audio speech as durable async paid capabilities. A successful public 202 must always have one durable financial owner and one durable prediction job. Worker polling is the only terminal owner. STT stays unavailable until a real reviewed upstream exists.

## Frozen contract

- New explicit HTTP mode: stored_chat_embeddings_completions_stream_media. Earlier modes keep media unavailable before submit.
- Routes: POST /v1/images/generations, POST /v1/video/generations, POST /v1/audio/speech and GET /v1/media/jobs/:taskId.
- Billing mode v1: stored only. Media BYOK remains unavailable in this package.
- Durable route kinds: image, video, audio_speech. HTTP identity contractVersion 4 is shared by media storage but route kind remains distinct.
- Idempotency-Key is required for POST. Canonical fingerprint includes route kind, model, aiag_mode and strict normalized body.
- Strict bodies:
  - image: model,prompt,n? 1..4,size?,negative_prompt?,reference_image_url?,aiag_mode?
  - video: model,prompt,duration_s?,aspect_ratio?,image_url?,aiag_mode?
  - audio_speech: model,input,voice?,format?,aiag_mode?
  Unknown keys reject before admission.
- No x-upstream-key/BYOK, no client-supplied billing ids, no raw provider poll URL in durable/public DTO.
- Candidate is selected before admission from existing registry/policy. V1 pins one candidate; no failover after admission.
- Pricing authority is exact decimal text from DB, never JS float. For image, units=n; video/audio speech units=1. Reserve = ceil(price_cents_per_unit * units * markup * 1000 microcredits/cent). Missing/zero/invalid price or markup fails closed before admission.
- Quote snapshot pins model id, model-upstream id, upstream id/model id, exact price text, exact markup text, units, route kind and formulaVersion media-unit-microcredits-v1.
- Supplier quote/reserve uses the same exact upstream cents before markup and formulaVersion media-supplier-unit-microcredits-v1.
- Admission is quota v2 stored. Supplier actual equals supplier reserve only on completed job; failed/deadline job records actual retail/supplier 0 and releases full holds.
- POST lifecycle: claim durable media request -> resolve/policy/quote -> admit hold -> confirmed dispatch -> exactly one provider submit -> atomically persist provider task id + prediction_job ownership -> enqueue poll -> return 202.
- A provider submit that returns terminal completed may be finalized through the same terminal sink before response; public response may be 200 completed. There is still one prediction_job and one settlement path.
- Provider submit failure/ACK ambiguity after confirmed dispatch leaves admission dispatched/held and no second submit. It is reconciliation-required, not automatic refund.
- prediction_jobs gains immutable ownership: billing_request_id, route_kind, billing_mode, contract_version, request_fingerprint, model_upstream_id, provider_family, provider_task_id, quoted retail/supplier microcredits, deadline_at, result_digest, settled_at. Historical columns remain for compatibility; cost_rub is not billing authority.
- Public task_id is our opaque task_<uuidhex>, never provider id. GET is authenticated org-scoped and reads DB only; it never polls provider synchronously.
- Worker upstream-poll loads job by owned DB id, validates status/ownership, calls the pinned adapter poll once, persists pending or terminal result. Pending requeue is idempotent and bounded by deadline.
- Terminal completed: sanitize output to URL list/string DTO, record charge outcome with exact quoted actuals, settle, mark job completed. Failed/deadline: record zero-cost terminal outcome, settle/release holds, mark failed. No raw provider error is returned publicly.
- Lost ACK after terminal DB outcome is recovered by existing settlement recovery; worker polling must not resubmit provider job.
- Queue enqueue failure after durable provider task persistence is not success-without-worker: POST returns 503 reconciliation_required and a recovery scanner can enqueue the owned pending job later.
- Additive migration 0081_gateway_async_media.sql; migrations <=0080 immutable.
- No production activation, paid provider call, deploy, BYOK media, STT, batches, S3 mirroring or external webhook completion in this package.

## Acceptance

1. Exact pricing calculator RED/GREEN including decimals, n=4, rounding half-up/ceil rule, overflow and invalid decimal.
2. Identity/idempotency tests per route, changed body conflict, cross-route separation, no secret/provider poll URL.
3. Native mounted submit: real Hono/Postgres/Redis/admission, mocked provider transport; 202 owns prediction_job + held quota before response.
4. Worker pending -> requeue; completed -> one outcome/settle/ledger; failed/deadline -> zero actual/full release; second poll/worker run cannot double settle.
5. GET returns queued/processing/completed/failed from DB and org isolation 404; provider network blocked during GET.
6. Crash windows: submit error after dispatch holds/no retry; enqueue failure leaves recoverable owned job; settlement failure recovered once.
7. Existing legacy/older stored modes return fixed unavailable before provider/queue.
8. One combined financial/SQL/security/runtime review after focused/native/types/build/lint/database baseline.
