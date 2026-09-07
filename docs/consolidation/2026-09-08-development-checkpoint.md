# AI Hub: принятая разработка 08.09.2026

Это первая волна 8 сентября. Актуальное продолжение: [bridge, settlement и Arena policy](2026-09-08-development-continuation.md). Нижеследующие «следующие этапы» относятся к моменту этого раннего снимка.

Приоритет: **AI Aggregator → AI Arena → Agents Market**. Кооперативные программы и мем-конкурс остаются в заделе. Эта волна — локальная реализация и независимая проверка; production/deploy/push, реальные платежи и платные upstream вызовы не выполнялись.

## Карты функционала

[Общий указатель](../ecosystem/functional-maps.md) ведёт к отдельным картам трёх продуктов. Каждая содержит 12 стабильных функциональных блоков, схему, текущее состояние, остаток и ссылки на принятые планы. AM дополнительно содержит Web/TMA/backend matrix. Карты не пересчитывают прежний F-срез43/22/39 из108 и не заменяют сквозную приёмку.

## AI Aggregator — Task6 принят локально

Коммиты `fdd8f22` и test-only `2aa3a7f`. Добавлены0068 и шесть quota tables: атомарный settled+reserved расход ключа/месяца, организации/дня и ключа/SID за всё время. Frozen supplier valuation — точная decimal arithmetic. Replay, policy locking, original-period settlement, cancel и refund сохраняют финансовые инварианты.0067 не изменена.

Независимые financial/spec и TypeScript review: **Approved**, Critical/Important нет. Найденный пробел в lost-ACK evidence исправлен: реальный commit, затем simulated application response failure, проверка observer и replay того же UUID без нового эффекта. Это не network-drop/power-loss test.

Проверки: clean replay68; baseline127/127; covering98/98; после test-only follow-up quota85/85; source и strict native TypeScript PASS. SQL после общего baseline не менялся. Старое предупреждение Vite CJS остаётся неблокирующим.

**Следующий этап:** typed v2 wrapper → trusted public plaintext route composition → HTTP idempotency и recovery/refund. Existing Task5 и публичные routes пока не подключены к v2. Production enrollment/opening balances/inflight cutover, provider reconciliation и остальные modalities требуют отдельной приёмки.

Неблокирующие улучшения: точные half-up/cache boundary regression cases; разделение растущего native harness при следующем расширении; Vite CJS warning.

## Agents Market — cleanup follow-up принят

Коммиты `fa9acd1`, `dbfe8e6`, `b2ebf85`. Общий absolute deadline для Web/TMA/fixture; TERM всем captured groups, затем KILL оставшимся, bounded identity checks. Сигналы не отправляются при недоказанной принадлежности группы; тогда возможна ручная адресная очистка.

Независимое повторное review: **Approved**, оба Important закрыты. Реальный regression с тремя TERM-resistant группами: старый cleanup4119ms превышает3000ms; новый2417ms, owned groups исчезают, unrelated sentinel жив. Clean1213ms и missing-clean1212ms. Native populated→stop: fixture ready→clean, remaining templates0, ports3100/3200 освобождены.

**Следующий этап:** открытый settlement CAS defect → authoritative usage/recovery → Web identity и полезный run. Cleanup не доказывает полный product lifecycle. Web всё ещё catalog/detail; полноценные auth/workspace/run/billing впереди. Неблокирующий test follow-up: отдельно сопоставить PID каждого server TERM, а не только общее число событий.

## AI Arena

Код в этой волне не менялся. Добавлена карта функционала и ссылка из entrypoint. Следующие gates: policy/deadlines → immutable submissions → sandboxed evaluator → результаты и appeals. TON funding/export следуют отдельно; production не перепроверялся.

## Среда и память

Восстановлен существующий guarded локальный PostgreSQL15432 и Redis16379, compatibility links к test helper; секреты не копировались в документы. Тяжёлые проверки выполнялись последовательно через общий flock. AM preview/fixture процессы после проверки остановлены и очищены. PG/Redis оставлены для продолжения разработки; production процессы не трогались.

Источники истины: code/commits, development entrypoints и принятые планы. Новые карты и этот чекпойнт обновлены; прежние Serena/Graphify индексы AG нельзя считать свежими после0068 без переиндексации. Внешняя синхронизация памяти подтверждается только readback; отсутствие такого подтверждения означает pending. Приватные raw logs/review packages остаются в .superpowers/sdd и не копируются в общую память.

Документатор завершил навигацию: Brain commit `40d040b` содержит ссылки на чекпойнт и три карты, сохранена приватная заметка. LightRAG locator остался PENDING: в текущем harness нет подтверждённого dedupe/readback; повторных загрузок не было. Memory Graph не изменялся. AG Serena/Graphify refresh остаётся PENDING.
