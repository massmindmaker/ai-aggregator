# AI Hub: приоритеты и проверка маршрутизации 20 сентября 2026

Пользователь возобновил общую программу трёх сервисов с первым приоритетом AI Aggregator. Этот порядок заменяет формулировку «только Aggregator» от13.09, но не означает одновременный запуск работ во всех репозиториях. Архив aiag-web — только история.

## Каноническая последовательность

| Очередь | Источник | Следующий результат |
|---|---|---|
| 1. Aggregator — каталог | 19.09 resume plan, 13.09 public catalog contract, AG-P2 | Довести сохранённый native matrix: bounds, lifecycle/readiness, stale cursor, advisory GET→POST и immutable financial snapshots; independent review |
| 2. Aggregator — расчёты | AG-P1 route coverage, [stored embeddings lifecycle](../superpowers/plans/2026-09-20-stored-embeddings-lifecycle.md) | После итоговых RUB/TON проверок — mounted embeddings с admission, сохранённым результатом и recovery; уже принятый chat recovery не писать повторно |
| 3. Aggregator — продукт | Production continuation AG-P3/P4/P5 | Авторская версия→доход, TON alongside RUB/login, modalities/UX и сквозная приёмка |
| 4. Arena | Собственный entrypoint и prediction evaluation plan | Executable scorer/hash и opt-in binding→DB jobs→sandboxed evaluator→результат |
| 5. Agents Market | Собственный native-account-principal/Web plan | HTTP/security review→guarded auth browser→UUID domain/worker→AG HTTP integration и independent Web/TMA acceptance |

TON0076 прошла итоговое source-review: прежние шесть HIGH закрыты, в том числе получение времени после ожидания row lock; ошибка TypeScript исправлена. Native evidence: 14 существующих сценариев и новая группа expiry/takeover PASS. Это снимает блокировку общего database baseline, который поставлен в очередь после итоговой сборки; его результат пока не получен. Selector, pg adapter, bootstrap/index и replay settlement recovery уже реализованы и приняты — писать их повторно не требуется. Runtime recovery остаётся выключен; включение и проверка на стенде — отдельный operational шаг. Новых RPC не было.

План19.09 — порядок ближайших пакетов, а не замена полной product programme07.09. В частности, авторский lifecycle AG-P3, остальные оплачиваемые маршруты AG-P1 и UX/release AG-P5 не исчезли из объёма. Исторические числовые оценки не являются сегодняшними процентами готовности.

## Что остаётся в полной программе

- Aggregator AG-P1: stream, BYOK, completions, embeddings, media/async и batches ещё требуют собственного admission/outcome/recovery; restricted501 означает закрытую возможность, а не реализованный сценарий. Accepted quota/refund primitives заново не писать. AG-P2 — каталог и настоящий AM consumer; AG-P3 — авторские версии/доход; AG-P4 — TON с сохранением RUB; AG-P5 — modalities, truthful UX и release.
- Arena AR-P2 — полный конкурсный lifecycle, AR-P3 — доказательство качества (модели/агенты/RAG, reproducibility), AR-P4 — funding/payout, AR-P5 — export и выпуск. Pure scorer и выбранный JSON пока не означают выполненный evaluator.
- Market AM-P2 — деньги и recovery run, AM-P3 — HTTP/Web identity, AM-P4 — useful agent и автор, AM-P5 — TON Web и owned-run/status TMA, AM-P6 — release и цикл оценки. Уже принятый DB baseline AM-P1 не повторять без причины.

Источники: собственные production-continuation планы07.09 каждого репозитория; текущие owner checkpoints и AG-P1-route-coverage уточняют их старые checkbox-состояния. Общая cooperative-roadmap задаёт зависимость Aggregator→Arena→Market, но не заменяет индивидуальную приёмку.

## Проверенный исходный срез

- Aggregator: c440ebb; prior c25cb8c catalog consumer contract134/native4 accepted locally. c440ebb исправляет исторический TON2 migration snapshot в тестовых orchestrators; проверка текущего результата выполняется отдельно.
- Arena: c2f6559; accepted pure scorer, DB jobs/evaluator ещё открыты.
- Market:94b5b45; HTTP source и browser launcher WIP сохраняются, browser/private-domain acceptance открыты.
- TON0076 и финансовые WIP файлы Aggregator не приняты и не изменяются каталоговым пакетом. Migration0074/75 неизменяемы; новых RPC нет.
- Production/mainnet/платные product-provider вызовы не запускались. Local test evidence не заменяет release.

## Router и контекст

Единственный источник маршрутизации: /home/bob/Projects/library/skills/model-router/SKILL.md v2.1. Astra High — сложное планирование; Sol Low/Medium — задачи с суждением; Luna Low — поиск/лёгкие задачи; native ZCode GLM-5.3-Flash — реализация и отдельное GLM review каждого прохода. Specialist review сохраняется.

Проверены base config Astra High, default subagent Luna Low, максимум3 дочерних задачи, bridge alive с GLM-5.3-Flash. Наблюдатель скиллов glm ACTIVE, hourly, единственный dispatcher в исходном routing thread; этот проект только добавляет evidence packets.

Контекст: профиль astra-complex уже содержал1000000/850000.20.09 эти requested limits добавлены в base config с backup. Текущий запущенный чат сообщает258400; свежий `codex debug models` подтверждает default272000/max872000/effective95%. Поэтому фактический1M в Desktop НЕ подтверждён; API-spec1.05M не доказывает доступность такого окна по этой подписке. Не менять catalog metadata ради искусственного подтверждения. Новая конфигурация требует повторного runtime readback после подхвата клиентом.

