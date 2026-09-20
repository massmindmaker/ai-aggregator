# AG-P1: покрытие денежных маршрутов — 13.09.2026

Это инвентаризация текущих исходников после принятого MC1–4, а не новая runtime/production-приёмка. Канон: [admission](../../superpowers/plans/2026-09-07-gateway-charge-admission.md), [mounted cutover](../../superpowers/plans/2026-09-08-stored-chat-public-cutover.md), [RUB refund](../../superpowers/plans/2026-09-06-topup-refund-clawback.md). Рабочий режим по умолчанию остаётся `legacy`; production настройки не менялись.

| Маршрут / режим | В legacy | В restricted `stored_chat_only` | Остаток |
|---|---|---|---|
| `/v1/chat/completions`, stored plaintext, non-stream | Provider до legacy settlement | Принят локально: durable identity, quota/hold, один dispatch, outcome/result, settlement/replay | Recovery source/bootstrap и общий baseline подтверждены локально20.09; operational cutover ещё впереди |
| Chat stream | Stream до settlement, есть оценка токенов по длине текста | 501 до provider | Проверенный final usage и admission/SSE/recovery contract; оценка не считается финансовым доказательством |
| Chat BYOK | Provider до фиксированной platform fee | 501 до provider | Отдельное резервирование platform fee; BYOK не бесплатен |
| `/v1/completions` | Provider до legacy settlement | 501 до provider | Body/identity/usage/admission; передача BYOK key исправлена локально в e5614e2 |
| `/v1/embeddings` | Provider до legacy settlement | 501 до provider | Pure quote есть; adapter/identity/outcome/mounted lifecycle ещё требуется |
| Images / video / audio speech | Submit/poll до settlement; queued job не связан с admission | 501 до provider/job | Durable async job, charge ownership, cancel/deadline/recovery |
| Audio transcription | Локальная ошибка без provider | 501 | Не включённый платный путь, отдельный контракт до продажи |
| `/v1/batches` POST | DB row и очередь без admission ownership | 501 до row/queue | Batch consumer и admission lifecycle |
| Models / balance / batch GET | Read-only | Сохранены read-only | Auth/tenant ownership сохраняются, execution admission не нужен |

Source anchors: `packages/api-gateway/src/server.ts`, `routes/v1/{stored-chat,chat,completions,embeddings,images,video,audio,batches}.ts`, `streaming/sse.ts`. Инвентаризация описывает достижимый source path при подходящем candidate; конкретная live availability моделей этим не проверялась.

## Следующий локальный этап

[Bounded settlement recovery](../../superpowers/plans/2026-09-13-gateway-settlement-recovery-runner.md) — **дизайн принят**: `ecfa54e`, независимый financial/spec и design-quality APPROVE, все I1–I6 закрыты. Task1 pure loop принят: `a8a297f` + `6355185` + `ee2332b`, independent TS/spec APPROVE, focused40/types/lint PASS. Task2 native DB capability принята: `f7b3775` + test-only fixes `421cbc6` / `32c1dd6`, independent financial/SQL/TypeScript PASS / APPROVE. Focused73, final native6, source/strict test types/lint PASS; failure-safe resource/sentinel cleanup и отдельный residual-row readback проверены. Task3 bootstrap/index source `5363069` прошёл independent TS/runtime/financial PASS / APPROVE: focused107 (bootstrap34), native6, source/test types/lint/build PASS. Нетестовый callsite подключён в исходниках, режим не включён; итоговый root baseline подтверждён20.09 после TON0076 (334 сценария совокупно, подробности в priorities checkpoint). Native DB capability вызывает существующую SQL authority0071, не создавая новую финансовую логику. Новый runner должен восстанавливать только `outcome_recorded` с уже сохранёнными и проверяемыми HTTP/quota facts; никаких повторных inference, новых outcomes или угаданных списаний.

Accepted refund DB primitives (`e5ca6dd`, migration0066 и `apps/web/src/lib/payments/topup-refund.ts`) сохраняются. Их не нужно писать заново. Tasks3–5 binding amendments реализованы20.09: actual Tinkoff confirmation, admin refund, webhook и billing summary прошли focused source-review; общие types/lint/build и native baseline подтверждены20.09 (см. [checkpoint](../../consolidation/2026-09-20-priorities-and-routing.md)). Ранний signed refund сохраняет durable grant-block marker, обе очередности native race подтверждены. До activation нужны deployment-wide drain legacy writers и авторитетные quota opening balances/policies. Один флаг одного процесса эти условия не доказывает.

## Исправленный отдельный дефект — только локальная source-приёмка

Дефект передачи BYOK key в legacy completions исправлен в `e5614e2`: тот же header используется для классификации и передаётся существующему адаптеру. Independent TypeScript/security/admission-boundary review — PASS / APPROVE. Focused24/types/lint PASS; route → real OpenRouter adapter → mocked transport с разными synthetic caller/platform keys подтверждает caller authorization, одну попытку, прежнюю BYOK fee и отсутствие списаний/счётчиков при provider error. Это не live provider proof. Registry всё ещё зависит от platform configuration; stored encrypted key flow не подключался. Restricted mode по-прежнему возвращает501 до provider; route admission и резервирование BYOK fee остаются открыты.

501 в restricted mode — временная граница безопасного запуска, не выполнение обязательных модальностей v1. Полные AG-04/09 и продуктовая приёмка остаются открыты; возвраты и production switch не активированы.
