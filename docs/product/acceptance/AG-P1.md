# AG-P1 — локальная приёмка денежного пути

Статус на 08.09.2026: **основание принято частями; весь AG-P1 ещё не принят**. По умолчанию chat сохраняет legacy execution. Ограниченный stored_chat_only маршрут теперь принят локально; live mode не переключался. Этот указатель связывает принятые узкие проверки с оставшимися продуктовыми критериями, без автоматического повышения 108-балльной оценки.

| Принятый блок | Source | Авторитетный контракт и evidence |
|---|---|---|
| Durable quota и executor bridge | `fdd8f22`, `2aa3a7f`, `20187ecd` | [Quota bridge](../../superpowers/plans/2026-09-08-quota-executor-bridge.md) |
| Постоянная HTTP identity в БД и атомарный sanitized result | `a6c0513` | [HTTP storage](../../superpowers/plans/2026-09-08-gateway-http-storage.md) |
| Типизированный bridge и единственный outcome writer | `77f0148` | [B1](../../superpowers/plans/2026-09-08-http-storage-gateway-bridge.md) |
| Canonical identity запроса | `f455318`, `b4ce9f3` | [B2](../../superpowers/plans/2026-09-08-stored-chat-http-identity.md) |
| Свежая проверка API-ключа | `0fde334` | [Fresh auth](../../superpowers/plans/2026-09-08-fresh-gateway-auth.md) |
| Неизменный admission reject и восстановление settlement | `a0b6eb8` | [C1a](../../superpowers/plans/2026-09-08-http-terminal-recovery.md): baseline263, native50, независимые review закрыты |
| Чистая native установка текущих миграций | `f4cd433`, SQL `a0b6eb8` | clean71: 71 apply, повтор71 skip; собственная временная БД удалена, canonical test DB неизменна; это не production runner parity |
| Типизированный C1b bridge и sole terminal seams | `0f0b395`, test fix `fb849ae` | [C1b](../../superpowers/plans/2026-09-08-http-terminal-recovery.md): baseline274/regression403 на candidate, final native12/types/lint и independent Approved |
| Mounted plaintext HTTP и native verification | `ac23cae`, harness `cd37771`, test fix `1c072b3` | [MC acceptance](../../superpowers/plans/2026-09-08-stored-chat-public-cutover.md): baseline315, final native46, types/lint и independent Approved; явные границы evidence и default legacy |
| TON invoice core | `c62ce98`, review-fix `724a031` | [AG-TON2](../../superpowers/plans/2026-09-08-ton-invoice-core.md): independent financial/TS re-review Approved; baseline12/322, migration72 applied1/skipped71, isolated native58 без skip, fresh72/noop72; own DB dropped/sessions0/canonical unchanged. Verifier, checkout, login, testnet/mainnet и production не приняты. |
| Durable async media | `2a490e1` → `0a2d6bf`, rounding `c38f7eb` | [Media lifecycle](../../superpowers/plans/2026-09-26-durable-async-media-lifecycle.md): image/video/audio speech в explicit media mode получили strict identity/idempotency, exact reserve, admission-linked `prediction_jobs`, Kie task ownership, DB-only GET, poll/recovery и exactly-once settlement. Fresh focused102, guarded DB baseline374/374 + TON58/58, gateway src/test + worker + adapter types, gateway+worker builds, supported lint и diff-check PASS. Production/runtime/paid provider не включались; внешний GLM final review не дал usable report, поэтому final fix-wave закрыт Superpowers self-review, не independent approval. |

## Открытые критерии

1. **C1b → mounted:** локальная связка принята в restricted plaintext режиме; production переключение остаётся открытым.
2. **Mounted HTTP:** локально подтверждены новый executor, replay до изменяемых моделей/политики, fresh auth/RPM, одно исполнение и списание при retry. Остались live rollout, opening balances и inventory/drain остальных writers; синтетический транспорт не доказывает production upstream.
3. **Полное покрытие денежных маршрутов:** включённые modalities используют новый учёт; неподдержанные пути закрываются до provider/queue. Временный plaintext gate не сокращает согласованный итоговый состав продукта ради балла.
4. **Receipt и восстановление:** клиент получает authoritative расход в точных единицах; supplier valuation отдельна. Неизвестный outcome не даёт права повторно запускать модель. Нужны operator reconciliation, refund/debt и переход opening balances.
5. **Сквозная приёмка:** пополнение RUB/TON → доступ → вызов → usage → возврат; независимый автор и earnings. Локальные synthetic fixtures не подтверждают платный upstream, mainnet или production.

Соответствующие группы [scorecard](../../ecosystem/aggregator-scorecard.csv): AG-02, AG-03, AG-04, AG-08, AG-11, AG-12. Строки I/T/O отмечаются PASS только по полному требованию конкретной строки, не по наличию отдельного низкоуровневого теста.

Текущий следующий шаг и принятые изменения всех продуктов: [continuation](../../consolidation/2026-09-08-development-continuation.md). Приватные task/review отчёты остаются в локальном `.superpowers/sdd`; они не копируются в общую память.
