# Stored Chat Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task.

**Goal:** Add locally accepted durable SSE for POST /v1/chat/completions with stream:true, exact terminal-usage billing, durable replay and settlement recovery, without runtime/production activation.

**Architecture:** Preserve accepted non-stream chat, embeddings and completions. Add explicit HTTP mode stored_chat_embeddings_completions_stream and worker mode stored_chat_embeddings_completions_stream_v1. A new admitted OpenRouter stream seam normalizes SSE; a two-phase attempt owns admit/dispatch then provider/outcome/settlement; contractVersion 2 selects the durable stream body. Additive migration 0079 extends storage/recovery only.

**Tech:** TypeScript, Hono, Zod, PostgreSQL 16, Redis, Bun 1.4.2, Vitest, existing fetchUpstream and gateway money primitives.

**Spec:** docs/superpowers/plans/2026-09-24-stored-chat-stream-lifecycle.md

## Global constraints

- Default legacy and all existing modes keep current behavior.
- No BYOK, media, batches, tools, sampling overrides, paid provider call, deploy or production migration.
- V1 stream is only reviewed openai/gpt-4o-mini through pinned OpenRouter/OpenAI policy.
- Request is strict stream:true; max_tokens is positive and <=2048.
- Provider call is one POST, include_usage:true, OpenAI-only, no fallback, redirects 0, retries 0.
- Proxy egress is rejected pre-dispatch; no buffer-guard bypass.
- Public SSE exposes normalized chat.completion.chunk only, followed by [DONE].
- Bounds: <=4096 events, <=65536 canonical bytes/event, <=524288 content bytes, <=1048576 stored body.
- Billing uses terminal trusted usage only. Never estimate tokens from deltas.
- After dispatch, client disconnect stops client writes only; provider/evidence continues.
- Missing terminal usage leaves dispatched/held; no guessed settlement, redispatch or refund.
- Same idempotency key stream vs non-stream chat conflicts; never two provider effects.
- Replay is selected by trusted contractVersion, not JSON-shape sniffing.
- Migrations <=0078 and accepted money formulas/tables are immutable.
- Heavy tests/builds are serialized with flock /tmp/ai-ecosystem-build.lock.
## Review focus

1. Malformed/missing terminal usage after dispatch must leave held/dispatched with zero guessed charge and zero retry.
2. Callback failure after first event must not stop provider drain or valid settlement.
3. Same-key stream/non-stream collision must yield conflict and one provider effect.
4. ContractVersion 1 replay must remain unchanged while contractVersion 2 replays SSE.
5. BYOK/proxy/unsupported fields must reject before provider or durable dispatch.

### Task 1 — admitted OpenRouter stream mechanics

**Files**
- Modify packages/api-gateway/src/upstreams/interface.ts
- Modify packages/api-gateway/src/upstreams/openrouter.ts
- Create packages/api-gateway/src/__tests__/openrouter-admitted-stream.test.ts

**Produces**
AdmittedChatStreamEvent, AdmittedChatStreamUsage, AdmittedChatStreamResult, AdmittedChatStreamMechanics, UpstreamAdapter.admittedChatStream.

- [ ] Write RED transport test with a real ReadableStream SSE response. Assert body stream:true, stream_options include_usage:true, max_tokens:10, provider only openai/no fallback/require parameters, maxRedirects 0.
- [ ] Write RED grammar test for roleassistant -> content deltas -> one finish -> one usage event -> [DONE]. Trusted usage must be 100/5/105/cached0 and final content hello.
- [ ] Write RED invalid/bound cases: malformed JSON/SSE, unknown provider/debug/reasoning fields, id/model/created drift, wrong choice index, content before role, duplicate role/finish/usage, missing usage, usage mismatch, cached>prompt, provider error, >4096 events, >64KiB event, >512KiB content, >1MiB stored body.
- [ ] RED command:
    flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator node_modules/.bin/vitest run --no-file-parallelism packages/api-gateway/src/__tests__/openrouter-admitted-stream.test.ts
- [ ] Implement minimal immutable stream types and bounded SSE decode. Do not touch legacy chatStream.
- [ ] GREEN focused test plus gateway source TypeScript.
- [ ] Commit: feat(gateway): add admitted chat stream mechanics
### Task 2 — durable stream attempt and exact billing lifecycle

