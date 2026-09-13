# AG-P1: покрытие денежных маршрутов — 13.09.2026

Это инвентаризация текущих исходников после принятого MC1–4, а не новая runtime/production-приёмка. Канон: [admission](../../superpowers/plans/2026-09-07-gateway-charge-admission.md), [mounted cutover](../../superpowers/plans/2026-09-08-stored-chat-public-cutover.md), [RUB refund](../../superpowers/plans/2026-09-06-topup-refund-clawback.md). Рабочий режим по умолчанию остаётся `legacy`; production настройки не менялись.

| Маршрут / режим | В legacy | В restricted `stored_chat_only` | Остаток |
|---|---|---|---|
| `/v1/chat/completions`, stored plaintext, non-stream | Provider до legacy settlement | Принят локально: durable identity, quota/hold, один dispatch, outcome/result, settlement/replay | Фоновый вызов восстановления уже записанного outcome, затем отдельный operational cutover |
| Chat stream | Stream до settlement, есть оценка токенов по длине текста | 501 до provider | Проверенный final usage и admission/SSE/recovery contract; оценка не считается финансовым доказательством |
| Chat BYOK | Provider до фиксированной platform fee | 501 до provider | Отдельное резервирование platform fee; BYOK не бесплатен |
| `/v1/completions` | Provider до legacy settlement | 501 до provider | Body/identity/usage/admission; отдельное исправление передачи BYOK key |
| `/v1/embeddings` | Provider до legacy settlement | 501 до provider | Pure quote есть; adapter/identity/outcome/mounted lifecycle ещё требуется |
| Images / video / audio speech | Submit/poll до settlement; queued job не связан с admission | 501 до provider/job | Durable async job, charge ownership, cancel/deadline/recovery |
| Audio transcription | Локальная ошибка без provider | 501 | Не включённый платный путь, отдельный контракт до продажи |
| `/v1/batches` POST | DB row и очередь без admission ownership | 501 до row/queue | Batch consumer и admission lifecycle |
| Models / balance / batch GET | Read-only | Сохранены read-only | Auth/tenant ownership сохраняются, execution admission не нужен |

Source anchors: `packages/api-gateway/src/server.ts`, `routes/v1/{stored-chat,chat,completions,embeddings,images,video,audio,batches}.ts`, `streaming/sse.ts`. Инвентаризация описывает достижимый source path при подходящем candidate; конкретная live availability моделей этим не проверялась.

## Следующий локальный этап

[Bounded settlement recovery](../../superpowers/plans/2026-09-13-gateway-settlement-recovery-runner.md) — **дизайн принят**: `ecfa54e`, независимый financial/spec и design-quality APPROVE, все I1–I6 закрыты. Следующий шаг — Task1 pure loop; реализация ещё не принята. Принятая `recoverGatewayHttpSettlement` пока не имеет нетестового callsite. Новый runner должен восстанавливать только `outcome_recorded` с уже сохранёнными и проверяемыми HTTP/quota facts; никаких повторных inference, новых outcomes или угаданных списаний.

Accepted refund DB primitives (`e5ca6dd`, migration0066 и `apps/web/src/lib/payments/topup-refund.ts`) сохраняются. Их не нужно писать заново. Actual Tinkoff confirmation, admin refund, webhook и billing summary ещё требуют Tasks3–5 binding amendments. До activation нужны deployment-wide drain legacy writers и авторитетные quota opening balances/policies. Один флаг одного процесса эти условия не доказывает.

## Зафиксированный отдельный дефект

Legacy completions выбирает BYOK fee/single candidate, но не передаёт BYOK key в вызов адаптера. Это риск расхода platform credentials при BYOK fee semantics; restricted mode останавливает путь до provider. Исправление должно пройти отдельный regression и admission review, до разрешения этого маршрута. В этой документальной волне source маршрута не менялся.

501 в restricted mode — временная граница безопасного запуска, не выполнение обязательных модальностей v1. Полные AG-04/09 и продуктовая приёмка остаются открыты; возвраты и production switch не активированы.
