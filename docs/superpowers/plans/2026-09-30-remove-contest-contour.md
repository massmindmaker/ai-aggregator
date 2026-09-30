# План выпиливания конкурсного контура из AI Aggregator

Дата: 30.09.2026. Решение владельца: конкурсная площадка живёт в Arena, Aggregator
убирает контур. База: коммит `6eecef4`, тег отката `pre-contest-removal` ставится на старте.

Источники: три независимых прохода по репозиторию (граница сущностей, потребности Arena,
пошаговый план), спек-фаза 14 `2026-05-08-phase14-contest-marketplace-workflow-design.md`,
`docs/ecosystem/CONTEST-FUNDING-MODELS.md`.

## 1. Граница: что удаляется, что защищено

**Защищено — не трогать ни в одном шаге:**

| Сущность/файл | Почему |
|---|---|
| `author_earnings`, `payouts`, `author_tier_history` (`schema/earnings.ts`) | начисление автора за **продажу модели**. `settle-charge.sql:129-158` вешает `accrue_author_earnings` на **каждый** вызов gateway; `finalize-earnings-cron.ts` ежедневно переводит в `locked` |
| `api/admin/payouts/**`, `dashboard/earnings`, `dashboard/payouts`, `lib/payouts/tax.ts` | админские выплаты автору |
| `kyc_documents` + `admin/kyc-queue` + `dashboard/kyc` | KYC-гейт для выплат авторам (`payouts.kyc_snapshot`) |
| `models`, `ai_models`, `models-marketplace` | каталог — ядро Aggregator |
| TON (`ton-payments.ts`, `ton-payment-bootstrap.ts`), api-gateway | не связаны |
| `finalize-earnings-cron.ts` | полностью неконкурсный |
| `contestStatusEnum` в `enums.ts` | удалить из кода можно; тип в БД остаётся мёртвым |

Структурного пересечения `prize_awards` и `author_earnings` нет: первая FK-ится на
`contests`/`contest_submissions`, вторая на `users`/`ai_models`. `close-contests-cron` пишет
**только** в `prize_awards`. Это подтверждает спека §3.6 прямым текстом.

**Удаляется:** `contests`, `contest_participants`, `contest_submissions`, `evaluations`,
`evaluator_scripts`, `prize_awards` — 38 файлов, ~4700 строк.

## 2. Данные: переносить нечего (три независимых доказательства)

1. **Sink воркера — заглушка** (`worker/src/index.ts:86`): `// TODO Phase 2: UPDATE evaluations …`.
   Оценки никогда не писались ⇒ `evaluations` и `public_score` пусты ⇒ лидерборд всегда был пуст.
2. **`launch-checklist.md:30`** — чекбокс «First launch-contest prepared» не отмечен.
3. **Найден баг, доказывающий невозможность закрытия конкурса:** `close-contests-cron` делает
   `UPDATE contests SET status = 'closed'`, но значения `'closed'` **нет** в enum
   `contest_status` ни в `enums.ts:97-105`, ни в `0005_contests.sql`. Такой запрос упал бы с
   ошибкой типа. Значит конкурс не доходил до финализации ⇒ призы не начислялись.

**Обязательный pre-flight (read-only, до любого кода):** один запрос на проде —
`count(*)` по шести конкурсным таблицам + `models.derived_from_contest_id` +
`ai_models.contest_id`. Если что-то ненулевое — стоп, перенос данных отдельной задачей.

## 3. Миграции: НЕ делать удаление таблиц

- Применённые `0005_contests.sql` и `0014_contest_marketplace.sql` неприкосновенны.
- `0014:57` добавил `models.derived_from_contest_id uuid REFERENCES contests(id) ON DELETE SET NULL`.
  `DROP TABLE contests` падает на этом FK, то есть удаление таблиц **затрагивает каталог моделей** —
  ровно то, что объявлено нетронутым.
- `migrations/README.md` прямо запрещает `db:push` и автоматическую миграцию до baseline.
- `DROP TABLE` необратим без дампа; код откатывается `git revert` за секунды.

Решение: удалить код, таблицы оставить мёртвыми. Обратимо и безопасно.

## 4. Два пересечения, требующие разделения, а не удаления

**(а) `api/admin/contests/[slug]/publish-submission/route.ts` — мост «конкурс → каталог».**
Он делает `INSERT INTO models (…, author_user_id, derived_from_contest_id, …)`. Продажа моделей
остаётся. Поэтому: саму вставку в `models` **перенести** в конкурсонезависимый admin-роут
(`POST /api/admin/models/from-submission`) без `contest_id`/`final_rank`,
`derived_from_contest_id` = NULL. Публикация из конкурса — забота Arena.

**(б) `HomeFaq.tsx:8,24` и `page.tsx:260`** продают «open contest → submit → auto-eval → 70% автору».
Это маркетинг **авторской экономики**, конкурс — лишь бывший вход. Не вырезать целиком:
переписать на публикацию через `/dashboard/models`.

