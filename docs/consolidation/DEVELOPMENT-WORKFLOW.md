# Рабочая карта трёх продуктов

Обновлено: 07.09.2026. Эта карта ведёт разработчика к актуальным источникам и доказательствам. Она не заменяет продуктовые планы, scorecard или журналы проверок.

## Канонические корни и владельцы

| Продукт | Канонический корень | Владеет |
|---|---|---|
| AI Aggregator | `/home/bob/Projects/ai-aggregator` | каталог моделей, gateway, consumer/author billing, Aggregator worker |
| AI Arena | `/home/bob/Projects/aiarena` | конкурсы, команды, submissions/evaluation, blind comparison, призы |
| Agents Market | `/home/bob/Projects/agents-market` | отдельные Web и TMA, каталог агентов, agent runtime и AM-owned данные |

Архивные контейнеры используются только как provenance. Активный код одного продукта не возвращается в соседний репозиторий. Межпродуктовое изменение требует контракта у владельца и проверки у потребителя.

## Источники истины

- Топология и границы: [ACTIVE-PROJECTS.md](./ACTIVE-PROJECTS.md).
- Проверенные этапы и пределы доказательств: [EXTRACTION-VERIFICATION.md](./EXTRACTION-VERIFICATION.md).
- Общая программа и шкала: [ecosystem/README.md](../ecosystem/README.md).
- Сквозные контракты: [ecosystem/integration.md](../ecosystem/integration.md) и [integration-checks.csv](../ecosystem/integration-checks.csv).
- Рабочие входы: [AI Aggregator](../DEVELOPMENT-ENTRYPOINT.md), [AI Arena](/home/bob/Projects/aiarena/docs/DEVELOPMENT-ENTRYPOINT.md), [Agents Market](/home/bob/Projects/agents-market/docs/DEVELOPMENT-ENTRYPOINT.md).
- Детальный текущий журнал контроллера: `.superpowers/sdd/2026-09-06-three-repositories/progress.md`. Это приватный операционный ledger; его не копируют целиком в общую семантическую память.

## Текущий handoff

| Продукт | Проверенное | Следующий gate |
|---|---|---|
| Aggregator | Последний принятый кодовый этап — admission wrapper `1c25d0f`; `ed50ede` добавляет только документацию. Wrapper ещё не активирован в route/executor. | Сначала повторно проверить бизнес-процесс, user stories, UX и конкурентов; затем оформлять следующий узкий implementation contract. Durable quota/reservation, capability profile, usage receipt и reconciliation остаются обязательными до активации. |
| Arena | `d4174fb` прошёл focused unit/type/scenario, но не принят: React review блокирует stale `IntersectionObserver` callback; TypeScript review и подтверждённый полный integration exit отсутствуют. | Исправить lifecycle race с регрессией, завершить review и один доказуемый полный прогон. Новые продуктовые волны начинать после повторной бизнес/UX сверки. |
| Agents Market | `47ef96d` — документационный план собственной БД. Web сейчас публичная витрина list/detail; TMA — отдельное приложение. Исполняемая AM-owned схема ещё не реализована. | После бизнес/UX сверки выполнять Task 1 собственного DB-плана; затем реальные worker и TMA/Web проверки. Cross-catalog HTTP и private Web identity остаются отдельными задачами. |

Исследования про конкурентов, протокольный горизонт и Telegram/TON дают варианты и риски, а не разрешение на реализацию. Crypto-направление Aggregator остаётся в его репозитории и может получить отдельный домен без четвёртого code repository. Mainnet, платные вызовы, production migrations и удаление текущего fiat-кода этой картой не разрешены.

Текущая граница размещения: Aggregator приоритетно остаётся на существующем VPS; Agents Market уже развёрнут, и новый deploy для этой задачи не нужен. Vercel preview был отменён до запуска, новых preview/deploy не создавалось. Исторический адрес TMA `https://app.ai-aggregator.ru/tg` требует отдельной live-проверки и до неё не считается подтверждённым текущим endpoint.