**Files**
- Create packages/api-gateway/src/billing/stored-chat-stream-attempt-contract.ts
- Create packages/api-gateway/src/billing/stored-chat-stream-attempt.ts
- Create packages/api-gateway/src/billing/stored-chat-stream-http-contract.ts
- Create matching three unit test files
- Modify http-storage-result.ts, http-storage.ts, http-terminal-recovery.ts

**Produces**
StoredHttpChatStreamResponse, strict parser, createStoredChatStreamAttempt(args,deps), begin(), one-use runner.run(onEvent).

- [ ] RED durable body parser: exact {object:'aiag.chat.stream.v1', events, final}; reject unknown keys, event/final/usage disagreement and all bounds.
- [ ] RED two-phase lifecycle: begin completes admission + confirmed dispatch before SSE/provider run; run invokes provider once, forwards ordered events, persists full response, records trusted usage and settles once.
- [ ] RED disconnect: callback throws after event1 => no later client callback, but provider drain/outcome/settlement continues.
- [ ] RED unknown outcome: missing/malformed terminal usage => dispatched/held + reconciliation_required; no guessed actual cost, alternate writer or retry.
- [ ] Pin exact money: prices .015/.06, markup1.8, context128000, max_tokens10, usage100/5/cached0 => reserve3457, supplier reserve19205, actual3, supplier18, releases3454/19187.
- [ ] RED focused command runs stream contract/attempt/http-contract tests.
- [ ] Implement using existing quote/admission/dispatch/outcome/settle helpers; no new money arithmetic.
- [ ] Extend result/storage parser by contractVersion: v1 current chat, v2 strict stream. Never infer from response_body.object.
- [ ] GREEN focused plus existing stored-chat-attempt, http-storage and http-terminal-recovery tests.
- [ ] Commit: feat(gateway): add durable stored chat stream attempt
### Task 3 — migration 0079 and worker recovery v2

**Files**
- Create packages/database/migrations/0079_gateway_stored_chat_stream.sql
- Modify gateway-http-storage.sql, gateway-http-terminal-recovery.sql, and gateway-charge-admission.sql only if route/contract mirror requires it
- Modify native-migrate/native-baseline/storage/recovery tests
- Modify apps/worker gateway-settlement-recovery.ts, gateway-settlement-recovery-db.ts, gateway-settlement-recovery-bootstrap.ts and matching tests

**Produces**
DB acceptance of chat/stored contractVersion 2 and worker mode stored_chat_embeddings_completions_stream_v1.

- [ ] Execution-time manifest check: latest committed migration must be 0078. If 0079 is occupied, record a ruling and renumber; never rewrite <=0078.
- [ ] RED native SQL: v2 accepts only strict stream body; v1 remains valid; invalid event/final/usage rejects atomically; digest covers full body; read/recovery preserves version2.
- [ ] RED worker: dispatched v2 without coherent outcome is not selected; coherent outcome_recorded v2 settles once after revoke/expiry.
- [ ] RED config mapping: stored_chat_embeddings_completions_stream_v1 <-> stored_chat_embeddings_completions_stream, allowed routes chat/embeddings/completions, default disabled.
- [ ] Implement additive 0079 and SQL mirrors. Preserve embeddings/completions rules and all quota/admission formulas.
- [ ] Implement worker mode/result validation.
- [ ] GREEN focused DB/worker tests, worker TypeScript and scoped lint.
- [ ] Guarded upgrade 78->79 must apply exactly1; immediate no-op79 applies0/skips79; prior checksums unchanged. No production migration.
- [ ] Commit: feat(database): persist stored chat stream lifecycle

### Task 4 — HTTP identity, explicit mode, SSE projection/replay