**(в)** `packages/shared/src/author-manifest.ts:29` — опциональное поле `contestSubmissionId`: удалить.

## 5. Шаги (каждый — отдельный коммит, после каждого репозиторий собирается)

- **Шаг 0. Pre-flight.** Read-only SQL на проде; если непусто — стоп. Тег `pre-contest-removal`.
- **Шаг 1. Worker.** Удалить `contest-eval.ts`, `close-contests-cron.ts`, весь `eval-runner/`;
  из `queues/names.ts` убрать `contestEval`; вычистить `index.ts`; удалить 3 теста;
  **в `ton-worker-entry.test.ts` убрать строки 16 и 19** (моки на удалённые модули).
- **Шаг 2. API.** Удалить 7 роутов: `contests/[slug]/{register,submit,leaderboard}`,
  `admin/contests/{,[slug],[slug]/status}`.
- **Шаг 3. Схема.** Удалить `contests.ts`, `evaluations.ts`, `prize-awards.ts` + 3 реэкспорта
  в `index.ts` + `contestStatusEnum`. `models-marketplace.derivedFromContestId` оставить.
- **Шаг 4. UI.** Удалить 14 файлов `(marketing)/contests/**`, `admin/contests/**`,
  `dashboard/submissions`, `dashboard/wins`, `admin/moderation/submissions`,
  `(legal)/contest-host-agreement`. Переписать `HomeFaq` и `page.tsx:260` на авторскую публикацию.
- **Шаг 5. Навигация и тексты.** `MainNavbar`, `CommandPalette` (включая хардкод-фильтр на строке 129),
  `AdminSidebar`, `DashboardSidebar`, `OnboardingTour`, `sitemap.ts`, `admin/worker/page.tsx`,
  `dashboard/webhooks/page.tsx`, `smoke-shots.mjs`. Режим дашборда `participant` удалить целиком
  (`lib/dashboard/mode.ts`, `roles.ts`, ветка в `overview.ts`).
- **Шаг 6. Мост публикации.** Вынести вставку в `models` из удаляемого роута в
  `POST /api/admin/models/from-submission`; `derived_from_contest_id` = NULL.
- **Шаг 7. Финальная зачистка.** `author-manifest.ts`, редирект `/contests*` → `/marketplace`
  (301), `/admin/contests` → `/admin`. Финальный гейт: `git diff --stat` не должен затронуть
  `earnings`, `payouts`, `kyc`, `models`, `ton-*`, `api-gateway`.
- **Шаг 8. Документация.** Обновить `docs/ecosystem/ECOSYSTEM-START-HERE.md`,
  `FUNCTIONAL-MATRIX.md`, `docs/ARCHITECTURE.md`, `AGENTS.md`, `CLAUDE.md`, `PRODUCT.md`,
  `arena-boundary.md`, `migrations/README.md`; `ops/runbook/contest-lifecycle.md` перенести в Arena.

## 6. Что Arena уже имеет — переносить нечего

Arena покрывает **8 из 12** конкурсных функций, причём 6 **строже** Aggregator:
policy с digest и заморозкой, регистрация с принятой версией политики, команды и инвайты,
immutable версии с тремя хешами, append-only отбор с receipt, модерация.
Реально не хватает трёх вещей: **оценка, лидерборд, призы/выплаты**.

Ничего из AG физически не копируется, кроме двух файлов как образца поведения:
`eval-runner/runner.ts` (157 стр., но `systemd-run` в Arena неуместен — это спецификация
поведения) и логика `close-contests-cron` (но статус `'closed'` там был багом — не переносить).

## 7. Найденный баг (не переносить в Arena)

`close-contests-cron.ts` обновляет `contests.status = 'closed'`, значения нет в enum
`contest_status`. Такой запрос упал бы с ошибкой типа. В Arena своя схема — проверить свои значения.

## 8. Риски и страховка

| Риск | Страховка |
|---|---|
| Потеря данных конкурсов | read-only SQL в шаге 0 **до** кода; непусто ⇒ стоп |
| Ломается каталог моделей | таблицы не трогаем вообще; `derived_from_contest_id` остаётся NULL |
| Убит `ton-worker-entry.test.ts` | чистка строк 16/19 в шаге 1, не позже |
| Провал миграций | миграционные файлы в diff пусты; нативный БД-гейт после шага 3 |
| Сломаны внешние ссылки | редирект 301 в шаге 5 |
| Money-path | `earnings`/`payouts`/`kyc`/`ton-*` не входят ни в один шаг; проверка diff перед merge |
| Пользователь не находит конкурсы | шаг 5: редирект + упоминание Arena в FAQ |

Откат: тег `pre-contest-removal`, каждый шаг отдельный коммит ⇒ точечный `git revert`.
