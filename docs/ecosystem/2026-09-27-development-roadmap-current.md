# AI Hub: текущая дорожная карта разработки

**Статус 28.09:** этот трёхпроектный срез сохранён как история. Активная цель владельца теперь ограничена [AI Aggregator](2026-09-28-aggregator-only-roadmap.md); Arena и Agents Market в неё не входят.

Срез на 28.09.2026. Источники истины — git и owner entrypoints трёх отдельных репозиториев: [Aggregator](../DEVELOPMENT-ENTRYPOINT.md), [Arena](/home/bob/Projects/aiarena/docs/DEVELOPMENT-ENTRYPOINT.md), [Agents Market](/home/bob/Projects/agents-market/docs/DEVELOPMENT-ENTRYPOINT.md). Стратегический порядок из [кооперативной карты](2026-09-07-cooperative-roadmap.md) сохраняется: **Aggregator → Arena → Agents Market**. Архив `aiag-web`, производные индексы и старые оценки готовности не заменяют текущий код и принятую приёмку.

## Где мы сейчас

| Продукт | Принято локально | Текущий незавершённый этап | Ближайший gate |
|---|---|---|---|
| AI Aggregator · C1 | RUB/TON correction, durable chat, embeddings, scalar completions, streaming, BYOK, async media и durable batches до `b949c80` приняты локально. Batch clean86 applied86/no-op86, root DB baseline388/388 + TON core58/58. Public runtime остаётся `legacy`; production не переключалось. | AG→AM catalog/receipt HTTP consumer и авторский/revenue lifecycle ещё не приняты; operator reconciliation и release gates открыты. | AG-P2 consumer contract без прямого AG SQL в Market; затем AG-P3 immutable author version→earnings/refund и AG-P5 release evidence. |
| AI Arena · C2 | Enrollment/team и final selection AR-P2.3; pure prediction scorer PE-T1. HEAD `c2f6559`. | PE-T2/PE-T3 evaluator binding и durable jobs ещё не приняты; приложение остаётся на сохранённом checkpoint. | Frozen opt-in binding → guarded DB job/ACL/quotas → bounded evaluator run/result/recovery. |
| Agents Market · C4 | Отдельная DB foundation, UUID scopes и native auth trust core T2.3a; AM SQL остаётся собственным. | T2.3b HTTP/BFF и browser/private-domain gate не приняты. Legacy AIAG worker уже вызывает AG chat по HTTP, но не читает `/v1/catalog`, не фиксирует revision/receipt и использует старые USD-micro headers. | Native Web auth HTTP/guarded browser → typed AG catalog/receipt HTTP bridge с durable run binding → owned run/recovery. |

Все указанные проверки — локальные. Применение production migrations, платный provider run, mainnet и публичный release из них не следуют. Ветки Arena/Market после старой паузы доступны в общей программе по запросу пользователя, но основной ресурс остаётся у Aggregator до его C1 release gate; срочные денежные дефекты отдельного продукта можно исправлять без переноса его всего roadmap вперёд.

## Остаток до полного сервиса

Сейчас открыто **как минимум 15 крупных checkpoints**, AG-1 закрыт локально. Это счёт gate, не процент готовности или обещание срока; каждый gate включает собственные source, native, browser и operational доказательства.

| Очередь | Checkpoint и условие закрытия |
|---|---|
| AG-1 · закрыт локально | Durable batches: один parent владеет всеми item holds; повтор/гонка и failed enqueue не создают двойной provider effect; worker/scanner восстанавливают только доказанный outcome. Evidence: `b949c80`, native3/3, clean86, baseline388/388 + TON58/58; runtime/production отдельно. |
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
| AM-2 | T2.3b native Web identity + AG catalog/receipt HTTP bridge; сохранить отсутствие прямого AG DB доступа и заменить legacy USD-micro inference headers. |
| AM-3 | Первый useful agent: права/подключения → owned run → сохраняемый результат/стоимость → история в Web и TMA. |
| AM-4 | TON checkout только для Web; TMA использует owned run/status и legacy reconciliation без нового checkout. Авторские версии и денежные обязательства остаются в отдельном AM ledger. |
| AM-5 | Независимая Web и TMA acceptance, browser/private-domain, operator recovery и release/pilot. |

