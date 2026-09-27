# AI Hub: приоритеты и проверка маршрутизации 20 сентября 2026

Пользователь возобновил общую программу трёх сервисов с первым приоритетом AI Aggregator. Этот порядок заменяет формулировку «только Aggregator» от13.09, но не означает одновременный запуск работ во всех репозиториях. Архив aiag-web — только история.

## Каноническая последовательность

| Очередь | Источник | Следующий результат |
|---|---|---|
| 1. Aggregator — каталог | 19.09 resume plan, 13.09 public catalog contract, AG-P2 | Native matrix принят; остаётся настоящий AG→AM HTTP consumer |
| 2. Aggregator — расчёты | AG-P1 route coverage, stored embeddings/completions/stream/BYOK/media lifecycle | Chat, embeddings, non-stream completions, durable chat SSE, non-stream chat BYOK и durable async image/video/audio speech приняты локально; следующий пакет — batches admission/consumer lifecycle |
| 3. Aggregator — продукт | Production continuation AG-P3/P4/P5 | Авторская версия→доход, TON alongside RUB/login, modalities/UX и сквозная приёмка |
| 4. Arena | Собственный entrypoint и prediction evaluation plan | Executable scorer/hash и opt-in binding→DB jobs→sandboxed evaluator→результат |
| 5. Agents Market | Собственный native-account-principal/Web plan | HTTP/security review→guarded auth browser→UUID domain/worker→AG HTTP integration и independent Web/TMA acceptance |

TON0076 прошла итоговое source-review: прежние шесть HIGH закрыты, в том числе получение времени после ожидания row lock; ошибка TypeScript исправлена. Native evidence: 14 существующих сценариев и новая группа expiry/takeover PASS. Общий database baseline теперь подтверждён: 331 сценарий прошёл в полном запуске, три оставшихся — в точечных повторах после диагностики startup timeout и обновления двух устаревших schema/manifest ожиданий; итого334. TON core58 также PASS. Selector, pg adapter, bootstrap/index и replay settlement recovery уже реализованы и приняты — писать их повторно не требуется. Runtime recovery остаётся выключен; включение и проверка на стенде — отдельный operational шаг. Новых RPC не было.

План19.09 — порядок ближайших пакетов, а не замена полной product programme07.09. В частности, авторский lifecycle AG-P3, остальные оплачиваемые маршруты AG-P1 и UX/release AG-P5 не исчезли из объёма. Исторические числовые оценки не являются сегодняшними процентами готовности.

## Что остаётся в полной программе

- Aggregator AG-P1: stored chat stream, non-stream chat BYOK и durable async image/video/audio speech приняты локально; batches ещё требуют собственного admission/consumer/outcome/recovery. Restricted501 означает закрытую возможность, а не реализованный сценарий. Accepted quota/refund/media primitives заново не писать. AG-P2 — каталог и настоящий AM consumer; AG-P3 — авторские версии/доход; AG-P4 — TON с сохранением RUB; AG-P5 — modalities, truthful UX и release.
- Arena AR-P2 — полный конкурсный lifecycle, AR-P3 — доказательство качества (модели/агенты/RAG, reproducibility), AR-P4 — funding/payout, AR-P5 — export и выпуск. Pure scorer и выбранный JSON пока не означают выполненный evaluator.
- Market AM-P2 — деньги и recovery run, AM-P3 — HTTP/Web identity, AM-P4 — useful agent и автор, AM-P5 — TON Web и owned-run/status TMA, AM-P6 — release и цикл оценки. Уже принятый DB baseline AM-P1 не повторять без причины.

Источники: собственные production-continuation планы07.09 каждого репозитория; текущие owner checkpoints и AG-P1-route-coverage уточняют их старые checkbox-состояния. Общая cooperative-roadmap задаёт зависимость Aggregator→Arena→Market, но не заменяет индивидуальную приёмку.

## Исторический исходный срез перед каталоговым пакетом

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

Запрос пользователя20.09: довести сервис, использовать Superpowers/Caveman и только необходимые reviews. Реализован связный пакет Tasks3–5 [RUB refund plan](../superpowers/plans/2026-09-06-topup-refund-clawback.md): атомарные confirmation snapshot/debt repayment, admin claim/dispatch/reconcile, подписанные refund notifications и объяснимые pending/debt состояния баланса. Итоговое focused financial/TypeScript review F1–F3 — APPROVE; React review исправленного UI — APPROVE. Возврат до первого подтверждения сохраняет durable marker и запрещает поздний grant, включая обе очередности гонки. Общие types/lint/build и native baseline подтверждены ниже; это локальная приёмка, не активация возвратов или production deploy.

