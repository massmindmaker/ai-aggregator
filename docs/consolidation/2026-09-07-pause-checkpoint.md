# Чекпойнт AI Hub — 7 сентября 2026

Последнее дополнение перед паузой: пользователь запросил отдельный research подключений Hermes/Codex и общий список дальнейших исследований. Подготовлены [срез расширений AM](/home/bob/Projects/agents-market/docs/research/2026-09-07-providers-and-extensions.md) и [программа18исследований](../research/2026-09-07-research-program.md) с приоритетами, зависимостями, выходами и связью с задачами всех трёх продуктов. Подключение Context7 подтверждено resolve/query; полный функционал Hermes, продуктовые интервью и вся программа ещё не исследованы. Следующее продолжение учитывает эту программу; кодовые результаты ниже сохранены.

Пользователь запросил временную остановку, структурированный отчёт и функциональную108-оценку. Новые большие реализации, UI-мокапы и deployment не запускать при закрытии этой сессии. Продолжение начинается с этого документа и проектных entrypoints, затем сверки текущего git/source состояния.

## Принятые границы

| Проект | Проверенный результат | Где продолжить |
|---|---|---|
| AI Aggregator | Task5 source `b6266cb7`: одноразовый stored-chat executor, immutable quote/admission/outcome;156focused + types/lint и independent APPROVE. Модуль ещё не включён в public route | [Entry](../DEVELOPMENT-ENTRYPOINT.md), [durable quotas](../superpowers/plans/2026-09-07-durable-spending-quotas.md): Task6 design готов, реализации нет |
| AI Arena | AR-P1 и AR-P2.0 приняты. Domain `59e27acc`, harness `8a825925`, acceptance docs `d00e2e6`. Focused20 + полный native11 exit0; независимые reviews APPROVE | [Приёмка AR-P2.0](/home/bob/Projects/aiarena/docs/product/acceptance/AR-P2.0.md): contest policy/deadlines → submissions → evaluator |
| Agents Market | DB Task1 `cfc97f91` принят:56unit/10native. Task2 source `38b05189` проверил реальные worker/catalogue на AM DB, TMA/Web builds и6HTTP/browser состояний. React APPROVE; общая Task2 приёмка **не закрыта** | [Entry](/home/bob/Projects/agents-market/docs/DEVELOPMENT-ENTRYPOINT.md): замечание cleanup ниже, затем monetary CAS/Web identity/useful run |

Arena full11 использовал guarded `runIsolatedE2E` с проверенным reuse неизменного build, не новый build; точные условия и исходные RED в acceptance. Число tests не переводится в функциональные баллы.

## Незакрытое замечание AM Task2

Follow-up `510c10430ef98bdcac289a8144483def3f481888`, только `scripts/catalog-stack.sh`. Независимо PASS: clean, missing-clean; root native populated→stop exit0, `ready→clean`, порты освобождены. **NOT APPROVE / Important**: fake hung fixture превышает30/45s и не доходит до owned KILL recovery в ожидаемое время. Причина —50 polls полного ps не являются реальным deadline; после первого timeout повторяется второй TERM grace period.

Следующий узкий шаг: общий wall-clock deadline, немедленный KILL recovery после исчерпания TERM без второго grace period; controlled hang должен завершиться ненулево внутри объявленного лимита, удалить только свои группы и сохранить unrelated sentinel. Потом независимый re-review. Это дефект локального test harness, отдельно от известного продуктового `failed→completed` settlement bug.

Полные отчёты review и raw evidence — private `.superpowers/sdd/2026-09-06-three-repositories/` controller, включая `am-stack-cleanup-rereview.md`. Не переносить private journals/секреты в общий semantic index.

## UI/UX Agents Market

Пользователь отверг текущую Web-витрину и попросил полноценную Web-версию TMA, общую дизайн-основу и сначала исследование **без мокапов**. [Research checkpoint](/home/bob/Projects/agents-market/docs/specs/2026-09-07-web-ux-research-checkpoint.md) содержит source map, роли, сценарии, начальные источники и незавершённую IA. Никакой redesign реализации ещё нет. Этот приоритет сохраняется вместе с последующим запросом общей исследовательской программы.

## Функциональный отчёт

[Текущая оценка функционала](../ecosystem/2026-09-07-functional-checkpoint.md) отделяет инженерный F-срез0…108 от исходной формальной I/T/O приёмки. Исторические65.5/48/72 не пересчитываются автоматически. Формальные CSV не повышаются за наличие планов/индексов или количество тестов.

## Репозитории и публикация

Три канонических root сохранены: `ai-aggregator`, `aiarena`, `agents-market`; Agents Market содержит отдельные Web/TMA/worker. GitHub push и новые deployment не выполнены. В канонических repo нет подтверждённых GitHub origin/upstream; AG/AM legacy-source ведёт в локальный архив, Arena remote отсутствует. Archived source указывает на старый `massmindmaker/aiag-marketplace`; текущий connector видит login `MAKENFTGRATE`, bounded repository listing пуст, gh не авторизован. Это не доказательство отсутствия удалённых репозиториев. Не придумывать три destination URL и не пушить разделённые проекты в старый монорепозиторий.

VPS read-only аудит и действующие release пути: [resume audit](2026-09-07-resume-audit.md). Aggregator приоритетно остаётся на VPS; TMA/API/worker AM тоже сохраняются. Отдельный AM Web возможен на Vercel после совместимого API/auth. Старые открытые production URLs не показывают свежие локальные commits.

## Память и возобновление

Актуальная доступность/свежесть — [MEMORY-STATUS.md](MEMORY-STATUS.md). LightRAG работает через X-API-Key, общий topology contract имеет processed/readback; Memory Graph содержит reference entities; Brain хранит навигацию, Serena/Graphify — производные code indexes. Текущий harness не получил новые MCP calls: поддержанные CLI/SDK реально использованы. Не писать Bearer вместо X-API-Key и не оставлять буквальную env-placeholder строку.

Перед продолжением: читать [ACTIVE-PROJECTS](ACTIVE-PROJECTS.md), entrypoint владельца, этот checkpoint и narrow plan; сверить HEAD/diff и живые процессы. Один тяжёлый build/test/index под `/tmp/ai-ecosystem-build.lock`; не менять seven historical untracked Arena docs, чужие edits, production env или PM2 менеджеры. User authorizes autonomous local work and subagents; serious architecture/research — Astra high, routine — model-router. Платёжная цель сохраняет RUB + TON в AG, TON Web в AM и TON funding/prizes в Arena; Stars не реализуются.

## Локальный просмотр во время паузы

Текущая Web-витрина оставлена на [127.0.0.1:3200](http://127.0.0.1:3200/) с явно синтетическими данными, только loopback. Это прежний UI, не новый дизайн и не production. Процессы/fixture ownership и команда штатной остановки сохранены в private `am-preview-checkpoint.json`; перед AM catalogue tests нужно остановить этот preview и проверить cleanup, иначе его fixtures влияют на empty-state проверки. При закрытии сессии/перезапуске хоста адрес может стать недоступен; стартовать только через guarded catalog:stack после сверки текущих процессов.
