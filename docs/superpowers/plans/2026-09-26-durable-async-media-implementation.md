# Durable Async Media Implementation Plan

> Use superpowers:executing-plans or subagent-driven-development. TDD first; one combined review at the end.

**Spec:** docs/superpowers/plans/2026-09-26-durable-async-media-lifecycle.md

### Task 1 — exact media quote + strict identities
- Create billing/media-unit-quote.ts and tests.
- Create billing/stored-media-http-identity.ts and tests.
- Extend resolver/fresh resolver only as needed to retain exact price_per_image + markup text and model_upstream_id.
- RED exact decimal pricing, overflow/invalid, image units n, route-specific canonical fingerprints, unknown fields/BYOK rejection.
- GREEN/types/lint.
- Commit feat(gateway): add exact async media identity and quote.

### Task 2 — migration0081 durable prediction ownership + storage
- Recheck manifest first.
- Create 0081_gateway_async_media.sql; extend schema predictionJobs additively and SQL mirrors/helpers.
- Create media request claim/read/result functions or typed TS wrappers with contractVersion4 and org-scoped task read.
- Add immutable billing_request_id/route/model_upstream/provider family+task/quotes/deadline/result digest/settled fields.
- Native RED: idempotent claim, changed body conflict, ownership, terminal transitions, no provider URL/error leakage, upgrade80->81/no-op81/checksums.
- GREEN native/types/lint.
- Commit feat(database): persist durable async media jobs.

### Task 3 — durable media submit attempt and route composition
- Create stored-media-attempt.ts + tests.
- Reuse quota v2 admission/dispatch/outcome/settle; extend supplier quote validation for route kinds image/video/audio_speech and media formula versions.
- Modify images/video/audio routes to new explicit mode only; older modes reject before provider.
- Exactly one pinned submit after dispatch; persist provider task before 202; enqueue owned poll job.
- Submit terminal completed uses same terminal sink; submit failure/ACK ambiguity holds/no retry.
- Add GET /v1/media/jobs/:taskId DB-only org-scoped route.
- Focused RED/GREEN + composition tests.
- Commit feat(gateway): mount durable async media submission.

### Task 4 — real upstream-poll DB sink/recovery
- Replace apps/worker upstream-poll bootstrap stubs with DB-backed loader/poller/sink for supported Kie media.
- Queue payload carries only owned job id; worker derives provider/task/family/deadline from DB, not caller-controlled queue data.
- Pending bounded requeue; completed exact settle; failed/deadline zero actual/full release; terminal replay/idempotency.
- Add scanner/re-enqueue for durable queued/processing rows lacking a live queue ACK.
- Worker unit/native tests including duplicate delivery, revoked key, settlement lost ACK.
- Commit feat(worker): settle durable async media jobs.

### Task 5 — mounted acceptance + baseline + review
- Guarded native fixture for image/video/audio speech with mocked Kie fetchUpstream and blocked external fetch.
- Prove 202 ownership, exact holds, DB-only GET, pending->completed, failure/deadline, duplicate poll, enqueue failure recovery, one ledger.
- Register suite in test:database-baseline via RED->GREEN config test.
- Run focused unit/native, gateway+worker source/test types, builds, lint, diff-check and amended DB baseline.
- One GLM final review: financial, SQL/recovery, secret/provider leakage, queue/runtime. One fix wave for Critical/Important.
- Update AG-P1, priorities, entrypoint with exact evidence. Commit docs(gateway): accept local durable async media lifecycle.
