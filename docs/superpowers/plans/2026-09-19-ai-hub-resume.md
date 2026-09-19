# AI Hub: возобновление разработки 19 сентября 2026

> For agentic workers: use Superpowers executing-plans; batch changes, one end-of-batch review. Respect AGENTS.md.

**Goal:** завершать существующие три продукта измеримыми функциональными пакетами, не переписывая архитектуру и не повторяя уже принятую работу.
**Architecture:** AI Aggregator — модели, gateway, деньги и собственный worker; AI Arena — конкурсы и evaluator; Agents Market — Web/TMA, агенты и собственный worker. Межпродуктовые связи только HTTP/DTO, без чужой БД.
**Tech Stack:** существующие TypeScript/Hono/Next.js/PostgreSQL/Redis, Bun 1.4.2; без новых зависимостей для первого пакета.
**Spec:** docs/superpowers/plans/2026-09-13-public-catalog-contract.md; docs/consolidation/2026-09-13-aggregator-only-handoff.md.

## Точка остановки
- Aggregator: feat/three-projects-completion, HEAD 34ff916. Приняты локальные billing/quota/idempotency foundations, restricted stored chat, recovery bootstrap, catalog Tasks1–3. Catalog Task4 candidate 0d8d2e7 ждёт проверки. TON correction 0076 — незакоммиченный WIP, не принят.
- Agents Market: feat/standalone-agents-market, HEAD 94b5b45. Public Web/TMA и account trust core есть; HTTP/BFF и browser auth acceptance не завершены. Сохранены незавершённые browser fixture files.
- Arena: feat/arena-foundation-reviewed, HEAD c2f6559. Versioned/final submissions и pure prediction scorer приняты локально; binding/DB lifecycle/executable evaluator ещё нет.
- Исторические PASS не заменяют свежие проверки и не означают production release.

## Выбор подхода
1. Выбран: сначала закрыть ближайшие уже спроектированные срезы Aggregator, затем Arena и Market; код, тесты и handoff в каждом пакете.
2. Не выбран: одновременно переделывать все три продукта — больше конфликтов интерфейсов и нагрузки на 6 ГБ RAM.
3. Не выбран: заново исследовать архитектуру или вводить новую систему оркестрации — не закрывает пользовательские сценарии.

## Global Constraints
- Никаких production deploy/migrations, mainnet, signer/funds или платных model/provider calls продукта.
- Разрешён делегированный coding worker через существующий Z-code Coding Plan; фактическая модель проверяется по runtime evidence.
- Не трогать прежний TON/WIP, auth-browser WIP, .Codex, stderr, memory/index files.
- Один владелец каждого изменяемого файла. Все heavy test/build — под flock /tmp/ai-ecosystem-build.lock, без параллельных сборок.
- Default legacy mode неизменен; каталог не активирует новые execution capabilities.
- Не включать чужие файлы в commit; не push/merge/deploy.

## Review Focus
- Принимаются только strict schema и advertised capabilities; никаких догадок о доступности модели.
- Некорректные auth/query/cursor, stale revision, storage errors закрываются безопасно без утечек.
- Consumer не имеет DB/projector/provider imports, не фиксирует бюджет ценой из каталога.
- Network/provider вызовы в тестах запрещены; local HTTP или in-process Fetch, controlled storage.
- Отдельно отмечать unit, HTTP, native DB, browser и production evidence; не смешивать статусы.

## Пакет 1 — каталог (выполняется в этой сессии)
### 1A. HTTP-контракт и реальный consumer
Owner: Z-code GLM-5.3-Flash; controller reviews combined delta.
Files: packages/api-gateway/src/__tests__/fixtures/catalog-consumer.ts; packages/api-gateway/src/__tests__/catalog-producer-consumer.http.test.ts. При подтверждённом дефекте route/http-contract разрешён минимальный regression fix после RED.
- [x] Проверить существующий Task4 candidate по плану и составить краткие findings, без повторного research.
- [x] Сначала regression/consumer tests, затем минимальная реализация fixture; real Hono route и auth chain, parser из @aiag/shared/catalog-contract.
- [x] Проверить available/unavailable, strict schema, malformed JSON, fixed HTTP errors, pagination, no internal imports/leaks и advisory-only prices.
- [x] Локальные mock-controlled HTTP tests без provider traffic; все heavy commands только под общим lock.
- [x] Один совместный review; focused tests, source/test types, lint, diff check.
### 1B. Guarded native continuation (следующий незакрытый срез)
Files: packages/api-gateway/src/__tests__/catalog-mounted.native.integration.test.ts; root package.json; docs/product/acceptance/AG-P2.md.
- [ ] Disposable DB identity+marker guard; stable pages, 16/17 and 512/513 fan-out, stale cursor after DB/key/runtime change.
- [ ] Price mutation GET→POST; fresh immutable quote, unchanged earlier receipts/ledger snapshots.
- [ ] Добавить подтверждённый native gate в baseline только после выполнения; реальный AG→AM остаётся UNVERIFIED.