## Память и индексирование

Один факт имеет один канонический источник. Производные индексы содержат ссылки и структуру, а не вторую копию продукта.

| Слой | Назначение | Правило записи |
|---|---|---|
| Repo docs | Продуктовые решения, планы, handoff и проверяемые evidence | Канонический источник разработки; менять в репозитории-владельце |
| LightRAG | Единственный общий семантический слой для принятого long-form research и устойчивых решений | Загружать только принятый, очищенный от секретов документ идемпотентным upload/sync; не использовать blind `insert_text` и не публиковать приватный журнал |
| Brain / Obsidian | Читаемые человеком навигация, guide и статус | Индексирует канонические repo-docs; не становится второй продуктовой базой |
| Serena | Code/LSP symbols и code-agent context | Индексировать канонический root штатным Serena; не создавать memory-файлы вручную и не писать WIP как продуктовый факт |
| Graphify | Производный локальный AST-граф структуры кода | `graphify update .` из канонического root; без LLM/API, архивов и generated/vendor деревьев |
| Memory Graph | Производные связи между устойчивыми сущностями и документами | Только после подтверждения target/schema, с namespace, дедупликацией и безопасной конкурентной записью; источник решения остаётся в repo docs/LightRAG |
| Codex auto-memory | Короткие предпочтения процесса и указатели | Только малые явно разрешённые notes; не копировать research, код или секреты |

Перед началом задачи прочитать repo `AGENTS.md`, локальный entrypoint и релевантный план. После изменения кода выполнить пропорциональные тесты под `flock /tmp/ai-ecosystem-build.lock`, обновить Graphify, затем обновлять Serena только поддержанным индексатором. Статус внешнего слоя считать успешным лишь после его собственного readback.

## Проверенный инвентарь 07.09.2026

| Слой | Доступность в текущем сеансе | Проверенный результат |
|---|---|---|
| Graphify | CLI `0.9.55` доступен; отдельного tool-call нет | Локальный AST readback: Aggregator 8847 nodes/13204 edges; Arena 1641/2164; Agents Market 1381/2062. SQL неполон: без `tree_sitter_sql` пропущены 72/9/33 файла соответственно. |
| Serena | CLI `1.7.1.dev0` и TypeScript/HTML LSP доступны; Serena MCP/tool-call отсутствует | Штатный `serena project index` сохранил project-local cache: Aggregator 651 TypeScript; Arena 140 TypeScript + 15 HTML; Agents Market 138 TypeScript. Существующие memory-файлы 24/7/0 сохранены. Пользовательский Serena config не менялся. |
| LightRAG | Server настроен в Hermes, но tool-call в этом сеансе отсутствует | Upload и semantic readback не выполнялись; слой остаётся pending, без blind endpoint-вызова или `insert_text`. |
| Memory Graph | Hermes config указывает на существующий `/home/bob/pinglass-data/memory.jsonl`; tool-call отсутствует | Формат entity JSONL прочитан только по ключам. Запись пропущена: текущий сеанс не даёт проверенного concurrency-safe write/readback contract, а дублировать продуктовые факты нельзя. |
| Brain | `/home/bob/brain` доступен | Создан человекочитаемый индекс `/home/bob/brain/Projects/AI-Hub/README.md`; ссылки проверяются на существование. |
| Codex auto-memory | Явно разрешён один ad-hoc note | Записан только workflow/model preference в `~/.codex/memories/extensions/ad_hoc/notes/`; основной `MEMORY.md` не изменялся. |

`configured` не означает `callable`, наличие файла не означает свежий индекс, а успешная локальная запись не означает sync во внешний слой.

## Выбор модели

- Простая рутина и оркестрация: лёгкая модель.
- Серьёзный research, архитектура и планирование: Astra с повышенным reasoning.
- Уже идущую задачу на другой модели не перезапускать только ради смены модели; новое правило применяется к следующим назначениям.

Ни один локальный baseline, индекс или частичный UI не означает `108/108`, production readiness или завершённый продуктовый сценарий.
