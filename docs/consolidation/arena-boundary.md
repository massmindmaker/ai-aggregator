# AI Arena: граница консолидации и первый пакет

## Канонический корень и Git

- Канонический репозиторий уже расположен в `/home/bob/Projects/aiarena`: это Git worktree ветки `wave2`, HEAD `d087933` (`chore(memory): purge .chrome-test junk...`). В корне нет remote и submodule.
- Второй worktree — `/home/bob/.hermes/worktrees/aiarena-wave5-release`, ветка `wave5-release`, HEAD `61b05fb`. Он основан на `master` (master — предок wave5), но `wave2` не является его предком: переносить «поверх» нельзя без отдельного сохранения dirty-state и интеграции.
- App, миграции и runtime находятся в `aiarena-app/`; документы, дизайн и прототипы живут в корне. Рабочая команда приложения: `npm --prefix aiarena-app ...`.

## Состояние без generated-шума

`git status --porcelain -- . ':(exclude).chrome-test/**' ':(exclude).tools/node_modules/**' ':(exclude)aiarena-app/.next/**'` даёт **101 tracked change и 2 untracked документа**:

- 40 — `aiarena-app` (API, schema, migrations, E2E, UI);
- 14 `wireframes`, 10 `design`, 4 `hifi`, 3 `research`, 3 `docs`, 6 `.serena`, 7 полезных `.tools`; также корневые test/design scripts и `full*.txt`.
- Untracked: `aiarena-app/docs/audit/business-logic-audit-2026-08-31.md`, `docs/audit/full-product-review-2026-08-31.md`.

Generated, но **отслеживаемые**, данные нельзя просто забыть:

- `.chrome-test/**`: 872 indexed файла, 114 текущих modifications/deletions;
- `.tools/node_modules/**`: 2 404 indexed файла, сейчас удалены из worktree;
- `aiarena-app/node_modules/**` и `.next/**` игнорируются; `.next` не tracked.

## Безопасная экстракция

Не переносить и не чистить текущий worktree. Сначала сделать неизменяемый backup refs (`git bundle create ... --all`) и два binary-патча: (1) product/документы/real dirty-state с исключениями `.chrome-test` и `.tools/node_modules`, плюс архив двух untracked файлов; (2) отдельный forensic-патч generated `.chrome-test` и `.tools/node_modules`.

Затем создать новый clean canonical clone/worktree из сохранённого bundle на базе выбранного integration tip `wave5-release`, применить только product-патч и восстановить untracked docs. Так сохраняются вся история и каждое незакоммиченное изменение, но Chrome и tracked node_modules остаются воспроизводимым архивом вне активной ветки. После проверки патча отдельным коммитом удалить их из индекса и добавить игноры `.chrome-test/`, `.tools/node_modules/`; это не часть переноса и не должно смешиваться с продуктовой работой.

## Реальная продуктовая дыра

Текущий README всё ещё называет persistence/evaluator «not connected». Schema заканчивается `auditLog`; нет `submission`, `attempt`, `job`, `result`, `final_selection` таблиц или submission/evaluation routes. `/leaderboard` честно показывает активность, а не scores. Аудит подтверждает: INV-01, INV-02, INV-07, INV-08 и BS-06/07 missing.

Существующий стиль для нового контура: Drizzle schema + generated journal migration; Zod в `src/lib`; domain service владеет transaction; route делает `auth()` + `ensureNotDisabled`, возвращает `jsonError`; audit пишется в той же transaction через `writeAuditEvent`. Для role mutation есть `requireRoleJson`. Текущий тестовый слой — Playwright scripts в `.tools`, ad-hoc E2E в `scripts/`; в package пока только `typecheck`, `build`, `db:generate`, `db:migrate`. Wave 5 добавляет isolated E2E/test guard, но Wave 7 prerequisite ещё не выполнен (в текущем journal tip `0007`, а план требует Wave 6 до `0011`).

## Первый ограниченный implementation package

До настоящего worker не начинать UI/leaderboard. Первый package после консолидации и завершения Wave 5/6 prerequisite — Wave 7 Tasks 1–4 как **«submission acceptance foundation»**; он впервые замыкает полезный серверный путь: active enrolled scope → immutable draft/manifest → successful free health → atomic submit/debit/job → readable job state. Это не подменяет evaluator и не публикует score.

1. **Schema/migrations (Tasks 1):** challenge deadlines/limits; evaluator version; submission scopes/drafts/credentials/artifacts/submissions; health/evaluation jobs; append-only quota ledger; final selections. DB: exactly-one scope owner, one active evaluator, `debit/refund` uniqueness and deferred balance checks, immutable accepted manifests, final slots 1–2.
2. **Draft API (Task 2):** five Zod formats, canonical SHA-256 manifest, server-issued artifact keys, AES-GCM credential service; routes `/api/workspace/[slug]/drafts`, `/api/submission-drafts/[id]`, `/credential`, `/artifacts`, `/artifacts/complete`. API URLs require public HTTPS/no credentials/no fragments/non-443; client cannot choose scope, evaluator, checksum, object key or resources.
3. **Health API (Task 3):** organizer evaluator-version route; `POST /api/submission-drafts/[id]/health-checks`, `GET /api/health-checks/[id]`; health is queued/free and never writes quota ledger. Secure fetch must resolve and reject private/mixed DNS, redirects, oversized/slow responses.
4. **Acceptance API (Task 4):** `POST /api/submission-drafts/[id]/submit` with UUID Idempotency-Key and `GET /api/evaluation-jobs/[id]`. One DB transaction locks `(scope, Moscow day)`, validates fresh matching health/deadline/membership, inserts immutable submission/job and exactly one `debit`, then audit; sixth daily submit returns 429 with no partial rows.

Required focused evidence: generated migration forward/idempotence scenario; unit tests for canonical hashes, endpoint/OCI validation, AES-GCM no plaintext, Moscow midnight/deadline equality, queue lease CAS; isolated integration for unauthorized/foreign/stale drafts, 5 accepts + parallel final attempt, replay/conflicting idempotency key, no quota effect from health, invalid endpoint makes no rows, and API/audit/log responses leak no credentials. Do not claim evaluator result, platform refund, or final selection as complete until Tasks 5 and 8 run with the external worker.