## Пакет 2 — надёжность выполнения и списаний
- Завершить recovery runtime composition из принятого плана без production activation.
- Доказать retry/restart/timeout/idempotency, конкурентный claim, отсутствие повторного вызова provider и двойного списания.
- Проверить восстановление worker после падения и корректный refund; один financial/security review пакета.
- Критерий: один request → один immutable outcome, совпадающие ledger/quota/receipt.

## Пакет 3 — TON без потери текущего WIP
- Проверить сохранённую correction 0076 на CAS и immutable terminal state; 0074/0075 не редактировать.
- Native fixture + mocked transport, без новых testnet RPC (исторический budget 20/20).
- Затем jetton verifier, disabled/observe worker, checkout/login и settlement gates по принятому плану.
- Mainnet, funds и deploy — отдельно разрешаемый release, не следствие local PASS.

## Пакет 4 — AI Arena
- Завершить deterministic scorer bundle/hash и opt-in binding с concrete FK/transaction order.
- DB jobs → sandboxed evaluator → time/resource limits → reproducible score/receipt → UI статусов/результатов.
- Критерий: участник выбрал версию → задача исполнена изолированно → воспроизводимый результат, без перезаписи v1/v2 history.

## Пакет 5 — Agents Market
- HTTP/BFF security review и завершение сохранённого guarded browser auth launcher.
- Auth browser acceptance → domain/worker UUID cutover → workspace/run/history/author surfaces.
- AG HTTP catalog и receipt/reservation/recovery; Web и TMA проходят отдельные проверки.
- Критерий: вход → выбор агента → запуск → результат → корректное единственное списание/возврат.

## Пакет 6 — интеграционный выпуск
- E2E ключевых потоков трёх сервисов, отказные сценарии, build, health/logs, backup/rollback rehearsal.
- Existing hosting first; никаких новых проектов/деплоев без необходимости и разрешения.
- Финальная матрица: ready locally / native verified / browser verified / deployed; release blockers перечислены явно.

## Рабочий цикл
Короткий brief → implementation и regression tests → один review готового пакета → исправление Critical/Important → итоговый test/build → evidence и следующий пакет. Minor polish в backlog, если он не ломает сценарий. После двух неуспешных попыток worker контроллер берёт узкую задачу, а не повторяет бесконечный запрос. Не обещать фоновое выполнение после ответа.

## Проверка выполнения 19 сентября

Пакет1A реализован как **AG-owned local consumer**, не реальный клиент Agents Market. Контрактный gate: 134 PASS; native smoke: 4 PASS. Gateway source/test TypeScript, lint и build PASS. Native smoke дополнен тремя проверками seek/DB-revision/key-policy; полный Пакет1B, fan-out 16/17 и512/513, GET→POST money snapshots и cross-product acceptance остаются открытыми.

Первый Z-code implementation job достиг лимита до финализации. Черновики сохранены; контроллер исправил harness и восемь воспроизведённых regression failures. Отдельный read-only review на той же GLM-5.3-Flash завершён без блокирующих находок. Следующие implementation brief: один выходной артефакт, точный контракт, только необходимые ссылки, один пакет правок вместо последовательных микро-Edit. Не увеличивать concurrency тяжёлых jobs.

Общий root unit baseline был ограничен 180s и не завершился: до остановки перечислены137 suites/2460 tests (включая skipped), наблюдались44 failure в native-ton-core-test.test.ts,27 в native-clean-rehearsal.test.ts и1 в старом scratch-repro. Scratch discovery defect исправлен RED→GREEN; два других набора не изменялись и не объявлены исправленными.

Подробный checkpoint: docs/consolidation/2026-09-19-catalog-continuation.md.