**Files**
- Modify stored-chat-http-identity.ts, stored-chat-http-contract.ts, routes/v1/stored-chat.ts, config.ts, server.ts
- Create stored-chat-stream-http-identity.test.ts and stored-chat-stream-composition.test.ts
- Modify stored-chat-http-config.test.ts and stored-chat-http-terminal-seams.test.ts
- [ ] RED identity: contractVersion2 stays in chat/stored idempotency scope with terminal=true; same key stream/non-stream conflicts.
- [ ] Reject before provider/durable dispatch: max_tokens>2048, BYOK, tools/functions/tool_choice/media/audio, sampling overrides, unknown fields, forbid_streaming_prompts and proxy egress.
- [ ] RED composition: authoritative replay before fresh model/provider work; settled v2 replay emits exact data:JSON double-newline sequence + data:[DONE], billing id and receipt headers.
- [ ] Fresh stream: billing id + private no-store + text/event-stream, but no exact charge headers before terminal usage.
- [ ] Pending/rejected/expired remain fixed JSON before SSE starts.
- [ ] Implement strict v2 identity and route selection only in new explicit mode; old modes unchanged.
- [ ] Implement SSE writer/replay only from trusted normalized events; never raw provider chunks.
- [ ] Extend config/server mode registration without changing embeddings/completions registration.
- [ ] GREEN stream + existing chat/embeddings/completions composition/config/terminal seams, gateway source/test TypeScript, scoped lint.
- [ ] Commit: feat(gateway): mount durable stored chat streaming

### Task 5 — mounted native acceptance, baseline and evidence

**Files**
- Create stored-chat-stream-mounted.native.fixture.ts and stored-chat-stream-mounted.native.integration.test.ts
- Modify package.json
- Modify docs/product/acceptance/AG-P1-route-coverage.md
- Modify docs/consolidation/2026-09-20-priorities-and-routing.md
- Modify docs/DEVELOPMENT-ENTRYPOINT.md

- [ ] Build guarded fixture: real Hono/server/PostgreSQL/Redis/admitted stream adapter/durable writers/actual recovery worker; mock only fetchUpstream and block all other external fetch.
- [ ] RED happy path exact money: reserve3457/19205, actual3/18, balance9997, release3454/19187, provider1, ledger1, exact fresh SSE+[DONE], replay receipt3/30.
- [ ] RED idempotency/concurrency: same stream identity concurrent => provider1; changed body=>409; same chat key stream vs non-stream=>409.
- [ ] RED denials: no-funds/policy/proxy/BYOK pre-provider; expired=>410.
- [ ] RED unknown/disconnect: malformed/missing terminal usage stays held and worker selects0; disconnect after event1 still settles once if terminal usage arrives.
- [ ] RED actual worker recovery: force settle failure after durable result; first new-mode pass selected1/settled1, second selected0, ledger1/provider1; new app replays stored SSE with network blocked.
- [ ] Mounted GREEN command:
    flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator env RUN_NATIVE_DB_INTEGRATION=1 node_modules/.bin/vitest run --no-file-parallelism packages/api-gateway/src/__tests__/stored-chat-stream-mounted.native.integration.test.ts
- [ ] Register native file in test:database-baseline through RED->GREEN script/config test, before test:ton-core-native.
- [ ] Final scoped verification sequentially: Task1 transport; Task2 contract/attempt; Task4 HTTP/composition; mounted native; affected DB native storage/recovery; gateway+worker TypeScript; gateway+worker builds; scoped ESLint; git diff --check; amended database baseline once.
- [ ] One combined independent review only, with financial, SQL/recovery, security/provider-leakage and TypeScript/SSE lenses. Critical/Important => failing regression, one fix wave, focused rerun, one scoped re-review. Defer polish.
- [ ] Record exact commits/commands/counts, 0079 upgrade/no-op evidence, reviewer verdict and unresolved BYOK/media/batches/provider-runtime/production/AG->AM gates.
- [ ] Commit evidence: docs(gateway): accept local stored chat streaming lifecycle

## Final self-review

- Strict adapter/SSE, bounds, durable lifecycle, disconnect semantics, DB v2, worker recovery, HTTP replay, native evidence and docs all have owners.
- Scope excludes BYOK/media/batches/production and paid provider calls.
- 0079 is reserved only after execution-time manifest recheck.
- Stream/non-stream collision is pinned twice.
- Replay is selected by contractVersion, never JSON sniffing.
- Exact money values are pinned in Tasks 2 and 5.
- Historical modes/migrations are regression-protected, not rewritten.
- Review cadence is one combined end-of-package review as requested.