## Текущий пакет

### Продолжение после каталогового пакета

Запрос пользователя20.09: довести сервис, использовать Superpowers/Caveman и только необходимые reviews. Реализован связный пакет Tasks3–5 [RUB refund plan](../superpowers/plans/2026-09-06-topup-refund-clawback.md): атомарные confirmation snapshot/debt repayment, admin claim/dispatch/reconcile, подписанные refund notifications и объяснимые pending/debt состояния баланса. Итоговое focused financial/TypeScript review F1–F3 — APPROVE; React review исправленного UI — APPROVE. Возврат до первого подтверждения сохраняет durable marker и запрещает поздний grant, включая обе очередности гонки. Общие types/lint/build и native baseline ещё выполняются; это source-приёмка, не активация возвратов или production deploy.

Оставшийся объём до полного сервиса:

| Блок | Что ещё требуется | Граница готовности |
|---|---|---|
| Выполнение и учёт | Admission для stream/BYOK/completions/embeddings/media/batches; async ownership/deadlines; запуск recovery на стенде | Каждый включённый тип даёт результат и один подтверждённый расчёт, включая сбой/повтор |
| RUB | Source Tasks3–5 реализован и reviewed; завершаются общие проверки. Saved-key operator retry и trusted non-Tinkoff identity остаются отдельными возможностями | Пополнение→вызов→возврат/долг, без повторного grant/refund; активация после общего admission boundary |
| TON | Correction0076 source approved; завершаются общие проверки. Далее observe worker и integration/login/checkout по принятому плану | Local/native evidence отдельно от разрешённого mainnet rehearsal |
| Автор | Immutable executable version, безопасная модерация endpoint, начисление дохода, payout/reversal | Независимый автор продаёт вызов и видит объяснимое начисление |
| Продуктовые пути | Покупатель/автор/админ, все обязательные модальности, мобильный/desktop/error recovery | Сквозные сценарии; restricted501 не считается готовой возможностью |
| Выпуск и интеграции | AG→AM, version-bound Arena evidence, backup/restore, metrics/runbooks, release parity | Проверенный релизный артефакт и окружение; локальные тесты не равны production приёмке |

Процент и срок готовности не аттестованы. Много foundations уже принято, но оставшийся объём включает несколько функциональных подсистем, а не только тесты. Reviews объединяются вокруг законченного изменения после профильных проверок; принятые foundation-проверки не повторяются без причины.

Каталоговый WIP сохранён перед правками. Владение: только catalog-mounted.native.integration.test.ts; controller — актуальные docs. Локальный native test increment принят после проверок и независимых reviews ниже; общий release и AG→AM остаются открытыми.


## Проверка текущего пакета

- Native mounted catalog:7/7 PASS на настоящих локальных PostgreSQL/Redis, без skip; внешние provider/network effects перехвачены fixture. Проверены bounds16/17 и512/513, huge fan-out, delete/recreate identity, frozen/config-unavailable, runtime stale cursor409 и advisory GET→POST.
- В GET→POST сценарии независимые точные суммы4→18 microcredits; новый запрос фиксирует свежие quote/pricing snapshots, прежние admission/result/mapping/ledger сохраняются, replay не создаёт новый provider effect.
- Root config discovery:5/5 PASS. TypeScript reviewer APPROVE после исправления ledger selector и независимых денежных ожиданий.
- Финальные проверки на итоговом файле: native7/7 PASS, strict gateway test TypeScript exit0, scoped ESLint exit0, diff-check PASS. Root config discovery5/5 PASS.
- Независимые TypeScript и native GLM reviews — APPROVE. Полный GLM review d7cb2029e24846a5bd538260839db606; focused SQL-fix re-review eeff17f4eb504f9aace767ae1ed06e7b; последнее cleanup re-review0cb8e061d34244e38beceb21edbded8b. Все завершились с observed_models GLM-5.3-Flash. Попытка resume57c3e6ef8b14471ab778b0348e546510 упала до нового turn и не считается review.
- Закрыты findings: ledger selector по request_id, независимые денежные literals, точные quote/pricing/usage snapshots, typed prepared JSON parameters и сохранение обеих ошибок cleanup. Low-предложение сравнивать фиксированные catalog decimals строками отложено; текущие точные денежные суммы проверяются отдельными целыми literals.
- Это локальная приёмка нового native matrix. Полный database baseline ждёт TON0076; source/release composition и реальный AG→AM consumer не объявлены принятыми.
- Из14 сохранённых перед работой modified/untracked файлов изменён только каталоговый test; остальные13, включая TON0076 и финансовый WIP, совпали по SHA256. Root script и его config-test уже были WIP и сохранены без дополнительных изменений.
- Восстановлены исчезнувший `/tmp/ai-ecosystem-run` и существующий owned local PostgreSQL15432/Redis16379; без install/reset/migrations.

Маршрутизация проверена реальными запусками: Luna Low (узкая инвентаризация), native GLM (диагностика и implementation candidate), Sol Medium (финализация и независимое TS review). Первый GLM implementation достиг15min deadline после сохранения правок; этот результат завершён Sol, а не выдан за завершённый GLM job. Диагностический GLM job завершился с observed_models GLM-5.3-Flash; оба исторически падавших TON2 orchestration unit набора проходят наc440ebb. Это не приёмка TON0076 и не полный unit baseline.
