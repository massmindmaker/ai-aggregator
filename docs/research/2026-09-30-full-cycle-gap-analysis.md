# Research: разрывы полного цикла Arena → Aggregator → Agents Market

Дата среза: 30.09.2026. Метод: независимое чтение кода всех трёх репозиториев
(только чтение). Это карта пробелов для планирования, не приёмка и не новое решение.

## Короткий вывод

Ближе всего к готовности **Aggregator**: приём, модерация и продажа авторских моделей
существуют в коде и локально протестированы. Критически недостающая цепочка — **Arena**:
оценка не сохраняется, evidence/consent/экспорт отсутствуют. Связка «агент сам покупает
модель» в Agents Market — **дизайн без единой строки кода**.

## Состояние по этапам

| Этап | Статус | Где |
|---|---|---|
| Draft submission + immutable version (Arena) | ✅ | `submission_versions`, `src/lib/submission-versions.ts` |
| Accepted/final version (Arena) | ✅ | `submission_selection_revisions`, `final-submission-selection.ts` |
| Evaluation | ⚠️ только pure scorer | PE-T1 принят; PE-T2–T6 (БД, runner, UI, отчёты) не реализованы; таблицы evaluations нет |
| Arena export / consent / ArtifactManifest | ❌ | нет таблиц consent/export/publication; экспорт = приватное скачивание файла автором |
| Aggregator: приём авторских моделей | ⚠️ только web-форма | `POST /api/models/request-publish` требует сессию и ручной ввод; `POST /v1/publication-drafts` не существует |
| Aggregator: версии, модерация, каталог | ✅ | миграции `0087–0090`, `/admin/author-*`, immutable версии |
| Aggregator: продажа по API | ✅ локально | `/v1/models`, `/v1/chat/completions` с биллингом и начислением автору |
| AM покупает у Aggregator | ⚠️ частично | worker умеет путь `aiag` → gateway с `AIAG_GATEWAY_KEY` (fail-closed); но каталог AM собственный, синхронизации с AG нет |

## 14 блокеров цикла

**Arena → Aggregator (оценена → продаётся):**
1. Нет evaluation-persistence: scorer чистый, результаты нигде не хранятся — предъявить
   Aggregator нечего (PE-T2+ не реализованы).
2. `ArtifactManifest v1` не реализован нигде: Arena пишет свой `arena-private-json-v1`,
   Aggregator — свой `author-manifest.ts` (`openai_chat_https_v1`). Общего версионированного
   пакета схем нет.
3. `EvaluationEvidence v1` не реализован: нет подписанного экспорта, `GET /v1/evidence/{id}`,
   верификатора на стороне Aggregator.
4. Нет author consent: ни UI, ни API, ни таблиц согласия автора/прав команды, ни проверки
   `commercialization_allowed`.
5. Нет `POST /v1/publication-drafts` — единственный вход интерактивная web-форма; сервис-ту-сервис
   публикация из Arena невозможна.
6. Контракт invocation не сходится: артефакт Arena — приватный JSON ≤256KB с предсказаниями
   (не сервис), Aggregator принимает только живой HTTPS OpenAI-совместимый endpoint. Нет шага
   «обернуть оценённую модель в вызываемый API».
7. Arena на паузе с 13.09 — export draft producer не начат.
8. AG-P3 не закрыт как продукт: внешние вызовы/выплаты не запускались, streaming/tools для
   авторских версий не заявлены.

**Aggregator → Agents Market (продаётся → куплено агентом):**
9. Нет consumer-каталога: `GET /v1/catalog` не реализован; каталог AM всё ещё читает БД
   Aggregator прямым SQL (это главный незакрытый шаг AM-W1 и нарушение границы продуктов).
10. Авторскую модель нельзя назначить агенту иначе как вручную slug'ом.
11. Цепочка денег B2B не проверена: PAY-INT-02 (AM TON → run → AG inference, два ledger без
    общей БД) заявлен обязательным, evidence нет; `usage.settled`/receipt-контракт не принят.
12. Worker→AG хрупко: нет persisted idempotency key, нет AG billing UUID, нет
    reservation/receipt/reconciliation (`docs/research/2026-09-08-aggregator-receipt-bridge-inventory.md`,
    контракт AM-P2 — следующий проектируемый, не реализованный).
13. «Агент-покупатель» не существует: worker списывает кредиты с нанимателя сервисным ключом;
    агент не имеет кошелька и не принимает решений о покупке. Agent wallet — отдельная
    незакрытая задача дизайна. Managed Hermes provisioning существует только в легаси-доках,
    в кода его нет; реальный рантайм — BullMQ worker, Hermes — один из трёх апстрим-маршрутов.
14. Сквозные INT-01/INT-02 и EVD-INT-01 не проводились — формальный gate выпуска v1.

## Минимальный путь замыкания цикла

По правилам проекта **Arena заморожена до явного возврата владельца**. Поэтому порядок:

1. **Aggregator**: `POST /v1/publication-drafts` (идемпотентный, по immutable manifest,
   с правами автора) + общий пакет схем manifest/evidence как версионированный пакет
   (`packages/contracts` или аналог). Это снимает блокеры 2, 3 (серверная часть), 5.
2. **Aggregator**: `GET /v1/catalog` consumer-контракт → Agents Market AM-W1 переключается
   с прямого SQL на HTTP (блокеры 9, 10).
3. **AM**: AM-P2 receipt bridge (persisted idempotency key, AG billing UUID,
   reservation/receipt/reconciliation) — блокеры 11, 12.
4. Только потом Arena: PE-T2 (evaluation persistence) → evidence-экспорт → consent →
   публикация по drafts API (блокеры 1, 3, 4, 6, 7).
5. Agent wallet — отдельное решение владельца после стабилизации AM-P2 (блокер 13).

## Попутное подтверждение из deep-dive AM

- AM — зрелый control plane: ~52k строк TS, worker с CAS-claim, бюджетами, exactly-once
  settlement (`settleRun()` одним `sql.begin`), SSRF-защитой, тестами.
- Рантайм агента — самописный agent-loop в BullMQ worker (до 12 tool-итераций), НЕ Hermes.
  Hermes присутствует как апстрим `hermes_managed` с изоляцией `X-Hermes-Session-Key =
  agentId:hirerId`. Рекомендацияcapability-matrix: BullMQ остаётся v1 runtime, Hermes —
  будущий изолированный pilot-адаптер.
