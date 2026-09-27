# AI Hub: текущая дорожная карта разработки

Срез на 27.09.2026. Источники истины — git и owner entrypoints трёх отдельных репозиториев: [Aggregator](../DEVELOPMENT-ENTRYPOINT.md), [Arena](/home/bob/Projects/aiarena/docs/DEVELOPMENT-ENTRYPOINT.md), [Agents Market](/home/bob/Projects/agents-market/docs/DEVELOPMENT-ENTRYPOINT.md). Стратегический порядок из [кооперативной карты](2026-09-07-cooperative-roadmap.md) сохраняется: **Aggregator → Arena → Agents Market**. Архив `aiag-web`, производные индексы и старые оценки готовности не заменяют текущий код и принятую приёмку.

## Где мы сейчас

| Продукт | Принято локально | Текущий незавершённый этап | Ближайший gate |
|---|---|---|---|
| AI Aggregator · C1 | RUB/TON correction, durable chat, embeddings, scalar completions, streaming, BYOK и async media до commit `2f6c15b`; последний media root DB baseline 374/374 + TON core58/58. Public runtime остаётся `legacy`, recovery `disabled`. | Durable batches на `feat/durable-batches-20260927`: Task1 `10dcced` и Task2 `0b0595b` приняты, Task3 migration0085/atomic storage — WIP в checkout. | Завершить Task3 с guarded native rollback/concurrency и exact writer checks; затем Tasks4–6: HTTP/queue, отдельный worker и scanner, mounted native. |
| AI Arena · C2 | Enrollment/team и final selection AR-P2.3; pure prediction scorer PE-T1. HEAD `c2f6559`. | PE-T2/PE-T3 evaluator binding и durable jobs ещё не приняты; приложение остаётся на сохранённом checkpoint. | Frozen opt-in binding → guarded DB job/ACL/quotas → bounded evaluator run/result/recovery. |
| Agents Market · C4 | Отдельная DB foundation, UUID scopes и native auth trust core T2.3a. | T2.3b HTTP/BFF и browser/private-domain gate не приняты; старые TMA routes всё ещё читают AG-owned model tables напрямую. | Native Web auth HTTP/guarded browser → AG catalog HTTP consumer без AG SQL → owned run/receipt/recovery. |

Все указанные проверки — локальные. Применение production migrations, платный provider run, mainnet и публичный release из них не следуют. Ветки Arena/Market после старой паузы доступны в общей программе по запросу пользователя, но основной ресурс остаётся у Aggregator до его C1 release gate; срочные денежные дефекты отдельного продукта можно исправлять без переноса его всего roadmap вперёд.

## Остаток до полного сервиса

Сейчас открыто **как минимум 16 крупных checkpoints**, а не 16 однотипных задач. Это счёт gate, не процент готовности или обещание срока; каждый gate включает собственные source, native, browser и operational доказательства.

| Очередь | Checkpoint и условие закрытия |
|---|---|
| AG-1 | Durable batches: один parent владеет всеми item holds; повтор/гонка и failed enqueue не создают двойной provider effect; real worker и scanner восстанавливают только доказанный outcome. |
| AG-2 | Настоящий AG→AM HTTP consumer каталога и receipt без прямого AG SQL в Market; строгие capability/price revision и unknown outcomes. |
| AG-3 | Авторский manifest → immutable executable version → продажа/usage → earnings/refund/payout; один независимый автор и crash/replay доказаны. |
| AG-4 | TON login/link и checkout/reconciliation alongside RUB с сохранением старых обязательств; testnet/операторские проверки отдельно от mainnet. |
| AG-5 | Оставшиеся обязательные modalities и состояния клиента: в частности transcription и ограниченные async paths, если они входят в продаваемый v1; 501 нельзя считать реализацией. |
| AG-6 | Операторское reconciliation неизвестных post-dispatch исходов, opening balances, rollback/runbooks и наблюдаемость фактически включённых маршрутов. |
| AG-7 | Покупатель/автор/админ UX, truthful claims, AG-P5 release artifact, backup/restore, pilot и отдельно разрешённое включение runtime. |
| AR-1 | PE-T2/T3 frozen binding и durable evaluation jobs с ACL, quota/CAS и native recovery. |
| AR-2 | PE-T4–T6 bounded evaluator, reproducible scorer, blind/RAG/agent methodology, contest result/appeal. |
| AR-3 | AR-P4 funding/prize/TON obligations и безопасные выплаты/reversal. |
| AR-4 | Consent/version-bound evidence export, интерфейс и release/pilot. |
| AM-1 | AM-P2 reservation/receipt/unknown/recovery без двойного settlement. |
| AM-2 | T2.3b native Web identity + AG catalog HTTP, устранение прямого AG DB доступа. |
| AM-3 | Первый useful agent: права/подключения → owned run → сохраняемый результат/стоимость → история в Web и TMA. |
| AM-4 | TON checkout только для Web; TMA использует owned run/status и legacy reconciliation без нового checkout. Авторские версии и денежные обязательства остаются в отдельном AM ledger. |
| AM-5 | Независимая Web и TMA acceptance, browser/private-domain, operator recovery и release/pilot. |

