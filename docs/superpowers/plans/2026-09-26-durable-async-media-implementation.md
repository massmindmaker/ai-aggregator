# Durable Async Media Implementation Plan

> Execute with Superpowers TDD. One combined final review.

**Spec:** docs/superpowers/plans/2026-09-26-durable-async-media-lifecycle.md
**Base:** 3303d64

### Task 1 — exact media contract and shared admitted Kie mechanics
Create `packages/api-gateway/src/billing/media-price.ts` and `reviewed-media-profiles.ts` + tests for gateway-owned exact pricing/profile binding. Task 1 reviewed profiles are image `nano-banana-2-kie` -> `nano-banana-2` and video `kling-1-6-kie` -> current provider id `kling-2.6/text-to-video`; audio transport/profile is deferred to Task 5 because the current Kie music API has moved to `ai-music-api/generate` + V6-family input. Add strict admitted-media image/video request/result contract and Kie submit/poll implementation to shared `packages/upstream-adapters`, with its own tests; export it from that package. Gateway and worker must consume this one shared transport seam rather than maintain a second Kie implementation. RED exact retail/supplier math, reviewed bindings, one submit/no redirect/fallback/retry, strict task id, sanitized pending/completed/failed poll and bounds. Legacy adapter APIs remain unchanged. GREEN then commit `feat(media): add shared admitted async media mechanics`.

### Task 2 — prediction persistence + media quota/finalization
Create migration 0081, update schema and canonical admission/quota SQL mirrors, create typed media prediction DB module and native tests. RED claim race/fingerprint conflict, atomic claim+admit rejection, exact reserve/supplier reserve, dispatch once, submission idempotency/lost ACK reread, lease/takeover/backoff, completed atomic outcome+settle, failed verified_no_charge release, unknown hold, managed admin immutability, 80->81 apply/no-op/checksums. GREEN then commit `feat(database): add durable async media jobs`.

### Task 3 — DB-driven media worker
Create worker media-prediction DB adapter/loop/bootstrap tests. Default disabled; image_v1 then media_v1. RED due-only lease, pending reschedule, success/failure exactly-once finalization, ambiguous poll retry, deadline unknown, restart/takeover, stale lease owner reject. GREEN types/build/lint then commit `feat(worker): run durable media prediction polling`.

### Task 4 — image HTTP + mounted native
Create strict stored-media identity/http/fresh resolver/policy/attempt and route composition. Add mode `stored_chat_embeddings_completions_stream_media`. RED old modes501, new image POST202, concurrency provider1, changed body409, no funds/policy/PII before submit, owner GET, worker completion/replay receipt, terminal failure release, submit ambiguity hold/no resubmit. Mounted real Hono/Postgres/Redis with mocked external transport. GREEN then commit `feat(gateway): mount durable async image generation`.

### Task 5 — video reuse and current audio contract
Mount video/generations on the shared lifecycle using the reviewed current Kling binding. For audio, first bind the current Kie Market music API (`ai-music-api/generate`, V6-family nested model) and a current explicit tariff in an additive migration; do not reuse retired `suno-v3.5` identifiers/pricing. If the current tariff cannot be verified, keep audio/speech truthful 501 and record the external tariff as a release blocker rather than inventing money. Transcription stays501 until a reviewed STT capability exists. RED unsafe overrides reject, replay provider1, exact video/audio price fixtures only when authoritative, and owner GET. GREEN then commit `feat(gateway): extend durable media to video and audio`.

### Task 6 — final acceptance
Run focused unit/native, affected DB native + 0081 upgrade/no-op, strict gateway/worker types, builds, scoped lint/diff, root database baseline once. One GLM final review with financial/SQL/security/runtime lenses; fix Critical/Important in one TDD pass. Update AG-P1/entrypoint/priorities with exact evidence and remaining live-provider/production/STT/media-BYOK gates. Commit `docs(gateway): accept local durable async media lifecycle`.