Оставшийся объём до полного сервиса:

| Блок | Что ещё требуется | Граница готовности |
|---|---|---|
| Выполнение и учёт | Admission для stream/BYOK/media/batches; async ownership/deadlines; запуск recovery на стенде | Каждый включённый тип даёт результат и один подтверждённый расчёт, включая сбой/повтор |
| RUB | Tasks3–5 реализованы, reviewed и проверены локально. Saved-key operator retry и trusted non-Tinkoff identity остаются отдельными возможностями | Пополнение→вызов→возврат/долг, без повторного grant/refund; активация после общего admission boundary |
| TON | Correction0076 принята локально после source-review и общих проверок. Далее observe worker и integration/login/checkout по принятому плану | Local/native evidence отдельно от разрешённого mainnet rehearsal |
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
- Это локальная приёмка нового native matrix. На момент каталогового пакета database baseline ждал TON0076; этот локальный gate закрыт следующим платёжным checkpoint ниже. Runtime/release и реальный AG→AM consumer не объявлены принятыми.
- Из14 сохранённых перед работой modified/untracked файлов изменён только каталоговый test; остальные13, включая TON0076 и финансовый WIP, совпали по SHA256. Root script и его config-test уже были WIP и сохранены без дополнительных изменений.
- Восстановлены исчезнувший `/tmp/ai-ecosystem-run` и существующий owned local PostgreSQL15432/Redis16379; без install/reset/migrations.

Маршрутизация проверена реальными запусками: Luna Low (узкая инвентаризация), native GLM (диагностика и implementation candidate), Sol Medium (финализация и независимое TS review). Первый GLM implementation достиг15min deadline после сохранения правок; этот результат завершён Sol, а не выдан за завершённый GLM job. Диагностический GLM job завершился с observed_models GLM-5.3-Flash; оба исторически падавших TON2 orchestration unit набора проходят наc440ebb. Это не приёмка TON0076 и не полный unit baseline.

## Итоговый платёжный checkpoint20.09

- `892a09d`: TON persistence correction, additive0076; `0074/0075` сохранены. Native14+expiry1, database types, scoped lint и independent focused review PASS/APPROVE.
- `058ee97`: RUB Tasks3–5 — immutable grant/debt repayment, admin trusted-identity refund claims, signed webhook reconciliation, durable marker для refund-before-confirmation и truthful balance UI. Combined financial/TS fixes F1–F3 и React review закрыты. Focused24, native confirmation/refund19 в общем прогоне, balance12, payment compatibility26 подтверждены соответствующими пакетами.
- Root build/types/lint: production Next build219pages, package builds, types и доступные lint scripts прошли. Общий процесс получил SIGTERM на последнем повторном worker build; завершён отдельно только worker build, exit0. Полный build заново не запускался.
- Native root matrix334 подтверждена совокупно:331 PASS исходного запуска; startup child1 PASS отдельно за3.3s без изменения исходника; stale schema/manifest2 PASS после обновления110→113tables (catalog revision + TON observations/cursors) и72→76migrations. Checksums исторических migrations, mirrors и проекции не ослаблялись.
- Отдельный обязательный TON core:58 PASS, fresh72/no-op72, rollback и cleanup targetSessions0 подтверждены helper; этот historical core gate не заменяет отдельные reconciliation15.
- Evidence: `.superpowers/sdd/2026-09-06-topup-refund-clawback/final-{root-validation,worker-build,database-baseline,legacy-startup-focused,baseline-manifest-focused}.log` и TON workspace `final-{scoped-lint,ton-core-native}.log`. Нет production migrations/deploy, новых RPC или платных provider calls.
- Платёжный checkpoint завершён до embeddings; последующая локальная приёмка отражена ниже. Старый `stored_chat_only` и disabled recovery не активировались.


## Stored embeddings: принятый локальный checkpoint20.09

