# Stored chat streaming: durable SSE lifecycle

Дата24.09. Статус: implementation contract следующего AG-P1 пакета. Base `c06254e`; chat, embeddings и scalar completions уже приняты локально. Scope — local source/native. Runtime activation, BYOK, платный provider call и production deploy исключены.

## Решение и граница

Legacy stream нельзя подключать к durable billing: он принимает `AsyncIterable<unknown>`, пропускает malformed JSON, оценивает токены по длине delta и swallow-ит settlement failure. Новый explicit HTTP mode `stored_chat_embeddings_completions_stream` добавляет только strict `stream:true` для `/v1/chat/completions`; прежние modes сохраняют текущую семантику. Worker mode `stored_chat_embeddings_completions_stream_v1` соответствует только этому HTTP mode и тем же routes `chat|embeddings|completions`; defaultdisabled сохранён.

Официальные OpenRouter API/SDK metadata24.09 подтверждают SSE chat и `stream_options:{include_usage:true}`. In-stream usage — capability metadata, а не доказательство provider execution или billing authority: [chat API](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request), [SDK chat](https://openrouter.ai/docs/client-sdks/python/api-reference/chat), [stream usage announcement](https://openrouter.ai/blog/announcements/smarter-charts-inline-svgs-and-live-usage-accounting/). V1 использует только reviewed `openai/gpt-4o-mini`/OpenAI endpoint policy из существующего profile; реальная совместимость остаётся activation gate.

## Frozen public contract

- Body — существующий strict stored-chat body с `stream:true`, без BYOK, tools, sampling overrides и неизвестных полей. `max_tokens` optional positive, но для stream v1 максимум2048. Well-formed messages/body caps и fresh auth/model/policy/PII guards прежние; `forbid_streaming_prompts` применяется до claim/provider.
- Identity contractVersion2, routeKindchat, billingModestored. Canonical tuple совпадает с chat v1, кроме terminal `true`; unique scope не включает contractVersion, поэтому тот же idempotency key между stream/non-stream конфликтует, а не запускает второй provider effect.
- Fresh request: claim → exact quote/reserve → confirmed dispatch → один pinned OpenRouter POST с `stream:true`, `stream_options:{include_usage:true}`, provider onlyOpenAI/no fallback/requireparameters, redirects0/retries0. Proxy egress сохраняет честный pre-dispatch `STREAM_NOT_SUPPORTED`; обходить buffer guard нельзя.
- Public SSE — только normalized OpenAI-compatible `chat.completion.chunk` JSON data и terminal `[DONE]`. Каждый event strict: общий id/created/model; choice index0; delta допускает только initial roleassistant либо non-empty content; ровно один terminal finish reason; terminal usage event имеет choices[] и exact prompt/completion/total + optional cached count. Provider/cost/reasoning/debug fields не выходят наружу.
- Adapter не пропускает malformed/unknown events. Он сохраняет ordered normalized events и строит sanitized final `chat.completion` response с concatenated content. Bounds: максимум4096 events, каждый canonical event≤64KiB, весь stored stream result≤1MiB, content≤512KiB. Нарушение после dispatch — unknown hold.
- Stored body exact: `{object:'aiag.chat.stream.v1',events:[...],final:<StoredHttpChatResponse>}`. SQL валидирует sequence/final/terminal usage against trusted usage, digest считает ORIGINAL stored stream body. Промежуточные chunks никогда не являются DB authority.
- Первичный fresh response заранее содержит billing request id, cache-control no-store и `text/event-stream`; точная стоимость неизвестна до terminal usage, поэтому cost headers на fresh stream не обещаются. Успешный replay синтезирует тот же ordered stored event sequence и `[DONE]`, уже с authoritative receipt headers. Pending/rejected/expired до начала SSE остаются fixed JSON responses. После отправки первого event HTTP status изменить нельзя.

## Abort, unknown outcome и replay

- До dispatch confirmed abort может отменить hold. После dispatch client disconnect прекращает только запись клиенту: provider stream дочитывается, terminal evidence сохраняется и рассчитывается. Если runtime/provider не даёт terminal evidence, admission остаётся `dispatched`; hold не освобождается, worker не выбирает его, provider не вызывается повторно.
- Lost ACK admission/dispatch/outcome/settle → reconciliation_required без fallback writer. Recovery-worker рассчитывает только coherent `outcome_recorded` stream result, включая revoked key и expired result tombstone, ровно один раз.
- Concurrent same identity даёт один provider POST. Повтор settled/expired не вызывает provider; settled replay выдаёт stored SSE sequence, expired возвращает410. Changed body/stream mode —409 в общей chat scope.

## Narrow implementation seams

1. Новый trusted `AdmittedChatStreamMechanics.execute(request,onEvent)` в interface/OpenRouter. Request переиспользует reviewed chat profile без BYOK; result возвращает normalized events, final response и trusted usage. Existing legacy `chatStream` не используется и не меняется.
2. Новые `stored-chat-stream-attempt-contract.ts`, `stored-chat-stream-attempt.ts`, `stored-chat-stream-http-contract.ts`. State machine повторяет accepted chat locks/writers, но разделяет `begin()` (admit+dispatch до SSE headers) и `run(onEvent)` (provider→atomic outcome→settle). После callback failure дальнейшие events не пишутся клиенту, но provider/evidence lifecycle продолжается.
3. Existing stored-chat identity получает trusted v2 stream parser/tuple без ослабления v1. Route composition выбирает final handler или stream handler по strict parsed identity. Replay projection выбирается по trusted contractVersion, не по форме body.
4. Additive migration0079 и affected SQL mirrors: identity v2chat/stored; stream response validator; record/read/recovery route+contract agreement. Historical migrations≤0078 immutable. Existing quota/admission formulas и tables не меняются.
5. Storage wrappers получают `StoredHttpChatStreamResponse` parser, но default remains chat v1. Worker selector/new explicit bootstrap pair допускает request contract1|2 and validates the matching response; routes remain unchanged. Unknown dispatched excluded.
6. Не создавать event table, queue, websocket, resume cursor или general streaming framework. V1 replay — вся сохранённая последовательность с начала; reconnect from offset deferred.

## Два владельца

- A durable/execution: admitted stream interface/OpenRouter + attempt/contract; migration0079/mirrors; storage/result/recovery/worker and focused tests.
- B HTTP/native: stream identity/HTTP projection/composition/config/server; mounted native fixture/suite and root registration. Владельцы не редактируют чужие файлы и сохраняют existing WIP. Controller выполняет один общий final check/review.

Freeze0 exports: `StoredHttpChatStreamResponse`, parser; `GatewayHttpIdentity` gains trusted contractVersion2 without changing default v1; `createStoredChatStreamAttempt(...).begin()` returns rejection/replay or a single-run runner; runner `run(onEvent)` returns settled/reconciliation. Exact event/result types live in upstream interface and are immutable.

## Acceptance

- Unit/transport: strict event grammar/order/bounds, pinned body includes usage, no retry/redirect/proxy streaming; malformed/missing/duplicate usage unknown without guessed tokens; callback/client abort does not stop evidence recording.
- Mounted real handler/app, PostgreSQL/Redis, real admitted stream adapter, mock only `fetchUpstream`, external fetch blocked. Synthetic tariffs and usage reuse chat fixture: input0.015/output0.06/markup1.8, context128000, max_tokens10, usage100/5/cached0 → reserve3457/supplier19205, actual3/supplier18, balance9997, release3454/19187. Initial stream exact normalized events+[DONE]; stored final response and ledger1.
- Concurrent same key/provider1; changed stream/body conflict; same key nonstream conflict; auth replaydeny. Fresh nofunds/policy/proxy denial before provider.
- New app settled replay returns identical event JSON sequence and receipt headers3/30 with provider1/ledger1. Client disconnect after first event still settles once when terminal evidence arrives. Missing usage remains held, actual worker selects0. Forced settle failure after durable result recovered by actual worker once after revoke/expiry; restart0.
- Upgrade78→79/no-op79, one updated database baseline, types/lint/gateway+worker builds. Successful prior suites are not repeated without affected code. One independent financial/SQL/security/TypeScript review after checks; only findings get focused rerun.

Готово, когда real mounted fresh SSE and stored replay are both proven, exact usage drives one durable charge, disconnect/restart do not duplicate provider or money, and old modes remain unchanged. Это local acceptance, не provider/runtime release.