Переход C1→C2 требует не просто зелёных локальных тестов, а проверенного Aggregator release candidate и понятного AG catalog/version contract для Arena. Переход C2→C4 требует version-bound evidence и отдельного HTTP API; общая база, автоматический перенос private data и двойной учёт внутреннего AG→AM оборота в roadmap не входят.

## Критический путь и пять контролируемых рисков

Применена узкая адаптация [PMBOK 6 для агентов](https://github.com/mb-mal/pmbok6): для каждого ближайшего этапа нужен измеримый результат, владелец риска и следующее решение. Полный комплект из49 процессов здесь не требуется; BAC/PV/EV/AC не установлены, поэтому SPI/CPI и процент исполнения не вычисляются.

| Риск или зависимость | Триггер | Владелец и ответ |
|---|---|---|
| Batch item N оставляет деньги/parent от уже подготовленных items | Native rollback/concurrent test показывает хоть одну residual admission/reservation или двойной provider effect | AG gateway/DB owner: закрыть Task3 atomicity до Task4 и повторить только затронутый native gate. |
| Новый mode обходит admitted route или включает старые write routes | Mounted suite показывает dispatch до hold либо old mode отвечает успешным POST | AG gateway owner: fixed501/contract regression до worker cutover. |
| AG→AM consumer тянет прямой AG SQL и неверный price revision | В AM остаётся доступ к `models/model_upstreams` вместо HTTP receipt | AG catalog + AM HTTP owners: отдельный contract consumer и запрет AG DB credential у AM. |
| Arena принимает scorer как готовый evaluator | Нет DB job, ACL, retry/timeout и сохранённого version-bound результата | Arena owner: PE-T2/T3 native gate перед расширением методик. |
| Память или production status повышены без readback | Внешний индекс/LightRAG upload без processed/readback либо зелёный local test назван deploy | Controller: сохранить статус PENDING и владельца; источник истины — repo/acceptance, release только отдельным gate. |

Критический путь ближайшей разработки: **AG batch Tasks3→4→5→6→whole-package acceptance**, затем AG-P2 consumer/AG-P3 author evidence и AG-P5 release. Arena PE-T2→T3→T4–T6 следует после version contract; AM-P3 HTTP/Web следует после AG catalog consumer. Риски пересматриваются при каждом принятом checkpoint, без отдельной бюрократической волны.

## Контроль scope

- В текущем batch worktree нет признака новой billing authority: Task2 повторно использует chat/embeddings preparation, Task3 вызывает существующий `admitGatewayChargeV2` внутри одной транзакции. Дополнительный `pricing_snapshot` в item нужен для frozen dispatch/recovery. Task3 ещё не принят: WIP код и удачные отдельные тесты не заменяют финальный review.
- Не разворачивать отдельно уже принятые quota/refund/chat/embeddings/media основы и не повторять их полные аудиты без затронутого контракта. Для каждого следующего route достаточно одного законченного native money/failure proof и одного итогового независимого review.
- Исторические документы Arena/Market всё ещё говорят «пауза» на 13.09. Это сохранённый статус того дня; текущее решение возобновляет общую последовательную программу, но не присваивает их незакрытым задачам acceptance.
- Serena и Graphify остаются производной навигацией; LightRAG — общий семантический locator только после dedupe/readback; Memory Graph не записывается без проверенного namespace и конкурентной записи. [Проверка памяти 27.09](../consolidation/2026-09-27-memory-refresh-status.md) отделяет обновлённые индексы от двух заблокированных семантических слоёв.

Следующая точка пересмотра этой карты — принятие batch Tasks3–6 либо обнаруженный денежный/ownership дефект, который меняет критический путь. Иначе порядок AG→Arena→Market сохраняется.