- Source `a587e88`, интеграция в `feat/three-projects-completion` — `4a5acdb`. Реализован [контракт](../superpowers/plans/2026-09-20-stored-embeddings-lifecycle.md): strict request/identity → frozen DB quote → durable claim/reserve → pinned single provider POST → validated usage/result → settlement/replay. Migration0077 additive; исторические migrations сохранены.
- Новый явный HTTP mode `stored_chat_embeddings` поддерживает chat и одну reviewed embeddings candidate `openai/text-embedding-3-small`: 1–16 inputs,1536 floats. Старый `stored_chat_only` оставляет embeddings501, defaultlegacy сохранён. Worker recovery combined mode — `stored_chat_embeddings_v1`; defaultdisabled сохранён.
- Native mounted proof с настоящими handler/adapter/PostgreSQL/Redis и mock только upstream transport: reserve41/ supplier328 → retail3/ supplier20, balance997, released38/308, costheader30; один provider call/ledger debit при replay. Реальный worker завершает durable outcome после settlement failure, revoked key и expired tombstone ровно один раз. Malformed usage остаётся dispatched/held, worker его не выбирает; автоматических refund/redispatch нет.
- Проверки: shared и gateway source/strict test types, gateway/worker builds, scoped lint PASS. Owner focused suites227/37/118 PASS; mounted6 PASS. Итоговый root native matrix341 подтверждён совокупно:340 в полном прогоне, SQL mirror overload test исправлен и весь затронутый файл15 PASS. Upgrade0077 applied1/skipped76 и no-op77 подтверждены; это не clean install77. TON core58 PASS отдельно: historical fresh72/no-op72, rollback и cleanup sessions0.
- Один independent financial/SQL/security/TypeScript review — APPROVE. Единственный MEDIUM закрыт: embeddings1MiB cap проведён до proxy socket buffer; direct reader остаётся bounded. Proxy cap консервативно включает chunk framing, отдельно допускается bounded header overhead64KiB. Real local TCP CONNECT tests проверяют весь fetchUpstream→safeFetch→gateway executor→socket путь; proxy/egress/adapter63 PASS. После fixes повторены только affected types/build/lint и focused tests.
- Две исправленные проверки инфраструктуры: SQL mirror сравнивает полные сигнатуры (оба response-validator overload), TON disposable72/110 inventory больше не читает развивающийся head77/113 snapshot. Денежные assertions/checksums не ослаблены.
- Evidence сохранён в `/home/bob/Projects/.worktrees/ai-aggregator-stored-embeddings/.superpowers/sdd/2026-09-20-stored-embeddings/`: owner reports, final-review.md, final-database-baseline.log, final-review-fixes.log, final-review-fix-types.log. После merge source совпадает с reviewed commit, кроме сохранённого поясняющего комментария; пять чужих WIP файлов проверены по SHA256 и сохранены.
- Граница: local acceptance, runtime disabled; real provider execution unproven. Публичная schema теперь содержит strict embeddings operation; внешним strict consumers нужен совместимый parser. Настоящий AG→AM consumer и provider-parameter activation остаются release gates. Production deploy/migrations, RPC и платные provider calls не выполнялись.

## Stored completions: принятый локальный checkpoint24.09

- Source `3a717bf`, интеграция в `feat/three-projects-completion` — `5297623`. Ограниченный compatibility route `POST /v1/completions` использует один принятый `admittedChat`, но имеет отдельные identity, durable DTO, replay и recovery. Поддержан только scalar prompt; batch prompts, stream, BYOK и неподдержанные legacy-параметры отклоняются до admission/provider.
- Новый явный mode `stored_chat_embeddings_completions` сохраняет chat и embeddings и добавляет completions. Старые stored modes оставляют completions501; defaultlegacy и recovery defaultdisabled не изменены. Migration0078 additive, migrations до0077 не редактировались.
- Native mounted proof через настоящий handler/adapter/PostgreSQL/Redis и mock только внешнего transport: reserve3457/supplier19205 → actual3/18, balance9997, release3454/19187, header30. Concurrent same-key fresh requests дают один provider effect и один ledger; отдельный Bun/server instance читает persisted replay без сети. Worker после forced settlement failure, revoked key и expired tombstone рассчитывает один раз; malformed usage остаётся dispatched/held и worker его пропускает.
- Проверки: owner pure128+113, storage66, mounted8 acceptance cases, migration77→78/no-op78, schema15, migrator13, types/lint/build/config PASS. Итоговый native matrix принят совокупно:348 сценариев исходного запуска, исправленный flaky case и новый concurrent/restart case — всего350; полный matrix после test-only fix не повторялся. TON core58 PASS отдельно, fresh72/no-op72, rollback/cleanup0. Один independent financial/SQL/security/TypeScript review — APPROVE, findings закрыты адресно.
- Граница: local source/native acceptance, runtime disabled; provider transport mocked, real provider execution и production activation не подтверждены. Catalog primary operation для chat-моделей не изменена: completions — compatibility endpoint, а не новая provider capability.

