# AG-P1: покрытие денежных маршрутов — 28.09.2026

Это инвентаризация текущих исходников после принятого MC1–4, а не новая runtime/production-приёмка. Канон: [admission](../../superpowers/plans/2026-09-07-gateway-charge-admission.md), [mounted cutover](../../superpowers/plans/2026-09-08-stored-chat-public-cutover.md), [RUB refund](../../superpowers/plans/2026-09-06-topup-refund-clawback.md). Рабочий режим по умолчанию остаётся `legacy`; production настройки не менялись.

| Маршрут / режим | В legacy | В restricted `stored_chat_only` | Остаток |
|---|---|---|---|
| `/v1/chat/completions`, stored plaintext, non-stream | Provider до legacy settlement | Принят локально: durable identity, quota/hold, один dispatch, outcome/result, settlement/replay | Recovery source/bootstrap и общий baseline подтверждены локально20.09; operational cutover ещё впереди |
| Chat stream | Legacy streaming остаётся отдельным compatibility path | В новом `stored_chat_embeddings_completions_stream` принят локально durable SSE: strict terminal usage, один provider dispatch, stored replay и recovery | Runtime activation и real-provider compatibility остаются release gates; старые stored modes возвращают 501 |
| Chat BYOK | Provider до фиксированной platform fee | В `stored_chat_embeddings_completions_stream` принят локально durable non-stream BYOK: funded fixed-fee hold, один caller-key dispatch, stored result, settle/replay/recovery | Старые stored modes и stream+BYOK остаются 501; другие BYOK routes и real-provider/runtime — отдельные gates |
| `/v1/completions` | Provider до legacy settlement | В новом `stored_chat_embeddings_completions` принят локально: strict scalar prompt, durable identity/result, один dispatch, settle/replay/recovery | Stream, BYOK и batch prompts остаются отдельными путями; старые stored modes возвращают501 |
| `/v1/embeddings` | Provider до legacy settlement | 501 до provider | В новом `stored_chat_embeddings` lifecycle принят локально: claim/reserve/один dispatch/outcome/settle/replay/recovery; runtime gate остаётся |
| Images / video / audio speech | Submit/poll до settlement; queued job не связан с admission | В explicit `stored_chat_embeddings_completions_stream_media` принят локально durable async lifecycle: strict identity/idempotency, exact reserve, admission-linked `prediction_jobs`, opaque task id, DB-only GET, Kie poll/recovery и exactly-once settlement; старые stored modes остаются 501 | Runtime activation, real provider compatibility и production release остаются отдельными gates |
| Audio transcription | Локальная ошибка без provider | 501 | Не включённый платный путь, отдельный контракт до продажи |
| `/v1/batches` POST / summary / results GET | DB row и очередь без admission ownership | Старые stored modes: 501 до row/queue; в explicit `stored_chat_embeddings_completions_stream_media_batches` локально принят atomic per-item admission, ID-only queue, worker и DB-only GET | Runtime activation, real-provider compatibility и operator reconciliation остаются release gates |
| Models / balance / batch GET | Read-only | Сохранены read-only | Auth/tenant ownership сохраняются, execution admission не нужен |

Source anchors: `packages/api-gateway/src/server.ts`, `routes/v1/{stored-chat,chat,completions,embeddings,images,video,audio,batches}.ts`, `streaming/sse.ts`. Инвентаризация описывает достижимый source path при подходящем candidate; конкретная live availability моделей этим не проверялась.

## Embeddings checkpoint20.09

`a587e88` + merge `4a5acdb`: [stored embeddings contract](../../superpowers/plans/2026-09-20-stored-embeddings-lifecycle.md) выполнен локально, independent financial/TS APPROVE. Mounted6 подтверждают точные41/328→3/20, replay, auth, worker recovery после failure/revoke/expiry и unknown-dispatched hold. Общий native matrix341 подтверждён совокупно, TON core58, types/build/lint PASS; детали и artifacts в [каноническом checkpoint](../../consolidation/2026-09-20-priorities-and-routing.md).