Переход C1→C2 требует не просто зелёных локальных тестов, а проверенного Aggregator release candidate и понятного AG catalog/version contract для Arena. Переход C2→C4 требует version-bound evidence и отдельного HTTP API; общая база, автоматический перенос private data и двойной учёт внутреннего AG→AM оборота в roadmap не входят.

## Критический путь и пять контролируемых рисков

Применена узкая адаптация [PMBOK 6 для агентов](https://github.com/mb-mal/pmbok6): для каждого ближайшего этапа нужен измеримый результат, владелец риска и следующее решение. Полный комплект из49 процессов здесь не требуется; BAC/PV/EV/AC не установлены, поэтому SPI/CPI и процент исполнения не вычисляются.

| Риск или зависимость | Триггер | Владелец и ответ |
|---|---|---|
| Batch item N оставляет деньги/parent от уже подготовленных items | Native rollback/concurrent test показывает residual admission/reservation или двойной provider effect | AG gateway/DB owner: локально закрыто atomicity/recovery тестами и clean86 baseline; при release повторить на deployed candidate. |
| Новый mode обходит admitted route или включает старые write routes | Mounted suite показывает dispatch до hold либо old mode отвечает успешным POST | AG gateway owner: локально закрыто fixed501/mounted3; перед activation сверить фактическую конфигурацию. |
| AG→AM legacy HTTP-вызов пропускает catalog revision и durable receipt | AM worker использует старые USD-micro headers без сохранённой связи run↔AG billing request; retry может потерять исход или ошибиться в сумме | AG contract + AM worker owners: typed `/v1/catalog`/receipt client, persisted idempotency и fail-closed recovery; отсутствие прямого AG SQL сохранить. |
| Arena принимает scorer как готовый evaluator | Нет DB job, ACL, retry/timeout и сохранённого version-bound результата | Arena owner: PE-T2/T3 native gate перед расширением методик. |
| Память или production status повышены без readback | Внешний индекс/LightRAG upload без processed/readback либо зелёный local test назван deploy | Controller: сохранить статус PENDING и владельца; источник истины — repo/acceptance, release только отдельным gate. |

Критический путь ближайшей разработки: **AG-P2 HTTP catalog/receipt consumer → AG-P3 author/version/revenue evidence → AG-6 operator reconciliation → AG-7 release candidate**. Arena PE-T2→T3→T4–T6 следует после version contract; AM-P3 HTTP/Web следует после AG catalog consumer. Риски пересматриваются при каждом принятом checkpoint, без отдельной бюрократической волны.

## Контроль scope

- Принятый batch package не создаёт новую billing authority: общая chat/embeddings preparation и существующий `admitGatewayChargeV2` остаются единственными admission primitives. `pricing_snapshot` и `pending_evidence` фиксируют price/response для одного dispatch и доказанного settlement recovery; independent financial/TS reviews APPROVE. Чистая миграция и полный baseline подтверждены на временном guarded кластере; исходный локальный PGDATA восстановлен.
- Не разворачивать отдельно уже принятые quota/refund/chat/embeddings/media основы и не повторять их полные аудиты без затронутого контракта. Для каждого следующего route достаточно одного законченного native money/failure proof и одного итогового независимого review.
- Исторические документы Arena/Market всё ещё говорят «пауза» на 13.09. Это сохранённый статус того дня; текущее решение возобновляет общую последовательную программу, но не присваивает их незакрытым задачам acceptance.
- Serena и Graphify остаются производной навигацией; LightRAG — общий семантический locator только после dedupe/readback; Memory Graph не записывается без проверенного namespace и конкурентной записи. [Проверка памяти 27.09](../consolidation/2026-09-27-memory-refresh-status.md) отделяет обновлённые индексы от двух заблокированных семантических слоёв.

Следующая точка пересмотра этой карты — принятие AG-P2 consumer/AG-P3 author checkpoint либо денежный/ownership дефект, который меняет критический путь. Иначе порядок AG→Arena→Market сохраняется.
