# AG-P1 — локальная приёмка денежного пути

Статус на 08.09.2026: **основание принято частями; весь AG-P1 ещё не принят**. Публичный chat продолжает legacy execution. Этот указатель связывает принятые узкие проверки с оставшимися продуктовыми критериями, без автоматического повышения 108-балльной оценки.

| Принятый блок | Source | Авторитетный контракт и evidence |
|---|---|---|
| Durable quota и executor bridge | `fdd8f22`, `2aa3a7f`, `20187ecd` | [Quota bridge](../../superpowers/plans/2026-09-08-quota-executor-bridge.md) |
| Постоянная HTTP identity в БД и атомарный sanitized result | `a6c0513` | [HTTP storage](../../superpowers/plans/2026-09-08-gateway-http-storage.md) |
| Типизированный bridge и единственный outcome writer | `77f0148` | [B1](../../superpowers/plans/2026-09-08-http-storage-gateway-bridge.md) |
| Canonical identity запроса | `f455318`, `b4ce9f3` | [B2](../../superpowers/plans/2026-09-08-stored-chat-http-identity.md) |
| Свежая проверка API-ключа | `0fde334` | [Fresh auth](../../superpowers/plans/2026-09-08-fresh-gateway-auth.md) |
| Неизменный admission reject и восстановление settlement | `a0b6eb8` | [C1a](../../superpowers/plans/2026-09-08-http-terminal-recovery.md): baseline263, native50, независимые review закрыты |
| Чистая native установка текущих миграций | `f4cd433`, SQL `a0b6eb8` | clean71: 71 apply, повтор71 skip; собственная временная БД удалена, canonical test DB неизменна; это не production runner parity |

## Открытые критерии

1. **C1b:** строгие TS wrappers, trusted seams и закрытая композиция с реальным postgres.js. SQL PASS не заменяет проверку binding, malformed driver rows и потери ACK в приложении.
2. **Mounted HTTP:** public route использует новый executor; replay проходит по сохранённой identity до изменяемых моделей/цен/spending guards. Fresh credential scope проверяется всегда. Один provider effect и одна финансовая проводка при retry/обрыве.
3. **Полное покрытие денежных маршрутов:** включённые modalities используют новый учёт; неподдержанные пути закрываются до provider/queue. Временный plaintext gate не сокращает согласованный итоговый состав продукта ради балла.
4. **Receipt и восстановление:** клиент получает authoritative расход в точных единицах; supplier valuation отдельна. Неизвестный outcome не даёт права повторно запускать модель. Нужны operator reconciliation, refund/debt и переход opening balances.
5. **Сквозная приёмка:** пополнение RUB/TON → доступ → вызов → usage → возврат; независимый автор и earnings. Локальные synthetic fixtures не подтверждают платный upstream, mainnet или production.

Соответствующие группы [scorecard](../../ecosystem/aggregator-scorecard.csv): AG-02, AG-03, AG-04, AG-08, AG-11, AG-12. Строки I/T/O отмечаются PASS только по полному требованию конкретной строки, не по наличию отдельного низкоуровневого теста.

Текущий следующий шаг и принятые изменения всех продуктов: [continuation](../../consolidation/2026-09-08-development-continuation.md). Приватные task/review отчёты остаются в локальном `.superpowers/sdd`; они не копируются в общую память.