Новый mode сохраняет chat, старый mode остаётся без embeddings. Runtime disabled; mock transport не означает real provider acceptance. Неизвестный post-dispatch outcome удерживает резерв до отдельного reconciliation решения; worker не угадывает расход.

## Completions checkpoint24.09

`3a717bf` + merge `5297623`: [stored completions contract](../../superpowers/plans/2026-09-20-stored-completions-lifecycle.md) выполнен локально, independent financial/SQL/security/TS APPROVE. Exact native proof:3457/19205→3/18, balance9997, release3454/19187, provider1/ledger1 при concurrent fresh и replay в новом app instance. Реальный worker восстанавливает durable outcome после settlement failure/revoke/expiry ровно один раз; malformed usage остаётся held и не redispatch. Cumulative native matrix350, TON core58, types/lint/build PASS. Production mode не включён; real provider call не выполнялся.

## Stored chat streaming checkpoint25.09

Source `23ce262`: [durable SSE contract](../../superpowers/plans/2026-09-24-stored-chat-stream-lifecycle.md) реализован локально. Новый explicit HTTP mode `stored_chat_embeddings_completions_stream` сохраняет принятые chat/embeddings/completions и добавляет только strict `stream:true` для reviewed `openai/gpt-4o-mini`; recovery mode `stored_chat_embeddings_completions_stream_v1` остаётся выключенным по умолчанию. Migration0079 additive; migrations до0078 не переписывались.

Fresh acceptance после final review-fix:
- focused gateway/worker streaming suite: 13 files / 402 PASS;
- mounted stream + полный HTTP-storage native: 73 PASS, из них mounted SSE 6/6;
- exact fixture: reserve3457/supplier19205 → actual3/18, replay receipt3/30, один provider effect и один ledger; disconnect после первого event не отменяет valid terminal evidence lifecycle;
- gateway+worker strict types PASS; gateway final build и scoped lint PASS;
- independent GLM-5.3-Flash review: Critical none; три Important coverage findings закрыты, scoped re-review — ADDRESSED/ADDRESSED/ADDRESSED, новых Critical/Important нет;
- review выявил реальный boundary defect: `stream:true,max_tokens:2049` проходил identity capture. Regression сначала RED, затем HTTP identity теперь отклоняет >2048 до durable read/claim.

Root database command в этой сессии показал test-infrastructure instability под высокой нагрузкой: первый прогон дал native16/356 PASS, затем historical TON child57/58; focused TON повтор58/58 PASS с cleanup dropped/sessions0. Второй прогон дал355/356 из-за другого historical entitlement test; тот же case focused1/1 PASS. Ни один из этих flakes не затрагивает streaming diff; точный root command не объявляется свежим exit0. Новый stream/native и затронутый storage gate подтверждены отдельно выше.

Граница остаётся локальной: runtime/production не включены, внешний provider transport mocked, платный вызов не делался. Async media/batches, real provider activation и AG→AM остаются следующими пакетами.

## Stored chat BYOK checkpoint25.09

Durable BYOK реализован последовательностью `fb8caad` → `540521e` → `204c4cd`/`f1f3509` → `129008d`, review-fix `edd365d`. Контракт — только non-stream chat в самом полном explicit mode: HTTP `contractVersion=3`, `billingMode=byok_fee`; raw `X-Upstream-Key` не попадает в durable state, fingerprint содержит только SHA-256 credential bytes. Admission использует существующую fixed platform fee, supplier reserve/actual остаётся 0; proxy/failover запрещены, provider вызывается только после confirmed dispatch.

Fresh evidence: post-fix scoped unit 11 files / 387 PASS; pre-review combined native HTTP storage68 + mounted BYOK4 =72 PASS; после review-fix отдельно подтверждены legacy stored boundary1, stream boundary1 и mounted BYOK4. Exact native fixture: default fee1 credit =1000 microcredits, balance5000→4000, supplier0, provider1/ledger1; changed caller key и stored/BYOK reuse одного chat idempotency key дают409. Provider error после dispatch сохраняет held/dispatched1000, result0/ledger0 и recovery selected0; forced settlement failure после durable result восстанавливается worker ровно один раз без второго provider call.

