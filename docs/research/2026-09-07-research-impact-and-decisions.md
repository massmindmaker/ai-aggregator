# AI Hub: результаты исследований и изменения планов

07.09.2026. Документальный этап первой исследовательской волны выполнен. Выводы ниже определяют следующий локальный implementation scope через Superpowers; это не приёмка функций или production. Интервью, реальные пилотные измерения и новые платные операции не выполнялись. Кодовые чекпойнты и F43/22/39 не меняются от исследования.

**Главное решение:** сохранить три самостоятельных продукта и довести по одному полному пользовательскому пути в каждом. Добавить общий способ входа через TON-кошелёк, подтверждённые версии и квитанции, единое управление возможностями агента. Сохранить AM владельцем исполнения/прав/денег; Hermes интегрировать позже как изолированный сменный исполнитель. Проверку Arena развивать от небольшого воспроизводимого протокола к агентам/RAG и публичному сравнению. Это вывод по источникам и текущим пробелам, не доказанное предпочтение рынка.

## Что исследовано

| Артефакт | Выполненный объём | Практический результат |
|---|---|---|
| [Продукт, конкуренты и UX](2026-09-07-product-market-ux-findings.md) | Первичные материалы9релевантных продуктов, самостоятельные journeys, marketplace rights/version, Web/TMA IA и3пилотные гипотезы | Выбор стартовых задач, структура рабочего Web, понятное различие доступа и расхода |
| [Hermes:20семейств](/home/bob/Projects/agents-market/docs/research/2026-09-07-hermes-capability-matrix.md) | Pinned source: модели, tools/MCP/plugins/skills, память/history/files, delegation/schedules/channels, approvals, API/recovery/updates | Для каждого семейства adapt/build/defer/exclude и тест; установленная версия не выдаётся за готовую hosted платформу |
| [Arena: методики и конкурсы](/home/bob/Projects/aiarena/docs/research/2026-09-07-evaluation-and-contest-findings.md) | Papers/официальные методы, model/RAG/agent protocols, blind/contest lifecycle, evidence/export и abuse | Первый M1 pilot, затем R1/A1; объективный scorer, предпочтения и призы разделены |
| [Архитектура, TON и выпуск](2026-09-07-architecture-ton-and-delivery-findings.md) | TON Connect/nonce/network, доменные контракты, очередь/recovery, деньги, экономика, эксплуатация и будущие adapters | Общий login pattern, product-owned ledgers, concrete run/invocation boundaries и release prerequisites |

Предыдущее [исследование расширений](/home/bob/Projects/agents-market/docs/research/2026-09-07-providers-and-extensions.md) использовано как исходная опора. Новые документы содержат первичные ссылки и ограничения каждого вывода. Полная навигация источников — [sources.json](2026-09-07-wave1/sources.json).

## Что берём и почему

| Решение | Основание / ожидаемый эффект | Что изменяется в разработке |
|---|---|---|
| **D01. TON login во всех трёх продуктах** | Прямое новое указание пользователя; TON proof позволяет доказать контроль кошелька, но не оплату/право расхода | Добавить отдельный login/link/recovery brief и общий conformance contract; собственные сессии backend, сохранение existing IDs/history/entitlements |
| **D02. Первый AM сценарий — отчёт по предоставленным материалам** | Соответствует проверяемому outcome и ограниченным данным/tools; пользовательская ценность пока гипотеза R01/H1 | AM-P4 получает конкретные input→artifact→receipt и ошибки/уточнения вместо абстрактного «универсального агента»; формат входов ограничить в brief, без обещания всех типов документов |
| **D03. AG сначала обеспечивает управляемый текстовый API** | Уже принятый narrow executor можно довести до полного маршрута; marketplace конкурентов подтверждают необходимость price/capability/run contracts | Quota v2 → public composition/idempotency/recovery; rich catalog/tools для AM; paid playground использует пользователя и тот же receipt |
| **D04. Связанные версия, права и evidence** | Публикация, исполняемая версия и копия покупателя имеют разные lifecycle | Разделить listing/version/instance/entitlement; обновление показывает cost/permissions diff, Arena passport относится к точному digest, export создаёт draft |
| **D05. Connections как отдельная часть продукта** | Ключ/установка не доказывают availability или разрешение конкретного агента | Manifest/revision → account connection → agent binding → invocation record; probe/revoke/rotation/required-tool failure и одинаковая policy Web/TMA |
| **D06. Curated расширения в первом выпуске** | Меньше неподдерживаемых сочетаний и понятная проверка прав; не требуется полный перенос персонального runtime | API-key providers с tested capabilities, ограниченные built-ins, curated remote MCP, read-only skills; сохранять журнал внешнего эффекта до его вызова |
| **D07. Hermes через настоящий async run API после базы AM** | Есть полезные runs/status/events/stop/approval/idempotency, но interruption не равно безопасному replay | Отдельный изолированный bridge pilot после AM-P2/P4, затем measured startup/RAM/cost/isolation; AM остаётся authority денежного расчёта |
| **D08. Arena начинает с воспроизводимого M1** | Ground truth позволяет проверить инфраструктуру и качество без единственного LLM judge | Immutable submission + bounded model job + deterministic re-score; RAG, agent state oracle и blind preference следуют отдельными protocols |
| **D09. Работа и результат — центр Web** | Реальные задачи требуют входов, progress, истории, approvals и сохранённого artifact | AM Web получает рабочую область, своих агентов, подключения, историю/расходы и автора. Перестройка вкладок TMA — гипотеза IA для проверки, не уже принятое удаление кошелька |
| **D10. Общая дизайн-семантика** | Узнаваемость и одинаковые состояния полезны; устройство каталогов и Arena различается | Общие роли tokens/components/motion/a11y с версиями; локальная реализация по repo. Новый нормативный DESIGN/token пакет — после API/state сверки, без макетов сейчас |
| **D11. TON payments по общему контракту, обязательства по продуктам** | Предотвращает неоднозначность «кто вернёт деньги» и повторный зачёт общей транзакции | Product-owned invoice/ledger/refund/payout; общий recipient только с единым owner chain inbox/dedupe. RUB сохранён, существующие AM обязательства не конвертируются автоматически |
| **D12. Измерять полезный результат** | Источники не доказывают спрос/маржу нашего продукта | H1–H3 с baseline и denominator; price policy после фактических components cost и поддержки; независимость Arena score от комиссии marketplace |

