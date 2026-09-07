# Статус developer memory

Обновлено: 07.09.2026. Это read-only снимок доступности и правил применения memory-слоёв для трёх канонических репозиториев. Он не утверждает product readiness и не заменяет документы-владельцы.

## Подтверждённые чтения

| Слой | Фактический доступ | Полезный контекст для следующей задачи | Граница свежести |
|---|---|---|---|
| Graphify 0.9.55 | CLI и локальные `graphify-out/graph.json` доступны для всех трёх корней | Arena: `RevealOnScroll()` и его consumers; Aggregator: `billing/admission.ts`, wrapper и receipt tests; AM: `apps/worker/src/agent-runner.ts`, TMA `useAuth()` и план собственной БД | Это AST-снимки. Arena graph создан в 09:43 +03, но `aiarena-app/src/components/RevealOnScroll.tsx` изменён в рабочем дереве после HEAD; по нему граф не является текущим доказательством. |
| Serena 1.7.1.dev0 | CLI и project-local LSP cache доступны; callable MCP в этом сеансе нет | Aggregator хранит 24 legacy memories, Arena — 7; symbols лежат в `.serena/cache/` | Serena memories не являются автоматически актуальными: например, Arena `core.md` описывает прежний frontend-only prototype, а Aggregator historical note ссылается на старый layout. Использовать только как provenance, затем сверять с текущими entrypoint/plan/code. |
| LightRAG | Настроенный `daniel_lightrag_mcp` client найден и выполнен bounded `query_text(..., mode="hybrid")` | Контекст не возвращён | Фактический серверный readback завершился `403 Invalid API Key`. Конфигурация не равна доступу; upload/sync запрещён до исправления авторизации и отдельного readback принятого документа. |
| Memory Graph | `/home/bob/pinglass-data/memory.jsonl` прочитан локальным Python JSONL reader, не MCP | 9 валидных строк (5 entity, 4 relation); совпадений с AI Aggregator, AI Arena, Agents Market, `RevealOnScroll` или `gateway_charge_admissions` нет | Нет доказанного MCP read/write contract и namespace/dedupe policy для этих продуктов. Ничего не добавлять. |
| Brain | Читаемая навигация доступна | Этот README ведёт к каноническим repo docs и к данному статусу | Не дублирует private journals или непроверенный research. |

## Как извлечённый контекст ускоряет ближайшие задачи

- **Arena RevealOnScroll.** Graphify подтверждает, что компонент используется на challenge, home, organizer, admin, profile, leaderboard и team surfaces. Следующий исполнитель должен проверять lifecycle repair против текущего dirty diff и focused test; графовое состояние до этой правки годится только для карты consumers.
- **Aggregator admission.** Graphify ведёт к `packages/api-gateway/src/billing/admission.ts`, `admission-result.ts`, `billing-admission.test.ts` и принятому документу `docs/superpowers/plans/2026-09-07-gateway-charge-admission.md`. Рабочая карта сохраняет gate: wrapper ещё не активирован в route/executor; до следующего контракта обязательны durable reservation/quota, capability profile, usage receipt и reconciliation.
- **Agents Market DB.** Graphify связывает будущую AM-owned БД с `docs/superpowers/plans/2026-09-07-own-database.md`, `docs/ecosystem/database-boundary.md`, worker `runAgent()` и отдельным TMA `useAuth()`. Это подтверждает границу: Web и TMA самостоятельны, а исполняемая схема ещё не реализована.

## Операционный порядок

1. Открыть `AGENTS.md`, product entrypoint и релевантный plan у владельца.
2. Сверить HEAD, `git status` и timestamp индекса. Для dirty code читать diff/символы напрямую.
3. Использовать Graphify для структуры и Serena cache для code navigation; не превращать historical Serena memories в решение.
4. Сначала принять очищенный research/repo document. Затем выполнять только существующий идемпотентный LightRAG upload/sync и подтверждать его отдельным semantic readback.
5. Memory Graph обновлять лишь после документированного read/write contract, namespace и dedupe. Производный граф хранит связи и ссылки, не второй текст решения.

Отдельный полный прогон build/test не запускался: это memory-audit, код не менялся, а тяжёлые проверки должны оставаться под `flock /tmp/ai-ecosystem-build.lock` у исполнителя продуктовой задачи.