Migration0080: applied1/skipped79, затем no-op applied0/skipped80; historical migrations≤0079 не переписывались. Full scoped pre-review verification: gateway/worker source/test types, gateway+worker builds, lint и diff-check exit0. Review-fix дополнительно: affected78 PASS, mounted BYOK4 PASS, strict test types/lint/diff-check PASS; post-fix full BYOK unit снова 387 PASS, gateway source types и build exit0. Затем amended root `test:database-baseline` завершился полностью: 17/17 files, 362/362 native PASS, обязательный TON core child58/58 PASS, fresh72/no-op72, rollback/cleanup0, `FULL_BASELINE_RC=0`.

Independent GLM-5.3-Flash final review `006e9e52283648efbde7b20ced5d8c52` нашёл один Important: stream+BYOK классифицировался400 вместо frozen501. `edd365d` исправил boundary; scoped re-review `3616a07f63104acc955dd979c79ada76` — **APPROVE**, finding ADDRESSED, новых Critical/Important нет. Minor про теоретический `markGatewayChargeDispatched` replay в `held` оставлен в backlog: текущий durable claim допускает одного исполнителя и mounted concurrency не воспроизводит этот путь.

Это local source/native acceptance, не runtime/provider/production release. Stream+BYOK, embeddings/completions/media BYOK, encrypted key vault/UI и платный live provider остаются вне этого пакета.

## Durable async media checkpoint27.09

`2a490e1` → `0a2d6bf` реализуют [durable async media lifecycle](../../superpowers/plans/2026-09-26-durable-async-media-lifecycle.md) для image generation, video generation и audio speech в explicit `stored_chat_embeddings_completions_stream_media`. Public POST требует `Idempotency-Key`, BYOK/STT запрещены, task id opaque, GET читает только owned DB state и не poll-ит provider. Pricing и supplier reserve считают exact decimal DB text; image использует `n`, video/audio — единицу. Worker получает только owned job id, восстанавливает provider task из DB, bounded poll-ит Kie и terminal outcome проводит через один settlement path.

Final review-fix wave закрыла stranded claimed replay, lost settlement ACK, supplier rounding, Kie-only/no-egress boundary, worker `KIE_BASE_URL`, raw provider output sanitization и malformed JSON до admission. Fresh evidence: focused unit 10 files / 102 PASS; gateway src/test + worker + adapter types exit0; gateway+worker build PASS; supported gateway lint + `git diff --check` PASS; guarded root DB baseline 21/21 files / 374 PASS + isolated TON core58/58, cleanup dropped/sessions0/canonical unchanged. External GLM reviewer не вернул usable final report; Superpowers final self-review использован как fallback, поэтому это не independent approval.

Граница остаётся локальной: default runtime/production не переключён, paid provider call не выполнялся, egress proxy для durable media v1 fail-closed, STT/BYOK media остаются вне этого checkpoint. Durable batches приняты отдельным checkpoint ниже.

## Durable stored batches checkpoint28.09

`10dcced` → `0b0595b` → `43a3fb6` → `f6cc5f6` → `b949c80` реализуют [durable batch lifecycle](../../superpowers/plans/2026-09-27-durable-batch-lifecycle-implementation.md) в новом explicit mode. Строгая identity и вся подготовка предшествуют одной транзакции parent/items/per-item holds. POST возвращает202 только после ACK очереди, в job находится только opaque `batchId`; failed/completed retained job возвращается в ожидание атомарным BullMQ retry. Worker использует сохранённые provider request/quote и существующие admission primitives, не ищет цену в изменившемся каталоге. Pending sanitized evidence записывается до outcome, поэтому потерянный settlement ACK и осиротевший processing восстанавливаются без повторного provider вызова; неизвестный post-dispatch исход удерживает резерв для operator reconciliation.