Каждое D-решение — направление реализации/проверки. Выбор внешнего провайдера, цена, комиссия, пользовательский SLA и точная схема миграции требуют своего brief и evidence; здесь они не выдумываются.

## Изменения существующих планов

| Проект / прежний следующий шаг | Конкретная поправка после research | Проверяемая приёмка |
|---|---|---|
| **AG-P1**, quota и routes | Порядок сохранить; явно включить идентичность всех попыток/fallback/auxiliary и единый пользовательский receipt | Ни одного оплачиваемого обхода admission; replay/unknown не повторяет dispatch; суммы exact |
| **AG-P2**, HTTP catalog | Цена/возможности/availability revision и run tools договорены с AM до удаления его foreign SQL | Producer/consumer malformed/unauthorized/unavailable tests; совпадающий capability и receipt |
| **AG-P3**, автор | Формализовать license/access, immutable version, publication probe, update/withdrawal и Arena evidence | Нельзя продать неподключённый endpoint, перенести чужие данные/рейтинг или молча изменить версию |
| **AG-P4/P5**, TON и выпуск | Вынести wallet sign-in в независимый auth brief; связать RUB и TON с одним stable product user | Новый/существующий wallet account, linking conflict/replay/recovery; вход не зачисляет деньги, checkout не подтверждает login |
| **AM-P1/P2**, cleanup и settlement | Известные дефекты остаются первыми; за ними durable run/invocation и authoritative receipts | Закрыто Important cleanup review; failed→completed запрещён; restart/side-effect/charge replay проверены |
| **AM-P3**, native Web и HTTP | Добавить TON login и versioned connections, dual-proof Web/TG/wallet linking; wallet binding не считать готовым login | Чужие IDs/alias/replayed proof/conflicting account/network/expiry не дают доступ; Web работает без Telegram |
| **AM-P4**, useful run | Поставить «материалы → проверяемый отчёт → artifact/receipt», scoped connections и одну согласованную версию агента | Reconnect/unknown/approval/revoke/expiry/required MCP outage, private history/KV/files isolation, Web/TMA parity |
| **AM-P5**, author/TON | Разделить access price и compute; version/update/rent obligations, frozen payout recipient | Пользователь понимает счёт; доход pending/available/reversed; право/история не исчезают при снятии listing |
| **AM-P6**, UX/release | Принять рабочую IA/API states, затем общий DESIGN; Hermes bridge и расширенные packages — отдельные последующие задачи | H1/H2 outcome evidence, desktop/mobile/TMA usability, truthful claims; витрина не закрывает Web workspace |
| **AR-P2**, конкурсное ядро | Сначала deadline/rules/immutable submission; бесплатный M1 технический pilot. TON login — отдельный auth slice без изменения команд | Foreign/frozen/late submissions reject; реальный job, terminal/recovery/ACL и повторяемый scorer |
| **AR-P3**, качество | Явная последовательность M1→R1→A1; blind отдельно; uncertainty и границы endpoint неизменности | Нет наследования score новой версией; public/final leak tests; все заявленные методики проходят собственный gate |
| **AR-P4/P5**, призы/export | Отдельно eligibility/appeals/award/payout; сначала opt-in export точной версии в draft | Funding coverage и split зафиксированы; dispute блокирует выплату; повтор export не дублирует draft |

Приоритет первого узкого исправления не меняется ради исследования всего рынка. Новые продуктовые срезы требуют использования соответствующих D/R-IDs. Отсрочка в первом пилоте **не отменяет** согласованные функции и исходную108-приёмку полного продукта.

## Что откладываем и что исключаем из выбранного подхода

После базового useful run: изолированный Hermes provisioning; несколько MCP на агента; package importer/marketplace; team sharing; автоматическое обновление/renewal; большие visual builders; новые каналы. До доказанной потребности не вводим общий workflow engine, Kubernetes, agent fan-out без общего бюджета, автоматическое обучение на пользовательских данных или общий переводимый баланс.

