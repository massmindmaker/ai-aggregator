# AG-P1: покрытие денежных маршрутов — 20.09.2026

Это инвентаризация текущих исходников после принятого MC1–4, а не новая runtime/production-приёмка. Канон: [admission](../../superpowers/plans/2026-09-07-gateway-charge-admission.md), [mounted cutover](../../superpowers/plans/2026-09-08-stored-chat-public-cutover.md), [RUB refund](../../superpowers/plans/2026-09-06-topup-refund-clawback.md). Рабочий режим по умолчанию остаётся `legacy`; production настройки не менялись.

| Маршрут / режим | В legacy | В restricted `stored_chat_only` | Остаток |
|---|---|---|---|
| `/v1/chat/completions`, stored plaintext, non-stream | Provider до legacy settlement | Принят локально: durable identity, quota/hold, один dispatch, outcome/result, settlement/replay | Recovery source/bootstrap и общий baseline подтверждены локально20.09; operational cutover ещё впереди |
| Chat stream | Legacy streaming остаётся отдельным compatibility path | В новом `stored_chat_embeddings_completions_stream` принят локально durable SSE: strict terminal usage, один provider dispatch, stored replay и recovery | Runtime activation и real-provider compatibility остаются release gates; старые stored modes возвращают 501 |
| Chat BYOK | Provider до фиксированной platform fee | 501 до provider | Отдельное резервирование platform fee; BYOK не бесплатен |
| `/v1/completions` | Provider до legacy settlement | В новом `stored_chat_embeddings_completions` принят локально: strict scalar prompt, durable identity/result, один dispatch, settle/replay/recovery | Stream, BYOK и batch prompts остаются отдельными путями; старые stored modes возвращают501 |
| `/v1/embeddings` | Provider до legacy settlement | 501 до provider | В новом `stored_chat_embeddings` lifecycle принят локально: claim/reserve/один dispatch/outcome/settle/replay/recovery; runtime gate остаётся |
| Images / video / audio speech | Submit/poll до settlement; queued job не связан с admission | 501 до provider/job | Durable async job, charge ownership, cancel/deadline/recovery |
| Audio transcription | Локальная ошибка без provider | 501 | Не включённый платный путь, отдельный контракт до продажи |
| `/v1/batches` POST | DB row и очередь без admission ownership | 501 до row/queue | Batch consumer и admission lifecycle |
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

Граница остаётся локальной: runtime/production не включены, внешний provider transport mocked, платный вызов не делался. BYOK, async media/batches, real provider activation и AG→AM остаются следующими пакетами.

## Принятые локальные foundations

[Bounded settlement recovery](../../superpowers/plans/2026-09-13-gateway-settlement-recovery-runner.md) — **дизайн принят**: `ecfa54e`, независимый financial/spec и design-quality APPROVE, все I1–I6 закрыты. Task1 pure loop принят: `a8a297f` + `6355185` + `ee2332b`, independent TS/spec APPROVE, focused40/types/lint PASS. Task2 native DB capability принята: `f7b3775` + test-only fixes `421cbc6` / `32c1dd6`, independent financial/SQL/TypeScript PASS / APPROVE. Focused73, final native6, source/strict test types/lint PASS; failure-safe resource/sentinel cleanup и отдельный residual-row readback проверены. Task3 bootstrap/index source `5363069` прошёл independent TS/runtime/financial PASS / APPROVE: focused107 (bootstrap34), native6, source/test types/lint/build PASS. Нетестовый callsite подключён в исходниках, режим не включён; итоговый root baseline подтверждён20.09 после TON0076 (334 сценария совокупно, подробности в priorities checkpoint). Native DB capability вызывает существующую SQL authority0071, не создавая новую финансовую логику. Новый runner должен восстанавливать только `outcome_recorded` с уже сохранёнными и проверяемыми HTTP/quota facts; никаких повторных inference, новых outcomes или угаданных списаний.

Accepted refund DB primitives (`e5ca6dd`, migration0066 и `apps/web/src/lib/payments/topup-refund.ts`) сохраняются. Их не нужно писать заново. Tasks3–5 binding amendments реализованы20.09: actual Tinkoff confirmation, admin refund, webhook и billing summary прошли focused source-review; общие types/lint/build и native baseline подтверждены20.09 (см. [checkpoint](../../consolidation/2026-09-20-priorities-and-routing.md)). Ранний signed refund сохраняет durable grant-block marker, обе очередности native race подтверждены. До activation нужны deployment-wide drain legacy writers и авторитетные quota opening balances/policies. Один флаг одного процесса эти условия не доказывает.

## Исправленный отдельный дефект — только локальная source-приёмка

Дефект передачи BYOK key в legacy completions исправлен в `e5614e2`: тот же header используется для классификации и передаётся существующему адаптеру. Independent TypeScript/security/admission-boundary review — PASS / APPROVE. Focused24/types/lint PASS; route → real OpenRouter adapter → mocked transport с разными synthetic caller/platform keys подтверждает caller authorization, одну попытку, прежнюю BYOK fee и отсутствие списаний/счётчиков при provider error. Это не live provider proof. Registry всё ещё зависит от platform configuration; stored encrypted key flow не подключался. Старые restricted modes по-прежнему возвращают501 до provider; новый completions mode не поддерживает BYOK. Route admission и резервирование BYOK fee остаются открытыми.

501 в restricted mode — временная граница безопасного запуска, не выполнение обязательных модальностей v1. Полные AG-04/09 и продуктовая приёмка остаются открыты; возвраты и production switch не активированы.