Fresh acceptance: focused unit21 files/349 PASS; mounted guarded batch3/3, включая committed settlement→lost ACK→recovery, неизменный payg balance и один settlement event первого item, затем успешного queued-соседа при ровно двух provider вызовах на два item. Чистый временный PostgreSQL на guarded `127.0.0.1:15432/ai_aggregator_test`: migration0086 и вся цепочка86 applied, повтор86 skipped; обязательный root DB baseline24/24 files,388/388 tests и TON core58/58. Исходный test PGDATA восстановлен, marker/ledger snapshot совпал, Redis не переключался. Gateway source/test и worker types, gateway+worker builds, supported gateway lint и diff-check exit0; независимые financial/recovery и TypeScript reviews — APPROVE.

Это локальная source/native-приёмка. Default остаётся `legacy`, production migrations, paid provider transport и публичное включение нового mode не выполнялись. Поддерживаются только batch chat/embeddings/scalar completions без BYOK, streaming, tools и proxy. Следующий кодовый поток — AG→AM HTTP consumer и авторский/revenue lifecycle, а полный AG-P1/AG-P5 release gate остаётся открытым.

## Принятые локальные foundations

[Bounded settlement recovery](../../superpowers/plans/2026-09-13-gateway-settlement-recovery-runner.md) — **дизайн принят**: `ecfa54e`, независимый financial/spec и design-quality APPROVE, все I1–I6 закрыты. Task1 pure loop принят: `a8a297f` + `6355185` + `ee2332b`, independent TS/spec APPROVE, focused40/types/lint PASS. Task2 native DB capability принята: `f7b3775` + test-only fixes `421cbc6` / `32c1dd6`, independent financial/SQL/TypeScript PASS / APPROVE. Focused73, final native6, source/strict test types/lint PASS; failure-safe resource/sentinel cleanup и отдельный residual-row readback проверены. Task3 bootstrap/index source `5363069` прошёл independent TS/runtime/financial PASS / APPROVE: focused107 (bootstrap34), native6, source/test types/lint/build PASS. Нетестовый callsite подключён в исходниках, режим не включён; итоговый root baseline подтверждён20.09 после TON0076 (334 сценария совокупно, подробности в priorities checkpoint). Native DB capability вызывает существующую SQL authority0071, не создавая новую финансовую логику. Новый runner должен восстанавливать только `outcome_recorded` с уже сохранёнными и проверяемыми HTTP/quota facts; никаких повторных inference, новых outcomes или угаданных списаний.

Accepted refund DB primitives (`e5ca6dd`, migration0066 и `apps/web/src/lib/payments/topup-refund.ts`) сохраняются. Их не нужно писать заново. Tasks3–5 binding amendments реализованы20.09: actual Tinkoff confirmation, admin refund, webhook и billing summary прошли focused source-review; общие types/lint/build и native baseline подтверждены20.09 (см. [checkpoint](../../consolidation/2026-09-20-priorities-and-routing.md)). Ранний signed refund сохраняет durable grant-block marker, обе очередности native race подтверждены. До activation нужны deployment-wide drain legacy writers и авторитетные quota opening balances/policies. Один флаг одного процесса эти условия не доказывает.

## Исправленный отдельный дефект — только локальная source-приёмка

Дефект передачи BYOK key в legacy completions исправлен в `e5614e2`: тот же header используется для классификации и передаётся существующему адаптеру. Independent TypeScript/security/admission-boundary review — PASS / APPROVE. Focused24/types/lint PASS; route → real OpenRouter adapter → mocked transport с разными synthetic caller/platform keys подтверждает caller authorization, одну попытку, прежнюю BYOK fee и отсутствие списаний/счётчиков при provider error. Это не live provider proof. Registry всё ещё зависит от platform configuration; stored encrypted key flow не подключался. Старые restricted modes по-прежнему возвращают501 до provider; новый completions mode не поддерживает BYOK. Durable chat BYOK admission/fee lifecycle теперь принят отдельным checkpoint выше; BYOK для completions/embeddings/media остаётся открытым.

501 в restricted mode — временная граница безопасного запуска, не выполнение обязательных модальностей v1. Полные AG-04/09 и продуктовая приёмка остаются открыты; возвраты и production switch не активированы.