Будущие A2A/x402/AP2/agent wallet adapters сохраняются в архитектуре как ограниченные интерфейсы; они не находятся на критическом пути v1. Будущий внешний аудит не считается состоявшимся. Отдельный testnet pilot и conformance должны предшествовать реальным средствам.

Исключаем из принятого подхода: login по одному присланному адресу; повтор неизвестного денежного/внешнего эффекта; plaintext credentials в manifests/prompts; arbitrary plugins в shared worker; автоматическую публикацию private traces; единый score для несопоставимых методик; рейтинг по популярности вместо quality evidence. Stars по прежнему исключены из реализации; новое исследование не меняет проверенные границы каналов.

## Статус всех18исследований после волны

| R | Достигнуто сейчас | Что ещё открыто |
|---|---|---|
| R01 | Выбраны3стартовые роли/JTBD как гипотезы | Интервью, фактическая частота проблемы и готовность платить |
| R02 | Три standalone journey и3добровольных cross-product пути | Operation-by-operation coverage полного scope и пилот |
| R03 | Предложение v1 access/version/clone/author lifecycle | Лицензии, точные коммерческие условия, права конкретных авторов |
| R04 | Документальный срез9конкурентов готов | Авторизованный UX/региональная доступность, demand validation |
| R05 | Карта20семейств pinned Hermes готова | Поинтеграционные trials, стоимость и hosted production readiness |
| R06 | Модель connections/bindings/invocations и curated v1 | Конкретный adapter список по пилоту, OAuth clients, conformance |
| R07 | IA/state/action/permission desk-матрица AM | API сверка, usability validation; полноценный Web ещё не написан |
| R08 | Согласуемые semantic/motion/a11y принципы | Нормативный versioned DESIGN/tokens и визуальная приёмка |
| R09 | Архитектурные направления и contract ownership | Детальные schemas/ADR integration tests и миграционные briefs |
| R10 | TON auth/link threat cases + connection boundaries | Полный threat model, negative tests, recovery usability |
| R11 | Runtime выбор, session/memory/artifact gaps | Реальное восстановление/ACL, bridge spike и benchmark |
| R12 | M1/R1/A1, blind/contest/evidence desk-срез готов | Dataset/gold labels, scorer calibration, real jobs и validity |
| R13 | Уточнён shared TON login/payment split и chain owner | Verifier/testnet/finality/payout evidence, внешние условия выпуска |
| R14 | Модель unit economics и исключение внутреннего двойного учёта | Измеренные расходы, цены/маржа/лицензии и коммерческая проверка |
| R15 | Конкретные recovery/telemetry/release требования; fresh health AG | Backup restore, capacity, SLO, устранение deployment конфликтов |
| R16 | H1–H3, события/знаменатели и критерии пересмотра | Baseline и реальные наблюдения пользователей |
| R17 | Now/next/later adapters и triggers пилота | Свежая проверка каждой технологии перед включением, cost/benefit |
| R18 | Context7/primary docs и pinned Hermes сверены | Полная lockfile/API compatibility matrix и исполняемые тесты |

## Контроль качества и источников

Независимый review итоговой карты и architecture/financial границ — APPROVE. После добавления TON source delta, уточнения quota/денежного refund и D-задач в трёх production plans выполнено повторное read-only review — APPROVE. Это приёмка документов, не кода или production. Проверка новых/изменённых локальных ссылок: 69, пропусков нет; реестр содержит 65 уникальных внешних URL с provenance и 7 локальных source refs.

Три независимых Astra research ветки плюс интегратор сопоставили product/runtime/evaluation с текущими code checkpoints. Найдены расхождения Lindy homepage/detailed guardrails, старого builder/current docs, Dify listing/runtime version, Hermes multiplex docs/code и Context7/TON auth пример против полного server lifecycle. Это ограничивает выводы; страницы одного поставщика не считаются независимыми подтверждениями спроса.

Данные для H1–H3, размер модельного набора Arena и предлагаемые thresholds — наши планы эксперимента, не опубликованные результаты. Разные технические стартовые задачи допустимы: M1 проверяет structured extraction, AM пилот — полезный отчёт; они соединятся через версии/evidence позже, а не искусственно считаются одним пройденным E2E.

Первичные ссылки находятся рядом с фактами в четырёх отчётах; общий [реестр источников](2026-09-07-wave1/sources.json) сохраняет provenance и указывает reused/queried/source-only. Методология Deep Research адаптирована к одобренной структуре репозиториев: Brain содержит ссылки, а не вторую копию исследования. Совпадение документации с кодом не является runtime proof.

Следующее продолжение: [чекпойнт](../consolidation/2026-09-07-pause-checkpoint.md) → релевантные R/D-решения → узкий Superpowers brief → изменения и focused review/tests → evidence. Полную программу перечитывать для каждой небольшой правки не требуется. Общая память обновляется по правилам [MEMORY-STATUS](../consolidation/MEMORY-STATUS.md), без секретов и сырых рабочих журналов.
