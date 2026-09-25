# Durable Async Media Implementation Plan

> Execute with Superpowers TDD. One combined final review.

**Spec:** docs/superpowers/plans/2026-09-26-durable-async-media-lifecycle.md
**Base:** 3303d64

### Task 1 — exact media contract and shared admitted Kie mechanics
Create `packages/api-gateway/src/billing/media-price.ts` and `reviewed-media-profiles.ts` + tests for gateway-owned exact pricing/profile binding. Add the strict admitted-media request/result contract and Kie submit/poll implementation to shared `packages/upstream-adapters`, with its own tests; export it from that package. Gateway and worker must consume this one shared transport seam rather than maintain a second Kie implementation. RED exact retail/supplier math, reviewed bindings, one submit/no redirect/fallback/retry, strict task id, sanitized pending/completed/failed poll and bounds. Legacy adapter APIs remain unchanged. GREEN then commit `feat(media): add shared admitted async media mechanics`.

### Task 2 — prediction persistence + media quota/finalization
Create migration 0081, update schema and canonical admission/quota SQL mirrors, create typed media prediction DB module and native tests. RED claim race/fingerprint conflict, atomic claim+admit rejection, exact reserve/supplier reserve, dispatch once, submission idempotency/lost ACK reread, lease/takeover/backoff, completed atomic outcome+settle, failed verified_no_charge release, unknown hold, managed admin immutability, 80->81 apply/no-op/checksums. GREEN then commit `feat(database): add durable async media jobs`.

### Task 3 — DB-driven media worker
Create worker media-prediction DB adapter/loop/bootstrap tests. Default disabled; image_v1 then media_v1. RED due-only lease, pending reschedule, success/failure exactly-once finalization, ambiguous poll retry, deadline unknown, restart/takeover, stale lease owner reject. GREEN types/build/lint then commit `feat(worker): run durable media prediction polling`.

### Task 4 — image HTTP + mounted native
Create strict stored-media identity/http/fresh resolver/policy/attempt and route composition. Add mode `stored_chat_embeddings_completions_stream_media`. RED old modes501, new image POST202, concurrency provider1, changed body409, no funds/policy/PII before submit, owner GET, worker completion/replay receipt, terminal failure release, submit ambiguity hold/no resubmit. Mounted real Hono/Postgres/Redis with mocked external transport. GREEN then commit `feat(gateway): mount durable async image generation`.

### Task 5 — video and flat-price audio reuse
Extend only shared strict media mapping/profiles and mounted cases. Mount video/generations and audio/speech in media mode; transcription stays501. RED reviewed Kling and Suno lifecycle, unsafe overrides reject, replay provider1, exact separate price fixtures and owner GET. GREEN then commit `feat(gateway): extend durable media to video and audio`.

### Task 6 — final acceptance
Run focused unit/native, affected DB native + 0081 upgrade/no-op, strict gateway/worker types, builds, scoped lint/diff, root database baseline once. One GLM final review with financial/SQL/security/runtime lenses; fix Critical/Important in one TDD pass. Update AG-P1/entrypoint/priorities with exact evidence and remaining live-provider/production/STT/media-BYOK gates. Commit `docs(gateway): accept local durable async media lifecycle`.