## Stored chat streaming: локальный checkpoint25.09

`23ce262` добавляет explicit `stored_chat_embeddings_completions_stream`, contractVersion2 durable SSE, migration0079 и matching recovery mode без runtime activation. Финальная проверка после review-fix: focused402 PASS; mounted stream + HTTP storage native73 PASS; gateway/worker strict types PASS; gateway build/lint PASS. GLM-5.3-Flash final review не нашёл Critical; три Important test gaps закрыты и scoped re-review подтвердил все три как ADDRESSED. Один из новых regression tests выявил и закрыл позднюю валидацию stream `max_tokens>2048` на HTTP identity boundary.

Полный database command дважды проявил разные неповторяемые historical flakes под высокой нагрузкой: 356/356 native с TON child57/58, затем355/356 native на entitlement case; targeted TON58/58 и entitlement1/1 прошли без code changes. Поэтому свежий root command не помечается exit0, а streaming acceptance опирается на impacted native/storage gates и независимый review. Production/runtime/provider activation не выполнялись.

## Stored chat BYOK: локальный checkpoint25.09

`fb8caad`/`540521e` добавили contractVersion3 fixed-fee BYOK identity/admission/attempt; `204c4cd` + `f1f3509` — additive migration0080, HTTP storage/recovery и migration evidence; `129008d` смонтировал newest-mode route и native acceptance. `edd365d` — единственный final-review fix: stream+BYOK снова строго501, а старые stored modes fail-before-state.

Fresh scoped evidence: post-fix unit387 PASS; combined native storage68 + mounted BYOK4 PASS до review-fix и impacted native legacy1/stream1/BYOK4 после него; migration0080 applied1/skipped79 и no-op0/80; strict types/build/lint/diff checks в пакете exit0. Post-fix amended root database baseline также завершился полностью: 17/17 files, 362/362 native PASS + обязательный TON core58/58, `FULL_BASELINE_RC=0`. Exact fixture — fee1000 microcredits, supplier0, balance5000→4000, provider1/ledger1; unknown provider outcome остаётся held, coherent durable outcome worker settles once. GLM final review `006e9e52283648efbde7b20ced5d8c52` → one Important, `edd365d`; scoped re-review `3616a07f63104acc955dd979c79ada76` → APPROVE.

## Durable async media: локальный checkpoint27.09

`2a490e1` → `0a2d6bf`, включая supplier-rounding `c38f7eb`, закрывают локальный media package: image/video/audio speech в explicit `stored_chat_embeddings_completions_stream_media` используют strict identity, exact decimal reserve, admission-linked `prediction_jobs`, opaque task id, DB-only GET, owned Kie polling/recovery и один terminal settlement path. Final review-fix wave отдельно закрыла stranded claimed replay, lost settlement ACK, Kie provider/egress boundary, worker `KIE_BASE_URL`, raw terminal output sanitization и malformed JSON до admission.

Fresh gates на итоговом diff: focused102 PASS; gateway src/test + worker + adapter types exit0; gateway+worker builds PASS; поддерживаемый gateway lint и `git diff --check` PASS; guarded root DB baseline 21/21 files, 374/374 PASS + mandatory isolated TON core58/58, cleanup dropped/sessions0/canonical unchanged. External GLM final review не вернул usable report; Superpowers self-review был fallback и не считается independent approval. Runtime/production не переключались, paid provider не вызывался.

Следующий архитектурный пакет Aggregator — durable batches admission/consumer lifecycle. После batches возвращаемся к авторскому lifecycle, AG→AM и продуктовым/операционным gates полной программы. Этот checkpoint не объявляет весь сервис завершённым.
